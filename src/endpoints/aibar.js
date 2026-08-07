import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { publicError } from '../aibar-errors.js';
import { createUserRateLimiter } from '../aibar-rate-limit.js';

export const router = express.Router();

const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const DISCORD_ATTACHMENT_PATH = /^\/attachments\/\d{17,20}\/\d{17,20}\/[^/]+\.(?:png|json|ya?ml|charx|byaf)$/i;
const DISCORD_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
const DISCORD_ATTACHMENT_TIMEOUT_MS = 15_000;
const DISCORD_ATTACHMENT_MAX_REDIRECTS = 3;
const SAVED_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const STORY_ID_MAX_LENGTH = 200;
const STORY_TITLE_MAX_LENGTH = 200;
const STORY_TEXT_MAX_LENGTH = 20_000;
const STORY_MESSAGE_MAX_LENGTH = 50_000;
const STORY_TIMESTAMP_MAX_LENGTH = 64;
const STORY_LIST_MAX_ITEMS = 50;
const STORY_TAG_MAX_LENGTH = 100;
// 列表接口最多返回最近的 200 个故事，超长封面在列表中省略，避免响应体无限膨胀。
const STORY_LIST_MAX_STORIES = 200;
const STORY_LIST_COVER_IMAGE_MAX_LENGTH = 65_536;
const USER_STORY_MAX_COUNT = 500;
const USER_IMAGE_MAX_COUNT = 1000;
// Community MOD ids can reach ~170 characters (source id + import suffix), so keep references intact.
const STORY_REFERENCE_MAX_LENGTH = 200;
// A data URL cover cannot be larger than the saved image budget: base64 overhead + a short "data:...;base64," prefix.
const STORY_COVER_IMAGE_MAX_LENGTH = Math.ceil(SAVED_IMAGE_MAX_BYTES / 3) * 4 + 64;

export class DiscordImportFetchError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

class AibarImageError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export function validateDiscordAttachmentUrl(value) {
    let url;
    try {
        url = new URL(String(value || '').trim());
    } catch {
        throw new DiscordImportFetchError('Invalid Discord attachment URL');
    }

    if (
        url.protocol !== 'https:'
        || url.port
        || url.username
        || url.password
        || !DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())
        || !DISCORD_ATTACHMENT_PATH.test(url.pathname)
    ) {
        throw new DiscordImportFetchError('Only supported Discord CDN attachments can be fetched');
    }
    return url;
}

export async function fetchDiscordAttachment(value) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCORD_ATTACHMENT_TIMEOUT_MS);

    try {
        let url = validateDiscordAttachmentUrl(value);
        let upstream;

        for (let redirects = 0; redirects <= DISCORD_ATTACHMENT_MAX_REDIRECTS; redirects += 1) {
            upstream = await fetch(url, {
                redirect: 'manual',
                signal: controller.signal,
                headers: { Accept: 'application/octet-stream,image/png,application/json,text/yaml' },
            });

            if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
            if (redirects === DISCORD_ATTACHMENT_MAX_REDIRECTS) {
                throw new DiscordImportFetchError('Discord attachment redirected too many times', 502);
            }
            const location = upstream.headers.get('location');
            await upstream.body?.cancel();
            if (!location) throw new DiscordImportFetchError('Discord attachment redirect is invalid', 502);
            url = validateDiscordAttachmentUrl(new URL(location, url).toString());
        }

        if (!upstream?.ok) {
            await upstream?.body?.cancel();
            throw new DiscordImportFetchError(`Discord attachment download failed (HTTP ${upstream?.status || 502})`, 502);
        }

        const declaredSize = Number(upstream.headers.get('content-length') || 0);
        if (Number.isFinite(declaredSize) && declaredSize > DISCORD_ATTACHMENT_MAX_BYTES) {
            await upstream.body?.cancel();
            throw new DiscordImportFetchError('Discord attachment exceeds the 64 MB limit', 413);
        }
        if (!upstream.body) throw new DiscordImportFetchError('Discord attachment response is empty', 502);

        const chunks = [];
        let size = 0;
        for await (const chunk of upstream.body) {
            size += chunk.byteLength;
            if (size > DISCORD_ATTACHMENT_MAX_BYTES) {
                throw new DiscordImportFetchError('Discord attachment exceeds the 64 MB limit', 413);
            }
            chunks.push(Buffer.from(chunk));
        }
        if (!size) throw new DiscordImportFetchError('Discord attachment response is empty', 502);

        return {
            buffer: Buffer.concat(chunks, size),
            contentType: upstream.headers.get('content-type') || 'application/octet-stream',
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new DiscordImportFetchError('Discord attachment download timed out', 504);
        }
        if (error instanceof DiscordImportFetchError) throw error;
        throw new DiscordImportFetchError('Unable to download Discord attachment', 502);
    } finally {
        clearTimeout(timeout);
    }
}

function getStoriesDirectory(request) {
    return path.resolve(request.user.directories.root, 'aibar', 'stories');
}

const discordImportFetchLimiter = createUserRateLimiter({ points: 10, duration: 60, message: 'Discord 附件下载过于频繁，请稍后再试' });
const imageSaveLimiter = createUserRateLimiter({ points: 30, duration: 60, message: '图片保存过于频繁，请稍后再试' });

router.post('/discord-import/fetch', discordImportFetchLimiter, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
        const attachment = await fetchDiscordAttachment(request.body?.url);
        response.set({
            'Content-Type': attachment.contentType,
            'Content-Length': String(attachment.buffer.length),
        });
        return response.send(attachment.buffer);
    } catch (error) {
        const status = error instanceof DiscordImportFetchError ? error.status : 500;
        if (status >= 500) console.warn('Discord attachment fetch failed:', error?.message || error);
        return response.status(status).send(
            error instanceof DiscordImportFetchError ? error.message : publicError(error, 'Discord 附件下载失败'),
        );
    }
});

function getImagesDirectory(request) {
    return path.resolve(request.user.directories.root, 'aibar', 'images');
}

function ensureStoriesDirectory(request) {
    const directory = getStoriesDirectory(request);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function ensureImagesDirectory(request) {
    const directory = getImagesDirectory(request);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function getImageIndexPath(request) {
    return path.join(ensureImagesDirectory(request), 'index.json');
}

function normalizeId(value) {
    const id = sanitize(String(value || '').replace(/\.json$/i, '').trim()).slice(0, STORY_ID_MAX_LENGTH);
    return id || randomUUID();
}

function normalizeImageId(value) {
    const id = sanitize(String(value || '').trim());
    return id || randomUUID();
}

function getStoryPath(request, id) {
    const directory = ensureStoriesDirectory(request);
    const safeId = normalizeId(id);
    const filePath = path.join(directory, `${safeId}.json`);
    if (!filePath.startsWith(`${directory}${path.sep}`)) {
        throw new Error('Invalid story id');
    }
    return { id: safeId, filePath };
}

function stringArray(value, maximumItems = STORY_LIST_MAX_ITEMS, maximumLength = STORY_TAG_MAX_LENGTH) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .slice(0, maximumItems)
        .map(item => String(item || '').trim().slice(0, maximumLength))
        .filter(Boolean);
}

function optionalRawValue(input, existing, key) {
    return Object.prototype.hasOwnProperty.call(input, key) ? input[key] : existing[key];
}

function optionalString(input, existing, key, maximumLength) {
    return String(optionalRawValue(input, existing, key) || '').trim().slice(0, maximumLength);
}

function normalizeCoverImage(input, existing) {
    const value = String(optionalRawValue(input, existing, 'coverImage') || '').trim();
    if (value.length > STORY_COVER_IMAGE_MAX_LENGTH) {
        throw new AibarImageError('Story cover image exceeds the 20 MB limit', 413);
    }
    return value;
}

function normalizeStory(input, existing = {}) {
    const now = new Date().toISOString();
    const title = String(input.title || '').trim().slice(0, STORY_TITLE_MAX_LENGTH);
    const characterAvatar = String(input.characterAvatar || '').trim().slice(0, STORY_REFERENCE_MAX_LENGTH);

    if (!title) {
        throw new Error('Story title is required');
    }
    if (!characterAvatar) {
        throw new Error('Story characterAvatar is required');
    }

    return {
        id: normalizeId(input.id || existing.id),
        version: 1,
        title,
        summary: String(input.summary || '').trim().slice(0, STORY_TEXT_MAX_LENGTH),
        characterAvatar,
        tags: stringArray(input.tags),
        world: String(input.world || '').trim().slice(0, STORY_TEXT_MAX_LENGTH),
        scenario: String(input.scenario || '').trim().slice(0, STORY_TEXT_MAX_LENGTH),
        openingUserMessage: String(input.openingUserMessage || '').trim().slice(0, STORY_MESSAGE_MAX_LENGTH),
        openingAssistantMessage: String(input.openingAssistantMessage || '').trim().slice(0, STORY_MESSAGE_MAX_LENGTH),
        systemAppend: String(input.systemAppend || '').trim().slice(0, STORY_MESSAGE_MAX_LENGTH),
        coverImage: normalizeCoverImage(input, existing),
        coverAssetId: optionalString(input, existing, 'coverAssetId', STORY_ID_MAX_LENGTH),
        modIds: stringArray(input.modIds, STORY_LIST_MAX_ITEMS, STORY_REFERENCE_MAX_LENGTH),
        modelProfileId: String(input.modelProfileId || '').trim().slice(0, STORY_REFERENCE_MAX_LENGTH),
        createdAt: String(existing.createdAt || input.createdAt || now).slice(0, STORY_TIMESTAMP_MAX_LENGTH),
        updatedAt: now,
    };
}

function readStoryFile(filePath, fallbackId = '') {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
        ...parsed,
        id: normalizeId(parsed.id || fallbackId || path.basename(filePath, '.json')),
    };
}

function readImageIndex(request) {
    const filePath = getImageIndexPath(request);
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn('Failed to read AIBAR image index:', error);
        return [];
    }
}

function writeImageIndex(request, images) {
    const filePath = getImageIndexPath(request);
    writeFileSyncAtomic(filePath, JSON.stringify(images, null, 4), 'utf8');
}

function normalizeImageFormat(value, mimeType = '') {
    const raw = String(value || '').toLowerCase().replace(/^\./, '');
    if (['png', 'jpg', 'jpeg', 'webp'].includes(raw)) {
        return raw === 'jpeg' ? 'jpg' : raw;
    }
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    return 'png';
}

function parseImageData(input, format) {
    const raw = String(input || '');
    const match = raw.match(/^data:([^;]+);base64,(.+)$/);
    const mimeType = match?.[1] || '';
    const base64 = (match?.[2] || raw).replace(/\s+/g, '');
    const safeFormat = normalizeImageFormat(format, mimeType);
    const maximumEncodedLength = Math.ceil(SAVED_IMAGE_MAX_BYTES / 3) * 4 + 4;
    if (base64.length > maximumEncodedLength) {
        throw new AibarImageError('Image exceeds the 20 MB limit', 413);
    }
    if (!base64 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
        throw new AibarImageError('Invalid image data');
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
        throw new AibarImageError('Invalid image data');
    }
    if (buffer.length > SAVED_IMAGE_MAX_BYTES) {
        throw new AibarImageError('Image exceeds the 20 MB limit', 413);
    }
    return { buffer, format: safeFormat, mimeType };
}

function getImageFilePath(request, fileName) {
    const directory = ensureImagesDirectory(request);
    const safeFile = sanitize(String(fileName || '').trim());
    const filePath = path.join(directory, safeFile);
    if (!safeFile || !filePath.startsWith(`${directory}${path.sep}`)) {
        throw new Error('Invalid image filename');
    }
    return { safeFile, filePath };
}

router.post('/stories/list', (request, response) => {
    try {
        const directory = ensureStoriesDirectory(request);
        // 只读取最近修改的 200 个故事文件，避免海量故事把响应撑爆。
        const files = fs.readdirSync(directory)
            .filter(file => file.endsWith('.json'))
            .map((file) => {
                try {
                    return { file, mtimeMs: fs.statSync(path.join(directory, file)).mtimeMs };
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, STORY_LIST_MAX_STORIES)
            .map(entry => entry.file);
        const stories = [];

        for (const file of files) {
            try {
                const story = readStoryFile(path.join(directory, file), path.basename(file, '.json'));
                // 超长封面（内联 data URL）不进列表响应，SPA 会自动回退到占位图。
                if (String(story.coverImage || '').length > STORY_LIST_COVER_IMAGE_MAX_LENGTH) {
                    story.coverImage = '';
                }
                stories.push(story);
            } catch (error) {
                console.warn(`Failed to read AIBAR story ${file}:`, error);
            }
        }

        stories.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        return response.send(stories);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/stories/get', (request, response) => {
    try {
        const { id, filePath } = getStoryPath(request, request.body.id);
        if (!fs.existsSync(filePath)) {
            return response.status(404).send('Story not found');
        }
        return response.send(readStoryFile(filePath, id));
    } catch (error) {
        console.error(error);
        return response.status(400).send(publicError(error, '请求处理失败'));
    }
});

router.post('/stories/save', (request, response) => {
    try {
        const incoming = request.body.story || {};
        let existing = {};
        if (incoming.id) {
            const { filePath } = getStoryPath(request, incoming.id);
            if (fs.existsSync(filePath)) {
                existing = readStoryFile(filePath, incoming.id);
            }
        }

        const story = normalizeStory(incoming, existing);
        const { filePath } = getStoryPath(request, story.id);
        // 新建故事时检查每用户上限；更新已有故事始终允许。
        if (!fs.existsSync(filePath)) {
            const directory = ensureStoriesDirectory(request);
            const storyCount = fs.readdirSync(directory).filter(file => file.endsWith('.json')).length;
            if (storyCount >= USER_STORY_MAX_COUNT) {
                return response.status(400).send(`故事数量已达到 ${USER_STORY_MAX_COUNT} 个上限，请先删除旧故事`);
            }
        }
        writeFileSyncAtomic(filePath, JSON.stringify(story, null, 4), 'utf8');
        return response.send(story);
    } catch (error) {
        console.error(error);
        return response.status(error instanceof AibarImageError ? error.status : 400).send(publicError(error, '故事保存失败'));
    }
});

router.post('/stories/delete', (request, response) => {
    try {
        const { filePath } = getStoryPath(request, request.body.id);
        if (!fs.existsSync(filePath)) {
            return response.status(404).send('Story not found');
        }
        fs.unlinkSync(filePath);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.status(400).send(publicError(error, '请求处理失败'));
    }
});

router.post('/images/list', (request, response) => {
    try {
        let images = readImageIndex(request);
        const contextType = String(request.body.contextType || '').trim();
        const contextId = String(request.body.contextId || '').trim();
        if (contextType) {
            images = images.filter(image => image.contextType === contextType);
        }
        if (contextId) {
            images = images.filter(image => image.contextId === contextId);
        }
        images.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        return response.send(images);
    } catch (error) {
        console.error(error);
        return response.status(400).send(publicError(error, '请求处理失败'));
    }
});

router.post('/images/save', imageSaveLimiter, (request, response) => {
    try {
        const { buffer, format } = parseImageData(request.body.image, request.body.format);
        const id = normalizeImageId(request.body.id);
        // 新图片受每用户数量上限约束；覆盖已有编号的图片始终允许。
        const existingImages = readImageIndex(request);
        if (existingImages.length >= USER_IMAGE_MAX_COUNT && !existingImages.some(image => image.id === id)) {
            return response.status(400).send(`图片数量已达到 ${USER_IMAGE_MAX_COUNT} 张上限，请先删除旧图片`);
        }
        const fileName = `${id}.${format}`;
        const { filePath } = getImageFilePath(request, fileName);
        writeFileSyncAtomic(filePath, buffer);

        const now = new Date().toISOString();
        const asset = {
            id,
            fileName,
            url: `/api/aibar/images/file/${encodeURIComponent(fileName)}`,
            format,
            contextType: String(request.body.contextType || '').trim(),
            contextId: String(request.body.contextId || '').trim().slice(0, 240),
            prompt: String(request.body.prompt || '').trim().slice(0, 20_000),
            negativePrompt: String(request.body.negativePrompt || '').trim().slice(0, 20_000),
            provider: String(request.body.provider || '').trim().slice(0, 120),
            model: String(request.body.model || '').trim().slice(0, 240),
            width: Number(request.body.width) || undefined,
            height: Number(request.body.height) || undefined,
            seed: request.body.seed === undefined ? undefined : String(request.body.seed),
            createdAt: now,
        };

        const images = existingImages.filter(image => image.id !== id);
        images.push(asset);
        writeImageIndex(request, images);
        return response.send(asset);
    } catch (error) {
        console.error(error);
        return response.status(error instanceof AibarImageError ? error.status : 400).send(publicError(error, '图片保存失败'));
    }
});

router.post('/images/delete', (request, response) => {
    try {
        const id = String(request.body.id || '').trim();
        const images = readImageIndex(request);
        const asset = images.find(image => image.id === id);
        if (!asset) {
            return response.status(404).send('Image not found');
        }
        const { filePath } = getImageFilePath(request, asset.fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        writeImageIndex(request, images.filter(image => image.id !== id));
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.status(400).send(publicError(error, '请求处理失败'));
    }
});

router.get('/images/file/:fileName', (request, response) => {
    try {
        const { safeFile, filePath } = getImageFilePath(request, request.params.fileName);
        if (!fs.existsSync(filePath)) {
            return response.sendStatus(404);
        }
        const ext = path.extname(safeFile).toLowerCase();
        const mimeType = ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
        response.type(mimeType);
        return response.sendFile(filePath);
    } catch (error) {
        console.error(error);
        return response.status(400).send(publicError(error, '请求处理失败'));
    }
});
