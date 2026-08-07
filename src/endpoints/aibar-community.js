import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import storage from 'node-persist';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { publicError } from '../aibar-errors.js';
import { createUserRateLimiter } from '../aibar-rate-limit.js';
import { getCommunityDb, getCommunityRoot, hashInviteCode } from '../aibar-community-db.js';
import {
    finalizeRegistrationAccount,
    grantInitialPoints,
    provisionRegistrationAccount,
    rollbackRegistrationAccount,
} from '../aibar-registration.js';
import {
    KEY_PREFIX,
    requireAdminMiddleware,
} from '../users.js';
import { readCharacterData } from './characters.js';
import { generateThumbnail } from './thumbnails.js';
import {
    ensureCommunityCoverPreview,
    removeCommunityCoverPreviews,
} from '../aibar-community-previews.js';
import {
    DiscordImportFetchError,
    fetchDiscordAttachment,
    validateDiscordAttachmentUrl,
} from './aibar.js';

export const router = express.Router();

const publishRateLimiter = createUserRateLimiter({ points: 12, duration: 60, message: '发布操作过于频繁，请稍后再试' });
const launchRateLimiter = createUserRateLimiter({ points: 12, duration: 60, message: '启动操作过于频繁，请稍后再试' });
const commentRateLimiter = createUserRateLimiter({ points: 20, duration: 60, message: '评论发送过于频繁，请稍后再试' });

const MAX_PAGE_SIZE = 48;
const WORK_VERSIONS_MAX_ITEMS = 50;
const IMMUTABLE_COVER_CACHE_CONTROL = 'private, max-age=31536000, immutable';
const MAX_TAGS = 8;
const MAX_MOD_SNAPSHOT_BYTES = 64 * 1024;
const MOD_POSITIONS = new Set(['system_prepend', 'system_append', 'user_suffix']);
const APPROVAL_CLAIM_PREFIX = 'claim:';
const APPROVAL_CLAIM_TTL_MS = 10 * 60 * 1000;
const DISCORD_IMPORT_GUILD_ID = '1380075940285124724';
const DISCORD_IMPORT_CHANNEL_ID = '1478612237869519021';
const DISCORD_PUBLIC_CHANNEL_IDS = new Set([
    '1478601254312874024',
    '1478601664838766723',
    DISCORD_IMPORT_CHANNEL_ID,
]);
const DISCORD_IMPORT_TIMEZONE = 'Asia/Shanghai';
const DISCORD_IMPORT_MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const DISCORD_IMPORT_MAX_CARDS = 200;
const DISCORD_IMPORT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DISCORD_SNOWFLAKE_PATTERN = /^[1-9]\d{16,19}$/;
const DISCORD_IMPORTABLE_EXTENSIONS = new Set(['.png', '.json', '.yaml', '.yml', '.charx', '.byaf']);

function nowIso() {
    return new Date().toISOString();
}

function stringArray(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(item => String(item || '').trim().slice(0, 32)).filter(Boolean))].slice(0, MAX_TAGS);
}

function safeJson(value, fallback = {}) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function discordImportText(value, label, maxLength, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
    const text = value.trim();
    if (!allowEmpty && !text) throw new Error(`${label} 不能为空`);
    if (text.length > maxLength) throw new Error(`${label} 过长`);
    if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
        throw new Error(`${label} 包含控制字符`);
    }
    return text;
}

function discordImportTags(value, label, maxItems) {
    if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} 无效`);
    const tags = value.map((tag, index) => discordImportText(tag, `${label}[${index}]`, 48));
    const normalized = tags.map(tag => tag.toLocaleLowerCase('en-US'));
    if (new Set(normalized).size !== tags.length) throw new Error(`${label} 不能重复`);
    return tags;
}

function discordSnowflake(value, label) {
    const id = discordImportText(value, label, 20);
    if (!DISCORD_SNOWFLAKE_PATTERN.test(id)) throw new Error(`${label} 不是有效的 Discord ID`);
    return id;
}

function validateDiscordThreadUrl(value, threadId, cardId) {
    const sourceUrl = discordImportText(value, 'sourceUrl', 2048);
    let url;
    try {
        url = new URL(sourceUrl);
    } catch {
        throw new Error('sourceUrl 无效');
    }
    if (
        url.protocol !== 'https:'
        || url.hostname.toLowerCase() !== 'discord.com'
        || url.port
        || url.username
        || url.password
        || url.search
        || url.hash
    ) throw new Error('sourceUrl 必须是安全的 Discord 帖子地址');

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 3 && segments.length !== 4) throw new Error('sourceUrl 路径无效');
    if (segments[0] !== 'channels' || segments[1] !== DISCORD_IMPORT_GUILD_ID) {
        throw new Error('sourceUrl 不属于允许的 Discord 服务器');
    }
    const channelRef = segments[2];
    const messageRef = segments[3];
    const matchesThread = channelRef === threadId || messageRef === threadId || messageRef === cardId;
    if (!matchesThread || (channelRef !== threadId && channelRef !== DISCORD_IMPORT_CHANNEL_ID)) {
        throw new Error('sourceUrl 与角色卡帖子不匹配');
    }
    return sourceUrl;
}

function normalizeDiscordPublicSource(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CommunityPublishError('Discord 来源信息无效');
    }
    const allowedKeys = new Set([
        'guildId', 'channelId', 'threadId', 'cardId', 'sourceUrl', 'title', 'authorName', 'tags',
    ]);
    const unsupported = Object.keys(value).find(key => !allowedKeys.has(key));
    if (unsupported) throw new CommunityPublishError(`Discord 来源字段无效：${unsupported}`);

    const guildId = discordSnowflake(value.guildId, 'guildId');
    const channelId = discordSnowflake(value.channelId, 'channelId');
    const threadId = discordSnowflake(value.threadId, 'threadId');
    const cardId = discordSnowflake(value.cardId, 'cardId');
    if (guildId !== DISCORD_IMPORT_GUILD_ID || !DISCORD_PUBLIC_CHANNEL_IDS.has(channelId)) {
        throw new CommunityPublishError('Discord 来源不在允许范围内');
    }

    const sourceUrl = discordImportText(value.sourceUrl, 'sourceUrl', 2048);
    let parsed;
    try {
        parsed = new URL(sourceUrl);
    } catch {
        throw new CommunityPublishError('sourceUrl 无效');
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    const channelRef = segments[2];
    const messageRef = segments[3];
    const matchesThread = channelRef === threadId || messageRef === threadId || messageRef === cardId;
    if (
        parsed.protocol !== 'https:'
        || parsed.hostname.toLowerCase() !== 'discord.com'
        || parsed.port
        || parsed.username
        || parsed.password
        || parsed.search
        || parsed.hash
        || (segments.length !== 3 && segments.length !== 4)
        || segments[0] !== 'channels'
        || segments[1] !== guildId
        || !matchesThread
        || (channelRef !== threadId && channelRef !== channelId)
    ) throw new CommunityPublishError('sourceUrl 与 Discord 来源帖子不匹配');

    return {
        guildId,
        channelId,
        threadId,
        cardId,
        sourceUrl,
        title: discordImportText(value.title, 'title', 120),
        authorName: discordImportText(value.authorName || '', 'authorName', 120, { allowEmpty: true }),
        tags: discordImportTags(value.tags || [], 'tags', 16),
    };
}

function normalizeDiscordImportManifest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Discord 清单必须是对象');
    const manifestBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (manifestBytes > DISCORD_IMPORT_MAX_MANIFEST_BYTES) throw new Error('Discord 清单不能超过 2 MB');
    if (value.version !== 1) throw new Error('只支持 Discord 清单版本 1');
    if (value.guildId !== DISCORD_IMPORT_GUILD_ID || value.channelId !== DISCORD_IMPORT_CHANNEL_ID) {
        throw new Error('Discord 清单来源不在允许范围内');
    }
    if (value.timezone !== DISCORD_IMPORT_TIMEZONE) throw new Error('Discord 清单时区无效');
    if (!['today', 'previous-day', 'rolling-24h'].includes(value.period)) throw new Error('Discord 清单周期无效');
    if (!['reactions', 'activity'].includes(value.sort)) throw new Error('Discord 清单排序无效');
    const rawFilters = value.filters === undefined ? { tags: [], tagMatch: 'any' } : value.filters;
    if (!rawFilters || typeof rawFilters !== 'object' || Array.isArray(rawFilters)) {
        throw new Error('Discord 清单筛选条件无效');
    }
    const filterTags = discordImportTags(rawFilters.tags, 'Discord 清单筛选标签', 64);
    if (!['any', 'all'].includes(rawFilters.tagMatch)) throw new Error('Discord 清单标签匹配方式无效');
    const syncedAt = discordImportText(value.syncedAt, 'syncedAt', 40);
    if (!Number.isFinite(Date.parse(syncedAt))) throw new Error('syncedAt 不是有效时间');
    if (!Array.isArray(value.cards) || value.cards.length > DISCORD_IMPORT_MAX_CARDS) {
        throw new Error(`Discord 清单最多包含 ${DISCORD_IMPORT_MAX_CARDS} 项`);
    }

    const seen = new Set();
    const cards = value.cards.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`cards[${index}] 无效`);
        const cardId = discordSnowflake(raw.id, `cards[${index}].id`);
        const threadId = discordSnowflake(raw.threadId, `cards[${index}].threadId`);
        if (seen.has(cardId)) throw new Error(`cards[${index}].id 重复`);
        seen.add(cardId);
        const resource = raw.resource && typeof raw.resource === 'object' && !Array.isArray(raw.resource)
            ? raw.resource
            : {};
        const resourceKind = resource.kind === 'web-app' ? 'web-app' : 'character-card';
        const availability = ['ready', 'browser', 'unsupported'].includes(resource.availability)
            ? resource.availability
            : 'unsupported';
        const tags = discordImportTags(raw.tags, `cards[${index}].tags`, 16);
        return {
            cardId,
            threadId,
            title: discordImportText(raw.title, `cards[${index}].title`, 200),
            sourceAuthorName: discordImportText(raw.authorName || '', `cards[${index}].authorName`, 120, { allowEmpty: true }),
            sourceUrl: validateDiscordThreadUrl(raw.sourceUrl, threadId, cardId),
            resourceKind,
            availability,
            metadata: {
                tags,
                publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt.slice(0, 40) : '',
                lastActiveAt: typeof raw.lastActiveAt === 'string' ? raw.lastActiveAt.slice(0, 40) : '',
                reactionCount: Math.max(0, Number(raw.reactionCount) || 0),
                replyCount: Math.max(0, Number(raw.replyCount) || 0),
                resource,
            },
        };
    });
    const normalizedFilterTags = filterTags.map(tag => tag.toLocaleLowerCase('en-US'));
    cards.forEach((card, index) => {
        if (!normalizedFilterTags.length) return;
        const cardTags = new Set(card.metadata.tags.map(tag => tag.toLocaleLowerCase('en-US')));
        const matches = rawFilters.tagMatch === 'all'
            ? normalizedFilterTags.every(tag => cardTags.has(tag))
            : normalizedFilterTags.some(tag => cardTags.has(tag));
        if (!matches) throw new Error(`cards[${index}].tags 不符合 Discord 清单筛选条件`);
    });
    return {
        manifest: {
            ...value,
            filters: { tags: filterTags, tagMatch: rawFilters.tagMatch },
        },
        cards,
        channelName: discordImportText(value.channelName || '', 'channelName', 120, { allowEmpty: true }),
        syncedAt: new Date(syncedAt).toISOString(),
    };
}

function discordImportItemJson(row) {
    return {
        id: row.id,
        cardId: row.card_id,
        threadId: row.thread_id,
        status: row.status,
        fileName: row.file_name || '',
        fileSha256: row.file_sha256 || '',
        error: row.error_message || '',
        workId: row.work_id || '',
        workVersionId: row.work_version_id || '',
        updatedAt: row.updated_at,
    };
}

function discordImportBatchJson(db, row) {
    const items = db.prepare('SELECT * FROM discord_import_items WHERE batch_id = ? ORDER BY created_at, card_id').all(row.id);
    return {
        id: row.id,
        status: row.status,
        manifest: safeJson(row.manifest_json, null),
        items: items.map(discordImportItemJson),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function getOwnedDiscordImportItem(db, itemId, handle) {
    return db.prepare(`
        SELECT item.* FROM discord_import_items item
        JOIN discord_import_batches batch ON batch.id = item.batch_id
        WHERE item.id = ? AND batch.requested_by = ?
    `).get(itemId, handle);
}

function refreshDiscordImportBatchStatus(db, batchId, timestamp = nowIso()) {
    const pending = db.prepare(`
        SELECT COUNT(*) AS count FROM discord_import_items
        WHERE batch_id = ? AND status IN ('queued', 'downloading', 'validated')
    `).get(batchId).count;
    db.prepare('UPDATE discord_import_batches SET status = ?, updated_at = ? WHERE id = ?')
        .run(pending ? 'active' : 'completed', timestamp, batchId);
}

function storeDiscordImportAsset(buffer, fileName) {
    const extension = path.extname(fileName).toLowerCase();
    if (!DISCORD_IMPORTABLE_EXTENSIONS.has(extension)) throw new Error('Discord 文件类型不受支持');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const root = getCommunityRoot();
    const directory = path.join(root, 'imports', 'discord', 'sha256', sha256.slice(0, 2));
    const assetPath = path.join(directory, `${sha256}${extension}`);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(assetPath)) {
        writeFileSyncAtomic(assetPath, buffer);
        fs.chmodSync(assetPath, 0o444);
    }
    return { sha256, relativePath: path.relative(root, assetPath) };
}

function readUserSettings(request) {
    const settingsPath = path.join(request.user.directories.root, 'settings.json');
    const settings = fs.existsSync(settingsPath) ? safeJson(fs.readFileSync(settingsPath, 'utf8'), {}) : {};
    return {
        settingsPath,
        settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
    };
}

function createRollbackJournal() {
    const capturedFiles = new Set();
    const capturedDirectories = new Set();
    const operations = [];
    return {
        captureFile(filePath) {
            const resolved = path.resolve(filePath);
            if (capturedFiles.has(resolved)) return;
            capturedFiles.add(resolved);
            const original = fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
            operations.push(() => {
                if (original === null) {
                    fs.rmSync(resolved, { force: true });
                    return;
                }
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                writeFileSyncAtomic(resolved, original);
            });
        },
        captureDirectory(directoryPath) {
            const resolved = path.resolve(directoryPath);
            if (capturedDirectories.has(resolved) || fs.existsSync(resolved)) return;
            capturedDirectories.add(resolved);
            operations.push(() => fs.rmSync(resolved, { recursive: true, force: true }));
        },
        commit() {
            operations.length = 0;
        },
        rollback() {
            const errors = [];
            for (const operation of operations.reverse()) {
                try {
                    operation();
                } catch (error) {
                    errors.push(error);
                }
            }
            operations.length = 0;
            if (errors.length) throw new Error('Failed to roll back community launch files', { cause: errors[0] });
        },
    };
}

function normalizeModSnapshot(value, { rejectBuiltin = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('提示词 MOD 数据无效');
    }
    if (rejectBuiltin && value.builtin) {
        throw new Error('内置提示词 MOD 不能发布到社区');
    }

    const id = String(value.id || '').trim().slice(0, 160);
    const name = String(value.name || '').trim().slice(0, 120);
    const description = String(value.description || '').trim().slice(0, 1200);
    const content = String(value.content || '');
    const position = String(value.position || '');
    if (!id) throw new Error('提示词 MOD 缺少编号');
    if (!content.trim()) throw new Error('空提示词 MOD 不能发布到社区');
    if (!MOD_POSITIONS.has(position)) throw new Error('提示词 MOD 注入位置无效');

    const mod = { id, name: name || '未命名提示词', description, content, position };
    if (Buffer.byteLength(JSON.stringify(mod), 'utf8') > MAX_MOD_SNAPSHOT_BYTES) {
        throw new Error('提示词 MOD 不能超过 64 KB');
    }
    return mod;
}

function requestedStoryModIds(story) {
    if (story?.modIds === undefined) return [];
    if (!Array.isArray(story.modIds)) throw new Error('故事的提示词 MOD 依赖列表无效');
    return story.modIds.map((value) => {
        if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
            throw new Error('故事包含无效的提示词 MOD 编号');
        }
        return value;
    });
}

export function resolveStoryModDependencies(story, availableMods) {
    const requestedIds = [...new Set(requestedStoryModIds(story))];
    if (!requestedIds.length) return [];
    if (!Array.isArray(availableMods)) throw new Error('故事缺少提示词 MOD 依赖');

    return requestedIds.map((id) => {
        const source = availableMods.find(mod => String(mod?.id || '') === id);
        if (!source) throw new Error(`故事引用的提示词 MOD 不存在：${id.slice(0, 80)}`);
        const snapshot = normalizeModSnapshot(source);
        if (snapshot.id !== id) throw new Error(`故事引用的提示词 MOD 编号无效：${id.slice(0, 80)}`);
        return snapshot;
    });
}

function requestedStoryWorldName(story) {
    if (story?.world === undefined || story.world === null || story.world === '') return '';
    if (typeof story.world !== 'string' || !story.world.trim() || story.world !== story.world.trim()) {
        throw new Error('故事包含无效的世界书名称');
    }
    return story.world;
}

function resolveStoryWorldDependency(story, dependencies) {
    const worldName = requestedStoryWorldName(story);
    if (!worldName) return null;

    const world = dependencies?.world;
    if (!world || world.name !== worldName || !world.data || typeof world.data !== 'object' || Array.isArray(world.data)) {
        throw new Error(`故事缺少有效的世界书依赖：${worldName.slice(0, 80)}`);
    }
    return { name: worldName, data: world.data };
}

function installMods(request, sourceMods, { skipInvalid = false, reuseAnyState = false, journal = null } = {}) {
    const importedIds = new Map();
    const installedMods = [];
    if (!Array.isArray(sourceMods) || !sourceMods.length) return { importedIds, installedMods };

    const { settingsPath, settings } = readUserSettings(request);
    settings.aibar = settings.aibar && typeof settings.aibar === 'object' && !Array.isArray(settings.aibar)
        ? settings.aibar
        : {};
    const existing = Array.isArray(settings.aibar.simple_ui_mods) ? settings.aibar.simple_ui_mods : [];
    let changed = false;

    for (const rawMod of sourceMods) {
        let sourceMod;
        try {
            sourceMod = normalizeModSnapshot(rawMod);
        } catch (error) {
            if (skipInvalid) {
                console.warn('AIBAR skipped invalid story MOD dependency:', error.message);
                continue;
            }
            throw error;
        }

        const reusable = existing.find(mod => (
            (reuseAnyState || (!mod.builtin && mod.enabled === false))
            && mod.content === sourceMod.content
            && mod.position === sourceMod.position
        ));
        if (reusable) {
            importedIds.set(sourceMod.id, reusable.id);
            installedMods.push({
                ...normalizeModSnapshot(reusable),
                enabled: reusable.enabled === true,
                builtin: reusable.builtin === true,
            });
            continue;
        }

        let importedId = sourceMod.id;
        while (existing.some(mod => mod.id === importedId)) {
            importedId = `${sourceMod.id}-${crypto.randomUUID().slice(0, 8)}`;
        }
        const installed = { ...sourceMod, id: importedId, enabled: false, builtin: false };
        existing.push(installed);
        importedIds.set(sourceMod.id, importedId);
        installedMods.push(installed);
        changed = true;
    }

    if (changed) {
        settings.aibar.simple_ui_mods = existing;
        journal?.captureFile(settingsPath);
        writeFileSyncAtomic(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
    }
    return { importedIds, installedMods };
}

function assertPrivateFile(directory, fileName, extension = '') {
    const safeName = sanitize(String(fileName || '').trim());
    if (!safeName || safeName !== fileName || (extension && !safeName.toLowerCase().endsWith(extension))) {
        throw new Error('Invalid private file name');
    }
    const filePath = path.join(directory, safeName);
    if (!filePath.startsWith(`${directory}${path.sep}`) || !fs.existsSync(filePath)) {
        throw new Error('Private source not found');
    }
    return filePath;
}

function uniqueName(directory, preferred, extension) {
    const raw = sanitize(String(preferred || '').trim());
    const base = (raw.toLowerCase().endsWith(extension.toLowerCase()) ? raw.slice(0, -extension.length) : raw) || 'community-work';
    let candidate = base;
    let index = 2;
    while (fs.existsSync(path.join(directory, `${candidate}${extension}`))) {
        candidate = `${base}-${index}`;
        index += 1;
    }
    return candidate;
}

function captureStoryDependencies(request, story) {
    const dependencies = { mods: [] };
    const worldName = requestedStoryWorldName(story);
    if (worldName) {
        let worldPath;
        try {
            worldPath = assertPrivateFile(request.user.directories.worlds, `${worldName}.json`, '.json');
        } catch (error) {
            throw new Error(`故事引用的世界书不存在：${worldName.slice(0, 80)}`, { cause: error });
        }
        const data = safeJson(fs.readFileSync(worldPath, 'utf8'), null);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error(`故事引用的世界书 JSON 无效：${worldName.slice(0, 80)}`);
        }
        dependencies.world = { name: worldName, data };
    }

    const requestedModIds = requestedStoryModIds(story);
    if (requestedModIds.length) {
        const { settings } = readUserSettings(request);
        const mods = Array.isArray(settings.aibar?.simple_ui_mods) ? settings.aibar.simple_ui_mods : [];
        dependencies.mods = resolveStoryModDependencies(story, mods);
    }
    return dependencies;
}

function installStoryDependencies(request, dependencies, story, journal = null) {
    const sourceMods = resolveStoryModDependencies(story, dependencies?.mods);
    const worldDependency = resolveStoryWorldDependency(story, dependencies);
    let world = '';
    if (worldDependency) {
        journal?.captureDirectory(request.user.directories.worlds);
        fs.mkdirSync(request.user.directories.worlds, { recursive: true });
        const worldName = uniqueName(request.user.directories.worlds, worldDependency.name, '.json');
        journal?.captureFile(path.join(request.user.directories.worlds, `${worldName}.json`));
        writeFileSyncAtomic(
            path.join(request.user.directories.worlds, `${worldName}.json`),
            JSON.stringify(worldDependency.data, null, 4),
            'utf8',
        );
        world = worldName;
    }

    const { importedIds, installedMods } = installMods(request, sourceMods, { reuseAnyState: true, journal });

    return {
        world,
        modIds: requestedStoryModIds(story).map((id) => {
            const importedId = importedIds.get(id);
            if (!importedId) throw new Error(`故事缺少提示词 MOD 依赖：${id.slice(0, 80)}`);
            return importedId;
        }),
        installedMods,
    };
}

function copyStoryCover(request, version, storyId, journal = null) {
    if (version.cover_path === version.asset_path) return { coverImage: '', coverAssetId: '' };

    const sourcePath = resolveCommunityAsset(version.cover_path);
    const imageDirectory = path.resolve(request.user.directories.root, 'aibar', 'images');
    journal?.captureDirectory(imageDirectory);
    fs.mkdirSync(imageDirectory, { recursive: true });
    const id = crypto.randomUUID();
    const extension = path.extname(sourcePath).toLowerCase() || '.png';
    const fileName = `${id}${extension}`;
    journal?.captureFile(path.join(imageDirectory, fileName));
    fs.copyFileSync(sourcePath, path.join(imageDirectory, fileName));

    const indexPath = path.join(imageDirectory, 'index.json');
    journal?.captureFile(indexPath);
    const index = fs.existsSync(indexPath) ? safeJson(fs.readFileSync(indexPath, 'utf8'), []) : [];
    const images = Array.isArray(index) ? index : [];
    images.push({
        id,
        fileName,
        url: `/api/aibar/images/file/${encodeURIComponent(fileName)}`,
        format: extension.replace('.', ''),
        contextType: 'story',
        contextId: storyId,
        provider: 'community',
        createdAt: nowIso(),
    });
    writeFileSyncAtomic(indexPath, JSON.stringify(images, null, 4), 'utf8');
    return { coverImage: `/api/aibar/images/file/${encodeURIComponent(fileName)}`, coverAssetId: id };
}

function versionAssetUrl(versionId, kind) {
    return `/api/aibar/works/version/${encodeURIComponent(versionId)}/${kind}`;
}

function workStats(row, userHandle, isAdmin = false, enrichment = null) {
    const db = getCommunityDb();
    const tags = enrichment?.tagsByVersion.get(row.latest_version_id)
        || db.prepare('SELECT tag FROM work_tags WHERE version_id = ? ORDER BY tag').all(row.latest_version_id).map(item => item.tag);
    const userState = enrichment?.userStateByWork.get(row.id);
    const favorite = userState
        ? Boolean(userState.favorite)
        : !!db.prepare('SELECT 1 FROM favorites WHERE user_handle = ? AND work_id = ?').get(userHandle, row.id);
    const myRating = userState
        ? Number(userState.my_rating || 0)
        : db.prepare('SELECT score FROM ratings WHERE user_handle = ? AND work_id = ?').get(userHandle, row.id)?.score || 0;
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        summary: row.summary,
        authorHandle: row.author_handle,
        authorName: row.author_name,
        latestVersionId: row.latest_version_id,
        versionNumber: Number(row.version_number || 1),
        versionNote: row.version_note || '',
        tags,
        coverUrl: row.type === 'mod' ? '' : versionAssetUrl(row.latest_version_id, 'cover'),
        favorite,
        myRating,
        favoriteCount: Number(row.favorite_count || 0),
        ratingAverage: Number(row.rating_average || 0),
        ratingCount: Number(row.rating_count || 0),
        commentCount: Number(row.comment_count || 0),
        launchCount: Number(row.launch_count || 0),
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
        status: row.status,
        canManage: Boolean(isAdmin || row.author_handle === userHandle),
    };
}

function getWorkListEnrichment(rows, userHandle) {
    const tagsByVersion = new Map();
    const userStateByWork = new Map();
    if (!rows.length) return { tagsByVersion, userStateByWork };

    const versionIds = [...new Set(rows.map(row => row.latest_version_id))];
    for (const versionId of versionIds) tagsByVersion.set(versionId, []);
    const versionPlaceholders = versionIds.map(() => '?').join(', ');
    for (const row of getCommunityDb().prepare(`
        SELECT version_id, tag FROM work_tags
        WHERE version_id IN (${versionPlaceholders})
        ORDER BY tag
    `).all(...versionIds)) {
        const tags = tagsByVersion.get(row.version_id) || [];
        tags.push(row.tag);
        tagsByVersion.set(row.version_id, tags);
    }

    const workIds = [...new Set(rows.map(row => row.id))];
    const workPlaceholders = workIds.map(() => '?').join(', ');
    for (const row of getCommunityDb().prepare(`
        SELECT w.id,
            CASE WHEN f.work_id IS NULL THEN 0 ELSE 1 END AS favorite,
            COALESCE(r.score, 0) AS my_rating
        FROM works w
        LEFT JOIN favorites f ON f.work_id = w.id AND f.user_handle = ?
        LEFT JOIN ratings r ON r.work_id = w.id AND r.user_handle = ?
        WHERE w.id IN (${workPlaceholders})
    `).all(userHandle, userHandle, ...workIds)) {
        userStateByWork.set(row.id, row);
    }
    return { tagsByVersion, userStateByWork };
}

const workSelect = `
    SELECT w.*, v.version_number, v.version_note,
      COALESCE(f.favorite_count, 0) AS favorite_count,
      COALESCE(r.rating_average, 0) AS rating_average,
      COALESCE(r.rating_count, 0) AS rating_count,
      COALESCE(c.comment_count, 0) AS comment_count,
      COALESCE(l.launch_count, 0) AS launch_count
    FROM works w
    JOIN work_versions v ON v.id = w.latest_version_id
    LEFT JOIN (
      SELECT work_id, COUNT(*) AS favorite_count FROM favorites GROUP BY work_id
    ) f ON f.work_id = w.id
    LEFT JOIN (
      SELECT work_id, AVG(score) AS rating_average, COUNT(*) AS rating_count FROM ratings GROUP BY work_id
    ) r ON r.work_id = w.id
    LEFT JOIN (
      SELECT work_id, COUNT(*) AS comment_count FROM comments WHERE status = 'visible' GROUP BY work_id
    ) c ON c.work_id = w.id
    LEFT JOIN (
      SELECT work_id, COUNT(*) AS launch_count FROM launch_events GROUP BY work_id
    ) l ON l.work_id = w.id
`;

function getWorkRow(workId) {
    return getCommunityDb().prepare(`${workSelect} WHERE w.id = ? AND w.status = 'published'`).get(workId);
}

function getManagedWorkRow(workId, request) {
    const row = getCommunityDb().prepare(`${workSelect} WHERE w.id = ?`).get(workId);
    if (!row) return null;
    if (row.status === 'published') return row;
    if (request.user.profile.admin || row.author_handle === request.user.profile.handle) return row;
    return null;
}

function removeWorkAssets(workId) {
    const root = path.join(getCommunityRoot(), 'works');
    const directory = path.resolve(root, String(workId || ''));
    if (!directory.startsWith(`${root}${path.sep}`) || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { recursive: true })) {
        const target = path.join(directory, String(entry));
        try {
            if (fs.statSync(target).isDirectory()) fs.chmodSync(target, 0o755);
        } catch {
            // A concurrent cleanup may already have removed the entry.
        }
    }
    fs.chmodSync(directory, 0o755);
    fs.rmSync(directory, { recursive: true, force: true });
}

function resolveCommunityAsset(relativePath) {
    const root = getCommunityRoot();
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved)) {
        throw new Error('Community asset not found');
    }
    return resolved;
}

async function capturePrivateSource(request, sourceType, sourceId) {
    if (sourceType === 'character') {
        const sourcePath = assertPrivateFile(request.user.directories.characters, sourceId, '.png');
        const raw = await readCharacterData(sourcePath);
        if (!raw) throw new Error('Failed to read character card');
        const character = safeJson(raw, null);
        if (!character) throw new Error('Invalid character card');
        const data = character.data || character;
        return {
            characterPath: sourcePath,
            coverPath: sourcePath,
            payload: { sourceType, character },
            defaults: {
                title: data.name || character.name || path.basename(sourceId, '.png'),
                summary: data.description || character.description || '',
                tags: data.tags || character.tags || [],
            },
        };
    }

    if (sourceType === 'story') {
        const storiesDirectory = path.resolve(request.user.directories.root, 'aibar', 'stories');
        const storyPath = assertPrivateFile(storiesDirectory, `${String(sourceId || '').replace(/\.json$/i, '')}.json`, '.json');
        const story = safeJson(fs.readFileSync(storyPath, 'utf8'), null);
        if (!story) throw new Error('Invalid story');
        const characterPath = assertPrivateFile(request.user.directories.characters, story.characterAvatar, '.png');
        const characterRaw = await readCharacterData(characterPath);
        const character = safeJson(characterRaw, null);
        if (!character) throw new Error('Story character is invalid');

        let coverPath = characterPath;
        if (story.coverAssetId) {
            const imageDirectory = path.resolve(request.user.directories.root, 'aibar', 'images');
            const indexPath = path.join(imageDirectory, 'index.json');
            const index = fs.existsSync(indexPath) ? safeJson(fs.readFileSync(indexPath, 'utf8'), []) : [];
            const cover = Array.isArray(index) ? index.find(item => item.id === story.coverAssetId) : null;
            if (cover?.fileName) {
                try {
                    coverPath = assertPrivateFile(imageDirectory, cover.fileName);
                } catch {
                    coverPath = characterPath;
                }
            }
        }

        return {
            characterPath,
            coverPath,
            payload: { sourceType, story, character, dependencies: captureStoryDependencies(request, story) },
            defaults: {
                title: story.title,
                summary: story.summary || story.scenario || '',
                tags: story.tags || [],
            },
        };
    }

    if (sourceType === 'mod') {
        const { settings } = readUserSettings(request);
        const mods = Array.isArray(settings.aibar?.simple_ui_mods) ? settings.aibar.simple_ui_mods : [];
        const sourceMod = mods.find(mod => String(mod?.id || '') === sourceId);
        if (!sourceMod) throw new Error('私人提示词 MOD 不存在');
        const mod = normalizeModSnapshot(sourceMod, { rejectBuiltin: true });
        return {
            payload: { sourceType, mod },
            defaults: {
                title: mod.name,
                summary: mod.description,
                tags: [],
            },
        };
    }

    throw new Error('Unsupported source type');
}

router.post('/admin/discord-import/batches', requireAdminMiddleware, (request, response) => {
    try {
        const normalized = normalizeDiscordImportManifest(request.body?.manifest ?? request.body);
        const db = getCommunityDb();
        const requestedBy = request.user.profile.handle;
        const now = nowIso();
        let created = false;
        let batch = db.prepare(`
            SELECT * FROM discord_import_batches
            WHERE guild_id = ? AND channel_id = ? AND synced_at = ? AND requested_by = ?
        `).get(DISCORD_IMPORT_GUILD_ID, DISCORD_IMPORT_CHANNEL_ID, normalized.syncedAt, requestedBy);

        db.transaction(() => {
            if (batch) {
                db.prepare(`
                    UPDATE discord_import_batches
                    SET channel_name = ?, manifest_json = ?, status = 'active', updated_at = ?
                    WHERE id = ?
                `).run(normalized.channelName, JSON.stringify(normalized.manifest), now, batch.id);
            } else {
                created = true;
                batch = {
                    id: crypto.randomUUID(),
                    guild_id: DISCORD_IMPORT_GUILD_ID,
                    channel_id: DISCORD_IMPORT_CHANNEL_ID,
                    channel_name: normalized.channelName,
                    manifest_json: JSON.stringify(normalized.manifest),
                    requested_by: requestedBy,
                    status: 'active',
                    synced_at: normalized.syncedAt,
                    created_at: now,
                    updated_at: now,
                };
                db.prepare(`
                    INSERT INTO discord_import_batches (
                        id, guild_id, channel_id, channel_name, manifest_json,
                        requested_by, status, synced_at, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    batch.id,
                    batch.guild_id,
                    batch.channel_id,
                    batch.channel_name,
                    batch.manifest_json,
                    batch.requested_by,
                    batch.status,
                    batch.synced_at,
                    batch.created_at,
                    batch.updated_at,
                );
            }

            const upsertItem = db.prepare(`
                INSERT INTO discord_import_items (
                    id, batch_id, guild_id, channel_id, thread_id, card_id, title,
                    source_author_name, source_url, metadata_json, resource_kind,
                    availability, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(batch_id, card_id) DO UPDATE SET
                    thread_id = excluded.thread_id,
                    title = excluded.title,
                    source_author_name = excluded.source_author_name,
                    source_url = excluded.source_url,
                    metadata_json = excluded.metadata_json,
                    resource_kind = excluded.resource_kind,
                    availability = excluded.availability,
                    status = CASE
                        WHEN discord_import_items.status IN ('validated', 'published', 'duplicate') THEN discord_import_items.status
                        ELSE excluded.status
                    END,
                    error_message = CASE
                        WHEN discord_import_items.status IN ('validated', 'published', 'duplicate') THEN discord_import_items.error_message
                        ELSE ''
                    END,
                    updated_at = excluded.updated_at
            `);
            for (const card of normalized.cards) {
                const status = card.resourceKind === 'character-card' && card.availability !== 'unsupported'
                    ? 'queued'
                    : 'skipped';
                upsertItem.run(
                    crypto.randomUUID(),
                    batch.id,
                    DISCORD_IMPORT_GUILD_ID,
                    DISCORD_IMPORT_CHANNEL_ID,
                    card.threadId,
                    card.cardId,
                    card.title,
                    card.sourceAuthorName,
                    card.sourceUrl,
                    JSON.stringify(card.metadata),
                    card.resourceKind,
                    card.availability,
                    status,
                    now,
                    now,
                );
            }
            refreshDiscordImportBatchStatus(db, batch.id, now);
        })();

        const current = db.prepare('SELECT * FROM discord_import_batches WHERE id = ?').get(batch.id);
        return response.status(created ? 201 : 200).json(discordImportBatchJson(db, current));
    } catch (error) {
        console.error('AIBAR Discord batch registration failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.get('/admin/discord-import/batches/latest', requireAdminMiddleware, (request, response) => {
    try {
        const db = getCommunityDb();
        const batch = db.prepare(`
            SELECT * FROM discord_import_batches
            WHERE requested_by = ?
            ORDER BY updated_at DESC LIMIT 1
        `).get(request.user.profile.handle);
        if (!batch) return response.status(404).json({ error: '没有服务端 Discord 导入批次' });
        return response.json(discordImportBatchJson(db, batch));
    } catch (error) {
        console.error('AIBAR Discord batch read failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/admin/discord-import/batches/:batchId/clear', requireAdminMiddleware, (request, response) => {
    try {
        const result = getCommunityDb().prepare(`
            DELETE FROM discord_import_batches WHERE id = ? AND requested_by = ?
        `).run(String(request.params.batchId || ''), request.user.profile.handle);
        if (!result.changes) return response.status(404).json({ error: 'Discord 导入批次不存在' });
        return response.sendStatus(204);
    } catch (error) {
        console.error('AIBAR Discord batch clear failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/admin/discord-import/items/:itemId/resolve', requireAdminMiddleware, async (request, response) => {
    const db = getCommunityDb();
    const itemId = String(request.params.itemId || '');
    const item = getOwnedDiscordImportItem(db, itemId, request.user.profile.handle);
    if (!item) return response.status(404).json({ error: 'Discord 导入项目不存在' });
    if (item.resource_kind !== 'character-card' || item.availability === 'unsupported') {
        return response.status(400).json({ error: '该项目不是可导入角色卡' });
    }
    if (item.status === 'published' || item.status === 'duplicate') {
        return response.status(409).json({ error: '该角色卡已经完成服务端入库' });
    }

    const startedAt = nowIso();
    db.prepare(`
        UPDATE discord_import_items SET status = 'downloading', error_message = '', updated_at = ? WHERE id = ?
    `).run(startedAt, itemId);
    try {
        const attachmentUrl = validateDiscordAttachmentUrl(request.body?.url);
        const fileName = decodeURIComponent(attachmentUrl.pathname.split('/').pop() || '');
        if (!fileName || fileName.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(fileName)) {
            throw new Error('Discord 卡体文件名无效');
        }
        const attachment = await fetchDiscordAttachment(attachmentUrl.toString());
        const stored = storeDiscordImportAsset(attachment.buffer, fileName);
        const updatedAt = nowIso();
        db.prepare(`
            UPDATE discord_import_items
            SET file_name = ?, file_sha256 = ?, raw_asset_path = ?, status = 'validated',
                error_message = '', updated_at = ?
            WHERE id = ?
        `).run(fileName, stored.sha256, stored.relativePath, updatedAt, itemId);
        db.prepare('UPDATE discord_import_batches SET status = \'active\', updated_at = ? WHERE id = ?')
            .run(updatedAt, item.batch_id);

        response.set({
            'Cache-Control': 'no-store',
            'Content-Type': attachment.contentType,
            'Content-Length': String(attachment.buffer.length),
            'X-AIBAR-Discord-Item-Id': itemId,
            'X-AIBAR-Content-SHA256': stored.sha256,
            'X-AIBAR-File-Name': encodeURIComponent(fileName),
        });
        return response.send(attachment.buffer);
    } catch (error) {
        const updatedAt = nowIso();
        const message = publicError(error, 'Discord 导入处理失败').slice(0, 1000);
        db.transaction(() => {
            db.prepare(`
                UPDATE discord_import_items SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?
            `).run(message, updatedAt, itemId);
            refreshDiscordImportBatchStatus(db, item.batch_id, updatedAt);
        })();
        const status = error instanceof DiscordImportFetchError ? error.status : 400;
        if (status >= 500) console.warn('AIBAR Discord item resolution failed:', message);
        return response.status(status).json({ error: message });
    }
});

router.post('/admin/discord-import/items/:itemId/upload', requireAdminMiddleware, (request, response) => {
    const uploadPath = request.file?.path || (
        request.file?.destination && request.file?.filename
            ? path.join(request.file.destination, request.file.filename)
            : ''
    );
    try {
        const db = getCommunityDb();
        const item = getOwnedDiscordImportItem(
            db,
            String(request.params.itemId || ''),
            request.user.profile.handle,
        );
        if (!item) return response.status(404).json({ error: 'Discord 导入项目不存在' });
        if (!request.file || !uploadPath || !fs.existsSync(uploadPath)) {
            return response.status(400).json({ error: '缺少角色卡文件' });
        }
        if (item.resource_kind !== 'character-card' || item.availability === 'unsupported') {
            return response.status(400).json({ error: '该项目不是可导入角色卡' });
        }
        if (item.status === 'published' || item.status === 'duplicate') {
            return response.status(409).json({ error: '该角色卡已经完成服务端入库' });
        }
        if (!request.file.size || request.file.size > DISCORD_IMPORT_MAX_FILE_BYTES) {
            return response.status(413).json({ error: '角色卡文件必须在 64 MB 以内' });
        }
        const fileName = sanitize(String(request.file.originalname || ''));
        if (!fileName || fileName !== request.file.originalname || fileName.length > 255) {
            return response.status(400).json({ error: '角色卡文件名无效' });
        }
        const buffer = fs.readFileSync(uploadPath);
        const stored = storeDiscordImportAsset(buffer, fileName);
        const updatedAt = nowIso();
        db.prepare(`
            UPDATE discord_import_items
            SET file_name = ?, file_sha256 = ?, raw_asset_path = ?, status = 'validated',
                error_message = '', updated_at = ?
            WHERE id = ?
        `).run(fileName, stored.sha256, stored.relativePath, updatedAt, item.id);
        db.prepare('UPDATE discord_import_batches SET status = \'active\', updated_at = ? WHERE id = ?')
            .run(updatedAt, item.batch_id);
        return response.json(discordImportItemJson(db.prepare('SELECT * FROM discord_import_items WHERE id = ?').get(item.id)));
    } catch (error) {
        console.error('AIBAR Discord item upload failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    } finally {
        if (uploadPath && fs.existsSync(uploadPath)) fs.rmSync(uploadPath, { force: true });
    }
});

router.post('/admin/discord-import/items/:itemId/fail', requireAdminMiddleware, (request, response) => {
    try {
        const db = getCommunityDb();
        const item = getOwnedDiscordImportItem(
            db,
            String(request.params.itemId || ''),
            request.user.profile.handle,
        );
        if (!item) return response.status(404).json({ error: 'Discord 导入项目不存在' });
        if (item.status === 'published' || item.status === 'duplicate') {
            return response.status(409).json({ error: '已发布项目不能标记为失败' });
        }
        const message = String(request.body?.error || '浏览器未获取到有效角色卡').trim().slice(0, 1000);
        const updatedAt = nowIso();
        db.transaction(() => {
            db.prepare(`
                UPDATE discord_import_items SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?
            `).run(message, updatedAt, item.id);
            refreshDiscordImportBatchStatus(db, item.batch_id, updatedAt);
        })();
        return response.json(discordImportItemJson(db.prepare('SELECT * FROM discord_import_items WHERE id = ?').get(item.id)));
    } catch (error) {
        console.error('AIBAR Discord item failure update failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/list', (request, response) => {
    try {
        const db = getCommunityDb();
        const search = String(request.body.search || '').trim().slice(0, 80);
        const tag = String(request.body.tag || '').trim().slice(0, 32);
        const type = ['character', 'story', 'mod'].includes(request.body.type) ? request.body.type : '';
        const ranking = String(request.body.ranking || 'recommended');
        const page = Math.max(1, Number(request.body.page) || 1);
        const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(request.body.pageSize) || 24));
        const where = [];
        const params = [];

        if (request.body.mineOnly) {
            where.push('w.author_handle = ?');
            params.push(request.user.profile.handle);
        } else if (request.body.includeHidden && request.user.profile.admin) {
            // Administrators may request the moderation view explicitly.
        } else {
            where.push('w.status = \'published\'');
        }

        if (search) {
            // 转义 LIKE 通配符，防止用户输入 % 或 _ 扫描全表内容。
            const escapedSearch = search.replace(/[\\%_]/g, '\\$&');
            where.push('(w.title LIKE ? ESCAPE \'\\\' OR w.summary LIKE ? ESCAPE \'\\\' OR w.author_name LIKE ? ESCAPE \'\\\' OR w.author_handle LIKE ? ESCAPE \'\\\')');
            const query = `%${escapedSearch}%`;
            params.push(query, query, query, query);
        }
        if (tag) {
            where.push('EXISTS (SELECT 1 FROM work_tags wt WHERE wt.version_id = w.latest_version_id AND wt.tag = ?)');
            params.push(tag);
        }
        if (type) {
            where.push('w.type = ?');
            params.push(type);
        }
        if (request.body.favoritesOnly) {
            where.push('EXISTS (SELECT 1 FROM favorites mf WHERE mf.work_id = w.id AND mf.user_handle = ?)');
            params.push(request.user.profile.handle);
        }

        const rankingWindows = { daily: '-1 day', weekly: '-7 days', monthly: '-30 days' };
        let orderBy = '((launch_count * 3) + (favorite_count * 2) + (rating_average * rating_count)) DESC, w.updated_at DESC';
        if (ranking === 'recent') orderBy = 'w.published_at DESC';
        if (ranking === 'all') orderBy = 'launch_count DESC, favorite_count DESC, rating_average DESC';
        if (rankingWindows[ranking]) {
            orderBy = '(SELECT COUNT(*) FROM launch_events rl WHERE rl.work_id = w.id AND datetime(rl.created_at) >= datetime(\'now\', ?)) DESC, launch_count DESC, w.updated_at DESC';
            params.push(rankingWindows[ranking]);
        }

        const rows = db.prepare(`
            SELECT * FROM (${workSelect}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}) ranked
            ORDER BY ${orderBy.replaceAll('w.', 'ranked.')}
            LIMIT ? OFFSET ?
        `).all(...params, pageSize, (page - 1) * pageSize);
        const enrichment = getWorkListEnrichment(rows, request.user.profile.handle);
        const works = rows.map(row => workStats(
            row,
            request.user.profile.handle,
            request.user.profile.admin,
            enrichment,
        ));
        return response.json({ works, page, pageSize, hasMore: rows.length === pageSize });
    } catch (error) {
        console.error('AIBAR work list failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/get', (request, response) => {
    try {
        const db = getCommunityDb();
        const row = getManagedWorkRow(String(request.body.id || ''), request);
        if (!row) return response.status(404).json({ error: '作品不存在' });

        const versions = db.prepare(`
            SELECT id, version_number, version_note, title, summary, created_at
            FROM work_versions WHERE work_id = ? ORDER BY version_number DESC
            LIMIT ${WORK_VERSIONS_MAX_ITEMS}
        `).all(row.id).map(version => ({
            id: version.id,
            versionNumber: version.version_number,
            versionNote: version.version_note,
            title: version.title,
            summary: version.summary,
            createdAt: version.created_at,
        }));
        const comments = db.prepare(`
            SELECT id, user_handle, user_name, body, created_at, updated_at
            FROM comments WHERE work_id = ? AND status = 'visible'
            ORDER BY created_at DESC LIMIT 100
        `).all(row.id).map(comment => ({
            id: comment.id,
            userHandle: comment.user_handle,
            userName: comment.user_name,
            body: comment.body,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            mine: comment.user_handle === request.user.profile.handle,
        }));
        let mod;
        if (row.type === 'mod') {
            const latest = db.prepare('SELECT payload_json FROM work_versions WHERE id = ?').get(row.latest_version_id);
            const snapshot = safeJson(latest?.payload_json, null);
            const normalized = normalizeModSnapshot(snapshot?.mod);
            mod = {
                name: normalized.name,
                description: normalized.description,
                content: normalized.content,
                position: normalized.position,
            };
        }
        return response.json({
            ...workStats(row, request.user.profile.handle, request.user.profile.admin),
            versions,
            comments,
            ...(mod ? { mod } : {}),
        });
    } catch (error) {
        console.error('AIBAR work detail failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

class CommunityPublishError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

async function publishCommunitySource(request, input, options = {}) {
    let versionDirectory = '';
    let published = false;
    try {
        const sourceType = String(input.sourceType || '');
        const sourceId = String(input.sourceId || '');
        const source = options.source || await capturePrivateSource(request, sourceType, sourceId);
        const db = getCommunityDb();
        const requestedWorkId = String(input.workId || '').trim();
        const existing = requestedWorkId ? db.prepare('SELECT * FROM works WHERE id = ?').get(requestedWorkId) : null;
        if (requestedWorkId && !existing) throw new CommunityPublishError('作品不存在', 404);
        if (existing && existing.author_handle !== request.user.profile.handle) {
            throw new CommunityPublishError('只能发布自己的作品版本', 403);
        }
        if (existing && existing.type !== sourceType) throw new CommunityPublishError('新版本类型与原作品不一致');

        const title = String(input.title || source.defaults.title || '').trim().slice(0, 120);
        const summary = String(input.summary || source.defaults.summary || '').trim().slice(0, 1200);
        const tags = stringArray(input.tags?.length ? input.tags : source.defaults.tags);
        const versionNote = String(input.versionNote || '').trim().slice(0, 240);
        if (!title) throw new CommunityPublishError('作品标题不能为空');

        const workId = existing?.id || crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const versionNumber = existing
            ? Number(db.prepare('SELECT COALESCE(MAX(version_number), 0) AS value FROM work_versions WHERE work_id = ?').get(workId).value) + 1
            : 1;
        const root = getCommunityRoot();
        versionDirectory = path.join(root, 'works', workId, versionId);
        fs.mkdirSync(versionDirectory, { recursive: true });
        const snapshot = {
            ...source.payload,
            ...(options.externalSource ? { externalSource: options.externalSource } : {}),
            publication: { workId, versionId, versionNumber, title, summary, tags, versionNote },
        };
        const snapshotPath = path.join(versionDirectory, 'snapshot.json');
        writeFileSyncAtomic(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

        let assetPath = snapshotPath;
        let coverPath = snapshotPath;
        if (sourceType !== 'mod') {
            assetPath = path.join(versionDirectory, 'character.png');
            fs.copyFileSync(source.characterPath, assetPath);
            coverPath = assetPath;
            if (source.coverPath !== source.characterPath) {
                const coverExtension = path.extname(source.coverPath).toLowerCase() || '.png';
                coverPath = path.join(versionDirectory, `cover${coverExtension}`);
                fs.copyFileSync(source.coverPath, coverPath);
            }
        }

        for (const file of fs.readdirSync(versionDirectory)) {
            fs.chmodSync(path.join(versionDirectory, file), 0o444);
        }
        fs.chmodSync(versionDirectory, 0o555);

        const createdAt = nowIso();
        const relativeAsset = path.relative(root, assetPath);
        const relativeCover = path.relative(root, coverPath);
        db.transaction(() => {
            if (existing) {
                db.prepare(`
                    UPDATE works SET title = ?, summary = ?, latest_version_id = ?, status = 'published', updated_at = ? WHERE id = ?
                `).run(title, summary, versionId, createdAt, workId);
            } else {
                db.prepare(`
                    INSERT INTO works (
                        id, type, author_handle, author_name, title, summary,
                        latest_version_id, published_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    workId,
                    sourceType,
                    request.user.profile.handle,
                    request.user.profile.name,
                    title,
                    summary,
                    versionId,
                    createdAt,
                    createdAt,
                );
            }
            db.prepare(`
                INSERT INTO work_versions (
                    id, work_id, version_number, version_note, title, summary,
                    payload_json, asset_path, cover_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                versionId,
                workId,
                versionNumber,
                versionNote,
                title,
                summary,
                JSON.stringify(snapshot),
                relativeAsset,
                relativeCover,
                createdAt,
            );
            const insertTag = db.prepare('INSERT INTO work_tags (version_id, tag) VALUES (?, ?)');
            for (const tag of tags) insertTag.run(versionId, tag);
            options.finalize?.(db, { workId, versionId, versionNumber, createdAt });
        })();
        published = true;

        if (sourceType !== 'mod') {
            try {
                await ensureCommunityCoverPreview({ workId, versionId, coverPath: relativeCover });
            } catch (error) {
                console.warn(`AIBAR cover preview generation deferred for version ${versionId}:`, error);
            }
        }

        const row = getWorkRow(workId);
        return {
            created: !existing,
            work: workStats(row, request.user.profile.handle, request.user.profile.admin),
        };
    } catch (error) {
        if (!published && versionDirectory && fs.existsSync(versionDirectory)) {
            try {
                fs.chmodSync(versionDirectory, 0o755);
                fs.rmSync(versionDirectory, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('AIBAR publish cleanup failed:', cleanupError);
            }
        }
        throw error;
    }
}

router.post('/works/publish', publishRateLimiter, async (request, response) => {
    try {
        const result = await publishCommunitySource(request, request.body || {});
        return response.status(result.created ? 201 : 200).json(result.work);
    } catch (error) {
        console.error('AIBAR publish failed:', error);
        const status = error instanceof CommunityPublishError ? error.status : 400;
        return response.status(status).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/publish-discord', requireAdminMiddleware, async (request, response) => {
    try {
        const sourceId = String(request.body?.sourceId || '');
        const discordSource = normalizeDiscordPublicSource(request.body?.source);
        const source = await capturePrivateSource(request, 'character', sourceId);
        const fileSha256 = crypto.createHash('sha256').update(fs.readFileSync(source.characterPath)).digest('hex');
        const db = getCommunityDb();

        const duplicate = db.prepare(`
            SELECT w.id AS work_id, v.id AS version_id
            FROM work_versions v
            JOIN works w ON w.id = v.work_id
            WHERE w.type = 'character' AND w.status = 'published'
              AND json_extract(v.payload_json, '$.externalSource.provider') = 'discord'
              AND json_extract(v.payload_json, '$.externalSource.fileSha256') = ?
            ORDER BY v.created_at DESC
            LIMIT 1
        `).get(fileSha256);
        if (duplicate) {
            const row = getWorkRow(duplicate.work_id);
            if (!row) throw new CommunityPublishError('重复作品已不可见，请重试发布', 409);
            return response.json({
                status: 'duplicate',
                versionId: duplicate.version_id,
                work: workStats(row, request.user.profile.handle, true),
            });
        }

        const previous = db.prepare(`
            SELECT w.id AS work_id
            FROM work_versions v
            JOIN works w ON w.id = v.work_id
            WHERE w.type = 'character' AND w.author_handle = ?
              AND json_extract(v.payload_json, '$.externalSource.provider') = 'discord'
              AND json_extract(v.payload_json, '$.externalSource.guildId') = ?
              AND json_extract(v.payload_json, '$.externalSource.channelId') = ?
              AND json_extract(v.payload_json, '$.externalSource.threadId') = ?
            ORDER BY v.created_at DESC
            LIMIT 1
        `).get(
            request.user.profile.handle,
            discordSource.guildId,
            discordSource.channelId,
            discordSource.threadId,
        );
        const externalSource = {
            provider: 'discord',
            guildId: discordSource.guildId,
            channelId: discordSource.channelId,
            threadId: discordSource.threadId,
            cardId: discordSource.cardId,
            sourceUrl: discordSource.sourceUrl,
            authorName: discordSource.authorName,
            fileName: path.basename(source.characterPath),
            fileSha256,
            importedAt: nowIso(),
        };
        const result = await publishCommunitySource(request, {
            sourceType: 'character',
            sourceId,
            workId: previous?.work_id || '',
            title: discordSource.title,
            tags: discordSource.tags,
            versionNote: previous ? 'Discord 角色卡更新' : 'Discord 角色卡发布',
        }, { source, externalSource });
        return response.status(result.created ? 201 : 200).json({
            status: 'published',
            versionId: result.work.latestVersionId,
            work: result.work,
        });
    } catch (error) {
        console.error('AIBAR Discord public publish failed:', error);
        const status = error instanceof CommunityPublishError ? error.status : 400;
        return response.status(status).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/admin/discord-import/items/:itemId/publish', requireAdminMiddleware, async (request, response) => {
    const db = getCommunityDb();
    const itemId = String(request.params.itemId || '');
    const item = getOwnedDiscordImportItem(db, itemId, request.user.profile.handle);
    if (!item) return response.status(404).json({ error: 'Discord 导入项目不存在' });
    if (item.resource_kind !== 'character-card') return response.status(400).json({ error: '该项目不是角色卡' });

    try {
        if (item.status === 'published' || item.status === 'duplicate') {
            const row = item.work_id ? getManagedWorkRow(item.work_id, request) : null;
            return response.json({ item: discordImportItemJson(item), work: row ? workStats(row, request.user.profile.handle, true) : null });
        }
        if (item.status !== 'validated' || !item.file_sha256 || !item.raw_asset_path) {
            return response.status(409).json({ error: '角色卡尚未完成服务端下载和校验' });
        }
        resolveCommunityAsset(item.raw_asset_path);

        const duplicate = db.prepare(`
            SELECT * FROM discord_import_items
            WHERE id <> ? AND file_sha256 = ? AND work_id IS NOT NULL
              AND status IN ('published', 'duplicate')
            ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, updated_at DESC
            LIMIT 1
        `).get(item.id, item.file_sha256);
        if (duplicate) {
            const updatedAt = nowIso();
            db.transaction(() => {
                db.prepare(`
                    UPDATE discord_import_items
                    SET status = 'duplicate', error_message = '', work_id = ?, work_version_id = ?, updated_at = ?
                    WHERE id = ?
                `).run(duplicate.work_id, duplicate.work_version_id, updatedAt, item.id);
                refreshDiscordImportBatchStatus(db, item.batch_id, updatedAt);
            })();
            const updated = db.prepare('SELECT * FROM discord_import_items WHERE id = ?').get(item.id);
            const row = getManagedWorkRow(duplicate.work_id, request);
            return response.json({
                item: discordImportItemJson(updated),
                work: row ? workStats(row, request.user.profile.handle, true) : null,
            });
        }

        const previous = db.prepare(`
            SELECT di.work_id FROM discord_import_items di
            JOIN works w ON w.id = di.work_id
            WHERE di.id <> ? AND di.guild_id = ? AND di.channel_id = ? AND di.thread_id = ?
              AND di.work_id IS NOT NULL AND di.status IN ('published', 'duplicate')
              AND w.author_handle = ?
            ORDER BY di.updated_at DESC LIMIT 1
        `).get(item.id, item.guild_id, item.channel_id, item.thread_id, request.user.profile.handle);
        const metadata = safeJson(item.metadata_json, {});
        const externalSource = {
            provider: 'discord',
            guildId: item.guild_id,
            channelId: item.channel_id,
            threadId: item.thread_id,
            cardId: item.card_id,
            sourceUrl: item.source_url,
            authorName: item.source_author_name,
            fileName: item.file_name,
            fileSha256: item.file_sha256,
            importedAt: nowIso(),
        };
        const sourceId = String(request.body?.sourceId || '');
        const result = await publishCommunitySource(request, {
            sourceType: 'character',
            sourceId,
            workId: previous?.work_id || '',
            title: item.title,
            tags: Array.isArray(metadata.tags) ? metadata.tags : [],
            versionNote: previous ? 'Discord 角色卡更新' : 'Discord 角色卡导入',
        }, {
            externalSource,
            finalize: (transactionDb, publishedVersion) => {
                transactionDb.prepare(`
                    UPDATE discord_import_items
                    SET status = 'published', error_message = '', work_id = ?, work_version_id = ?, updated_at = ?
                    WHERE id = ?
                `).run(
                    publishedVersion.workId,
                    publishedVersion.versionId,
                    publishedVersion.createdAt,
                    item.id,
                );
                refreshDiscordImportBatchStatus(transactionDb, item.batch_id, publishedVersion.createdAt);
            },
        });
        const updated = db.prepare('SELECT * FROM discord_import_items WHERE id = ?').get(item.id);
        return response.status(result.created ? 201 : 200).json({ item: discordImportItemJson(updated), work: result.work });
    } catch (error) {
        const message = publicError(error, 'Discord 导入处理失败').slice(0, 1000);
        const updatedAt = nowIso();
        db.transaction(() => {
            db.prepare(`
                UPDATE discord_import_items SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?
            `).run(message, updatedAt, item.id);
            refreshDiscordImportBatchStatus(db, item.batch_id, updatedAt);
        })();
        console.error('AIBAR Discord item publish failed:', error);
        const status = error instanceof CommunityPublishError ? error.status : 400;
        return response.status(status).json({ error: message });
    }
});

router.get('/works/version/:versionId/:kind', async (request, response) => {
    try {
        const kind = request.params.kind === 'asset' ? 'asset_path' : 'cover_path';
        const version = getCommunityDb().prepare(`
            SELECT v.${kind} AS file_path, v.work_id, w.type, w.status, w.author_handle
            FROM work_versions v
            JOIN works w ON w.id = v.work_id
            WHERE v.id = ?
        `).get(request.params.versionId);
        if (!version) return response.sendStatus(404);
        if (
            version.status !== 'published'
            && !request.user.profile.admin
            && version.author_handle !== request.user.profile.handle
        ) return response.sendStatus(404);

        if (kind === 'cover_path' && version.type !== 'mod') {
            try {
                const preview = await ensureCommunityCoverPreview({
                    workId: version.work_id,
                    versionId: request.params.versionId,
                    coverPath: version.file_path,
                });
                response.setHeader('Cache-Control', IMMUTABLE_COVER_CACHE_CONTROL);
                return response.sendFile(preview.path);
            } catch (error) {
                console.warn(`AIBAR cover preview fallback for version ${request.params.versionId}:`, error);
                response.setHeader('Cache-Control', IMMUTABLE_COVER_CACHE_CONTROL);
            }
        }
        return response.sendFile(resolveCommunityAsset(version.file_path));
    } catch (error) {
        console.error('AIBAR asset read failed:', error);
        return response.sendStatus(404);
    }
});

router.post('/works/status', (request, response) => {
    try {
        const db = getCommunityDb();
        const id = String(request.body.id || '');
        const status = request.body.status === 'published' ? 'published' : 'hidden';
        const work = db.prepare('SELECT * FROM works WHERE id = ?').get(id);
        if (!work) return response.status(404).json({ error: '作品不存在' });
        if (work.author_handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).json({ error: '没有权限管理该作品' });
        }
        db.prepare('UPDATE works SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
        const row = getManagedWorkRow(id, request);
        return response.json(workStats(row, request.user.profile.handle, request.user.profile.admin));
    } catch (error) {
        console.error('AIBAR work status update failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/delete', (request, response) => {
    try {
        const db = getCommunityDb();
        const id = String(request.body.id || '');
        const work = db.prepare('SELECT * FROM works WHERE id = ?').get(id);
        if (!work) return response.status(404).json({ error: '作品不存在' });
        if (work.author_handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).json({ error: '没有权限删除该作品' });
        }
        db.prepare('DELETE FROM works WHERE id = ?').run(id);
        try {
            removeWorkAssets(id);
        } catch (cleanupError) {
            console.error('AIBAR deleted work asset cleanup failed:', cleanupError);
        }
        try {
            removeCommunityCoverPreviews(id);
        } catch (cleanupError) {
            console.error('AIBAR deleted work preview cleanup failed:', cleanupError);
        }
        return response.sendStatus(204);
    } catch (error) {
        console.error('AIBAR work delete failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/favorite', (request, response) => {
    try {
        const db = getCommunityDb();
        const workId = String(request.body.id || '');
        if (!getWorkRow(workId)) return response.status(404).json({ error: '作品不存在' });
        if (request.body.favorite === false) {
            db.prepare('DELETE FROM favorites WHERE user_handle = ? AND work_id = ?').run(request.user.profile.handle, workId);
        } else {
            db.prepare('INSERT OR IGNORE INTO favorites (user_handle, work_id, created_at) VALUES (?, ?, ?)')
                .run(request.user.profile.handle, workId, nowIso());
        }
        return response.json(workStats(
            getWorkRow(workId),
            request.user.profile.handle,
            request.user.profile.admin,
        ));
    } catch (error) {
        console.error('AIBAR favorite failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/rate', (request, response) => {
    try {
        const db = getCommunityDb();
        const workId = String(request.body.id || '');
        const score = Number(request.body.score);
        if (!getWorkRow(workId)) return response.status(404).json({ error: '作品不存在' });
        if (!Number.isInteger(score) || score < 1 || score > 5) return response.status(400).json({ error: '评分必须是 1 到 5' });
        const now = nowIso();
        db.prepare(`
            INSERT INTO ratings (user_handle, work_id, score, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_handle, work_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at
        `).run(request.user.profile.handle, workId, score, now, now);
        return response.json(workStats(
            getWorkRow(workId),
            request.user.profile.handle,
            request.user.profile.admin,
        ));
    } catch (error) {
        console.error('AIBAR rating failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/comments/add', commentRateLimiter, (request, response) => {
    try {
        const workId = String(request.body.id || '');
        const body = String(request.body.body || '').trim().slice(0, 2000);
        if (!getWorkRow(workId)) return response.status(404).json({ error: '作品不存在' });
        if (!body) return response.status(400).json({ error: '评论不能为空' });
        const id = crypto.randomUUID();
        const now = nowIso();
        getCommunityDb().prepare(`
            INSERT INTO comments (id, work_id, user_handle, user_name, body, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, workId, request.user.profile.handle, request.user.profile.name, body, now, now);
        return response.status(201).json({ id, body, userHandle: request.user.profile.handle, userName: request.user.profile.name, createdAt: now, updatedAt: now, mine: true });
    } catch (error) {
        console.error('AIBAR comment failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/comments/delete', (request, response) => {
    try {
        const db = getCommunityDb();
        const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(String(request.body.id || ''));
        if (!comment) return response.status(404).json({ error: '评论不存在' });
        if (comment.user_handle !== request.user.profile.handle && !request.user.profile.admin) {
            return response.status(403).json({ error: '没有权限删除该评论' });
        }
        db.prepare('UPDATE comments SET status = \'deleted\', updated_at = ? WHERE id = ?').run(nowIso(), comment.id);
        return response.sendStatus(204);
    } catch (error) {
        console.error('AIBAR comment delete failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/launch', launchRateLimiter, async (request, response) => {
    const journal = createRollbackJournal();
    try {
        const db = getCommunityDb();
        const work = getWorkRow(String(request.body.id || ''));
        if (!work) return response.status(404).json({ error: '作品不存在' });
        const versionId = String(request.body.versionId || work.latest_version_id);
        const version = db.prepare('SELECT * FROM work_versions WHERE id = ? AND work_id = ?').get(versionId, work.id);
        if (!version) return response.status(404).json({ error: '作品版本不存在' });

        const snapshot = safeJson(version.payload_json, null);
        if (!snapshot) throw new Error('Invalid work snapshot');

        if (work.type === 'mod') {
            const sourceMod = normalizeModSnapshot(snapshot.mod);
            const { installedMods } = installMods(request, [sourceMod], { journal });
            const mod = installedMods[0];
            if (!mod) throw new Error('提示词 MOD 导入失败');

            const launchId = crypto.randomUUID();
            db.prepare(`
                INSERT INTO launch_events (id, work_id, version_id, user_handle, private_source_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(launchId, work.id, version.id, request.user.profile.handle, mod.id, nowIso());
            journal.commit();
            return response.status(201).json({ launchId, type: 'mod', mod });
        }

        if (work.type === 'story') {
            resolveStoryModDependencies(snapshot.story, snapshot.dependencies?.mods);
            resolveStoryWorldDependency(snapshot.story, snapshot.dependencies);
        }

        journal.captureDirectory(request.user.directories.characters);
        fs.mkdirSync(request.user.directories.characters, { recursive: true });
        const characterBase = uniqueName(request.user.directories.characters, version.title, '.png');
        const avatar = `${characterBase}.png`;
        const characterPath = path.join(request.user.directories.characters, avatar);
        journal.captureFile(characterPath);
        fs.copyFileSync(resolveCommunityAsset(version.asset_path), characterPath);
        if (request.user.directories.thumbnailsAvatar) {
            const thumbnailPath = path.join(request.user.directories.thumbnailsAvatar, avatar);
            journal.captureFile(thumbnailPath);
            const thumbnail = await generateThumbnail(request.user.directories, 'avatar', avatar);
            if (!thumbnail.path) console.warn(`AIBAR failed to pre-generate private avatar thumbnail for ${avatar}`);
        }
        const chatDirectory = path.join(request.user.directories.chats, characterBase);
        journal.captureDirectory(chatDirectory);
        fs.mkdirSync(chatDirectory, { recursive: true });

        let story = null;
        let installedMods = [];
        let privateSourceId = avatar;
        if (work.type === 'story') {
            const storiesDirectory = path.resolve(request.user.directories.root, 'aibar', 'stories');
            journal.captureDirectory(storiesDirectory);
            fs.mkdirSync(storiesDirectory, { recursive: true });
            const storyId = crypto.randomUUID();
            const copiedAt = nowIso();
            const installed = installStoryDependencies(request, snapshot.dependencies, snapshot.story, journal);
            installedMods = installed.installedMods;
            const cover = copyStoryCover(request, version, storyId, journal);
            const sharedModelId = String(snapshot.story?.modelProfileId || '');
            const sharedModel = sharedModelId
                ? db.prepare('SELECT id FROM shared_models WHERE id = ? AND enabled = 1').get(sharedModelId)
                : null;
            story = {
                ...snapshot.story,
                id: storyId,
                characterAvatar: avatar,
                ...cover,
                world: installed.world,
                modIds: installed.modIds,
                modelProfileId: sharedModel?.id || '',
                createdAt: copiedAt,
                updatedAt: copiedAt,
                sourceCommunityWorkId: work.id,
                sourceCommunityVersionId: version.id,
            };
            const storyPath = path.join(storiesDirectory, `${storyId}.json`);
            journal.captureFile(storyPath);
            writeFileSyncAtomic(storyPath, JSON.stringify(story, null, 4), 'utf8');
            privateSourceId = storyId;
        }

        const launchId = crypto.randomUUID();
        db.prepare(`
            INSERT INTO launch_events (id, work_id, version_id, user_handle, private_source_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(launchId, work.id, version.id, request.user.profile.handle, privateSourceId, nowIso());
        journal.commit();
        return response.status(201).json({ launchId, type: work.type, avatar, story, installedMods });
    } catch (error) {
        try {
            journal.rollback();
        } catch (rollbackError) {
            console.error('AIBAR launch rollback failed:', rollbackError);
        }
        console.error('AIBAR launch failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/works/launch-complete', (request, response) => {
    try {
        const chatId = String(request.body.chatId || '').trim().slice(0, 240);
        if (!chatId) return response.status(400).json({ error: '缺少聊天记录编号' });
        const result = getCommunityDb().prepare(`
            UPDATE launch_events SET private_chat_id = ? WHERE id = ? AND user_handle = ?
        `).run(chatId, String(request.body.launchId || ''), request.user.profile.handle);
        if (!result.changes) return response.status(404).json({ error: '启动记录不存在' });
        return response.sendStatus(204);
    } catch (error) {
        console.error('AIBAR launch completion failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/admin/overview', requireAdminMiddleware, async (_request, response) => {
    try {
        const db = getCommunityDb();
        const registrations = db.prepare(`
            SELECT id, handle, name, status, review_note, created_at, reviewed_at
            FROM registration_requests ORDER BY
              CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
            LIMIT 200
        `).all().map(item => ({
            id: item.id,
            handle: item.handle,
            name: item.name,
            status: item.status,
            reviewNote: item.review_note,
            createdAt: item.created_at,
            reviewedAt: String(item.reviewed_at || '').startsWith(APPROVAL_CLAIM_PREFIX) ? null : item.reviewed_at,
        }));
        const invites = db.prepare(`
            SELECT id, label, created_by, max_uses, use_count, expires_at, enabled, created_at
            FROM invites ORDER BY created_at DESC LIMIT 200
        `).all().map(item => ({
            id: item.id,
            label: item.label,
            createdBy: item.created_by,
            maxUses: item.max_uses,
            useCount: item.use_count,
            expiresAt: item.expires_at,
            enabled: !!item.enabled,
            createdAt: item.created_at,
        }));
        const users = await storage.values(item => item.key.startsWith(KEY_PREFIX));
        return response.json({
            registrations,
            invites,
            users: users.map(user => ({
                handle: user.handle,
                name: user.name,
                admin: user.admin,
                enabled: user.enabled,
                createdAt: user.created,
            })).sort((a, b) => a.createdAt - b.createdAt),
        });
    } catch (error) {
        console.error('AIBAR admin overview failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/admin/invites/create', requireAdminMiddleware, (request, response) => {
    try {
        const code = `AIBAR-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        const id = crypto.randomUUID();
        const label = String(request.body.label || '').trim().slice(0, 80);
        const maxUses = Math.min(100, Math.max(1, Number(request.body.maxUses) || 1));
        const expiresAt = request.body.expiresAt ? new Date(request.body.expiresAt).toISOString() : null;
        const createdAt = nowIso();
        getCommunityDb().prepare(`
            INSERT INTO invites (id, code_hash, label, created_by, max_uses, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, hashInviteCode(code), label, request.user.profile.handle, maxUses, expiresAt, createdAt);
        return response.status(201).json({ id, code, label, maxUses, useCount: 0, expiresAt, enabled: true, createdAt });
    } catch (error) {
        console.error('AIBAR invite creation failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/admin/invites/toggle', requireAdminMiddleware, (request, response) => {
    try {
        const result = getCommunityDb().prepare('UPDATE invites SET enabled = ? WHERE id = ?')
            .run(request.body.enabled === false ? 0 : 1, String(request.body.id || ''));
        if (!result.changes) return response.status(404).json({ error: '邀请码不存在' });
        return response.sendStatus(204);
    } catch (error) {
        console.error('AIBAR invite toggle failed:', error);
        return response.status(400).json({ error: publicError(error, '请求处理失败') });
    }
});

router.post('/admin/registrations/review', requireAdminMiddleware, async (request, response) => {
    let provisionedAccount = null;
    let approvalClaim = null;
    let approvalFinalized = false;
    try {
        const db = getCommunityDb();
        const id = String(request.body.id || '');
        const action = request.body.action === 'approve' ? 'approved' : 'rejected';
        const reviewNote = String(request.body.reviewNote || '').trim().slice(0, 500);
        const registration = db.prepare('SELECT * FROM registration_requests WHERE id = ? AND status = \'pending\'').get(id);
        if (!registration) return response.status(404).json({ error: '待审核申请不存在' });

        if (action === 'rejected') {
            const reviewedAt = nowIso();
            const result = db.prepare(`
                UPDATE registration_requests
                SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?,
                    password_hash = '', password_salt = ''
                WHERE id = ? AND status = 'pending' AND reviewed_at IS NULL
            `).run(reviewNote, request.user.profile.handle, reviewedAt, id);
            if (!result.changes) return response.status(409).json({ error: '注册申请正在由其他管理员处理' });
            return response.json({ id, status: action, reviewNote, reviewedAt });
        }

        if (registration.handle.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(registration.handle)) {
            return response.status(400).json({ error: '注册申请中的账号格式无效' });
        }

        const claimToken = `${APPROVAL_CLAIM_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
        const claimed = db.transaction(() => {
            const claimedRows = db.prepare(`
                SELECT id, reviewed_at FROM registration_requests
                WHERE handle = ? AND status = 'pending' AND reviewed_at LIKE 'claim:%'
            `).all(registration.handle);
            for (const row of claimedRows) {
                const claimedAt = Number(String(row.reviewed_at).split(':')[1]);
                if (Number.isFinite(claimedAt) && Date.now() - claimedAt > APPROVAL_CLAIM_TTL_MS) {
                    db.prepare(`
                        UPDATE registration_requests SET reviewed_by = NULL, reviewed_at = NULL
                        WHERE id = ? AND status = 'pending' AND reviewed_at = ?
                    `).run(row.id, row.reviewed_at);
                }
            }

            const conflict = db.prepare(`
                SELECT 1 FROM registration_requests
                WHERE handle = ? AND id <> ? AND (
                    status = 'approved'
                    OR (status = 'pending' AND reviewed_at LIKE 'claim:%')
                )
                LIMIT 1
            `).get(registration.handle, id);
            if (conflict) return false;

            return db.prepare(`
                UPDATE registration_requests SET reviewed_by = ?, reviewed_at = ?
                WHERE id = ? AND status = 'pending' AND reviewed_at IS NULL
            `).run(request.user.profile.handle, claimToken, id).changes === 1;
        })();
        if (!claimed) return response.status(409).json({ error: '该账号的注册申请正在由其他管理员处理' });
        approvalClaim = { db, id, token: claimToken };

        provisionedAccount = await provisionRegistrationAccount({
            handle: registration.handle,
            name: registration.name,
            passwordHash: registration.password_hash,
            passwordSalt: registration.password_salt,
            claimToken,
        });

        const reviewedAt = nowIso();
        db.transaction(() => {
            const result = db.prepare(`
                UPDATE registration_requests
                SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?,
                    password_hash = '', password_salt = ''
                WHERE id = ? AND status = 'pending' AND reviewed_at = ?
            `).run(reviewNote, request.user.profile.handle, reviewedAt, id, claimToken);
            if (!result.changes) throw new Error('注册申请状态已发生变化，请刷新后重试');
            db.prepare(`
                UPDATE registration_requests
                SET status = 'rejected', review_note = '同账号的其他申请已自动关闭',
                    reviewed_by = ?, reviewed_at = ?, password_hash = '', password_salt = ''
                WHERE handle = ? AND id <> ? AND status = 'pending' AND reviewed_at IS NULL
            `).run(request.user.profile.handle, reviewedAt, registration.handle, id);
            grantInitialPoints(db, registration.handle, id, reviewedAt);
        })();
        approvalFinalized = true;

        try {
            await finalizeRegistrationAccount(provisionedAccount);
        } catch (cleanupError) {
            console.error('AIBAR registration approval marker cleanup failed:', cleanupError);
        }

        provisionedAccount = null;
        approvalClaim = null;
        return response.json({ id, status: action, reviewNote, reviewedAt });
    } catch (error) {
        let claimCanBeReleased = true;
        if (provisionedAccount && !approvalFinalized) {
            claimCanBeReleased = await rollbackRegistrationAccount(provisionedAccount);
        } else if (!provisionedAccount && error.aibarAccountRollbackSucceeded === false) {
            claimCanBeReleased = false;
        }
        if (approvalClaim && !approvalFinalized && claimCanBeReleased) {
            approvalClaim.db.prepare(`
                UPDATE registration_requests SET reviewed_by = NULL, reviewed_at = NULL
                WHERE id = ? AND status = 'pending' AND reviewed_at = ?
            `).run(approvalClaim.id, approvalClaim.token);
        }
        console.error('AIBAR registration review failed:', error);
        return response.status(error.statusCode || 400).json({ error: publicError(error, '请求处理失败') });
    }
});
