import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

export const router = express.Router();

function getStoriesDirectory(request) {
    return path.resolve(request.user.directories.root, 'aibar', 'stories');
}

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
    const id = sanitize(String(value || '').replace(/\.json$/i, '').trim());
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

function stringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(item => String(item || '').trim()).filter(Boolean);
}

function optionalString(input, existing, key) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
        return String(input[key] || '').trim();
    }
    return String(existing[key] || '').trim();
}

function normalizeStory(input, existing = {}) {
    const now = new Date().toISOString();
    const title = String(input.title || '').trim();
    const characterAvatar = String(input.characterAvatar || '').trim();

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
        summary: String(input.summary || '').trim(),
        characterAvatar,
        tags: stringArray(input.tags),
        world: String(input.world || '').trim(),
        scenario: String(input.scenario || '').trim(),
        openingUserMessage: String(input.openingUserMessage || '').trim(),
        openingAssistantMessage: String(input.openingAssistantMessage || '').trim(),
        systemAppend: String(input.systemAppend || '').trim(),
        coverImage: optionalString(input, existing, 'coverImage'),
        coverAssetId: optionalString(input, existing, 'coverAssetId'),
        modIds: stringArray(input.modIds),
        modelProfileId: String(input.modelProfileId || '').trim(),
        createdAt: String(existing.createdAt || input.createdAt || now),
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
    const base64 = match?.[2] || raw;
    const safeFormat = normalizeImageFormat(format, mimeType);
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
        throw new Error('Invalid image data');
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
        const files = fs.readdirSync(directory)
            .filter(file => file.endsWith('.json'))
            .sort();
        const stories = [];

        for (const file of files) {
            try {
                stories.push(readStoryFile(path.join(directory, file), path.basename(file, '.json')));
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
        return response.status(400).send(String(error.message || error));
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
        writeFileSyncAtomic(filePath, JSON.stringify(story, null, 4), 'utf8');
        return response.send(story);
    } catch (error) {
        console.error(error);
        return response.status(400).send(String(error.message || error));
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
        return response.status(400).send(String(error.message || error));
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
        return response.status(400).send(String(error.message || error));
    }
});

router.post('/images/save', (request, response) => {
    try {
        const { buffer, format } = parseImageData(request.body.image, request.body.format);
        const id = normalizeImageId(request.body.id);
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
            contextId: String(request.body.contextId || '').trim(),
            prompt: String(request.body.prompt || '').trim(),
            negativePrompt: String(request.body.negativePrompt || '').trim(),
            provider: String(request.body.provider || '').trim(),
            model: String(request.body.model || '').trim(),
            width: Number(request.body.width) || undefined,
            height: Number(request.body.height) || undefined,
            seed: request.body.seed === undefined ? undefined : String(request.body.seed),
            createdAt: now,
        };

        const images = readImageIndex(request).filter(image => image.id !== id);
        images.push(asset);
        writeImageIndex(request, images);
        return response.send(asset);
    } catch (error) {
        console.error(error);
        return response.status(400).send(String(error.message || error));
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
        return response.status(400).send(String(error.message || error));
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
        return response.status(400).send(String(error.message || error));
    }
});
