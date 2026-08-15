import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { publicError, publicErrorStatus } from '../aibar-errors.js';
import { createUserRateLimiter } from '../aibar-rate-limit.js';
import { getCommunityDb, getCommunityRoot } from '../aibar-community-db.js';
import {
    CommunityPublishError,
    capturePrivateSource,
    externalVersionKeys,
    getManagedWorkRow,
    getWorkRow,
    nowIso,
    publishCommunitySource,
    resolveCommunityAsset,
    safeJson,
    workStats,
} from '../aibar-community-shared.js';
import { requireAdminMiddleware } from '../users.js';
import { importCharacterBuffer } from './characters.js';
import {
    DiscordImportFetchError,
    fetchDiscordAttachment,
    validateDiscordAttachmentUrl,
} from './aibar.js';

export const router = express.Router();

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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
    }
});

/**
 * Discord 角色卡公开发布的核心逻辑：哈希去重 → 同 thread 版本关联 → 发布。
 * 单项路由与批量路由共用。
 * @param {import('express').Request} request 已认证的管理员请求
 * @param {string} sourceId 私人角色文件名（含 .png）
 * @param {object} discordSource normalizeDiscordPublicSource 的产物
 * @returns {Promise<{ status: 'published' | 'duplicate', versionId: string, work: object, created?: boolean }>}
 */
async function publishDiscordCharacter(request, sourceId, discordSource) {
    const source = await capturePrivateSource(request, 'character', sourceId);
    const fileSha256 = crypto.createHash('sha256').update(fs.readFileSync(source.characterPath)).digest('hex');
    const db = getCommunityDb();

    const duplicate = db.prepare(`
        SELECT w.id AS work_id, v.id AS version_id
        FROM work_versions v
        JOIN works w ON w.id = v.work_id
        WHERE w.type = 'character' AND w.status = 'published'
          AND v.external_sha256 = ?
        ORDER BY v.created_at DESC
        LIMIT 1
    `).get(fileSha256);
    if (duplicate) {
        const row = getWorkRow(duplicate.work_id);
        if (!row) throw new CommunityPublishError('重复作品已不可见，请重试发布', 409);
        return {
            status: 'duplicate',
            versionId: duplicate.version_id,
            work: workStats(row, request.user.profile.handle, true),
        };
    }

    const previous = db.prepare(`
        SELECT w.id AS work_id
        FROM work_versions v
        JOIN works w ON w.id = v.work_id
        WHERE w.type = 'character'
          AND v.external_thread_key = ?
        ORDER BY v.created_at DESC
        LIMIT 1
    `).get(externalVersionKeys(request.user.profile.handle, discordSource).externalThreadKey);
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
    return {
        status: 'published',
        versionId: result.work.latestVersionId,
        work: result.work,
        created: result.created,
    };
}

router.post('/works/publish-discord', requireAdminMiddleware, async (request, response) => {
    try {
        const sourceId = String(request.body?.sourceId || '');
        const discordSource = normalizeDiscordPublicSource(request.body?.source);
        const result = await publishDiscordCharacter(request, sourceId, discordSource);
        return response.status(result.status === 'published' && result.created ? 201 : 200).json({
            status: result.status,
            versionId: result.versionId,
            work: result.work,
        });
    } catch (error) {
        console.error('AIBAR Discord public publish failed:', error);
        const status = error instanceof CommunityPublishError ? error.status : 400;
        return response.status(status).json({ error: publicError(error, '请求处理失败') });
    }
});

export const DISCORD_BATCH_FETCH_CONCURRENCY = 3;
const DISCORD_BATCH_MAX_ITEMS = 10;
const DISCORD_CARD_URL_EXTENSIONS = new Set(['png', 'json', 'yaml', 'yml', 'charx', 'byaf']);
const discordBatchRateLimiter = createUserRateLimiter({ points: 6, duration: 60, message: '批量发布过于频繁，请稍后再试' });

/**
 * 批量发布编排：附件抓取按 fetchConcurrency 并行（网络是耗时主体），
 * 导入与发布串行化（同一用户目录与数据库，避免命名/事务竞态），单项失败互不影响。
 * fetchItem/publishItem 以依赖注入方式传入，便于单测。
 * @param {Array<object>} items 已校验的批量项
 * @param {{ fetchItem: Function, publishItem: Function, fetchConcurrency?: number }} deps
 * @returns {Promise<Array<object>>} 与 items 同序的逐项结果
 */
export async function runDiscordPublishBatch(items, { fetchItem, publishItem, fetchConcurrency = DISCORD_BATCH_FETCH_CONCURRENCY }) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let importChain = Promise.resolve();
    async function workerLoop() {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) return;
            const item = items[index];
            try {
                const fetched = await fetchItem(item, index);
                // 每个 worker 等待自己的导入完成再抓下一项：内存中最多同时存在 fetchConcurrency 份附件
                importChain = importChain
                    .then(async () => {
                        results[index] = await publishItem(item, fetched, index);
                    })
                    .catch((error) => {
                        results[index] = { status: 'failed', error };
                    });
                await importChain;
            } catch (error) {
                results[index] = { status: 'failed', error };
            }
        }
    }
    const workerCount = Math.max(1, Math.min(fetchConcurrency, items.length));
    await Promise.all(Array.from({ length: workerCount }, workerLoop));
    return results;
}

router.post('/works/publish-discord-batch', requireAdminMiddleware, discordBatchRateLimiter, async (request, response) => {
    try {
        const rawItems = Array.isArray(request.body?.items) ? request.body.items : null;
        if (!rawItems || !rawItems.length || rawItems.length > DISCORD_BATCH_MAX_ITEMS) {
            throw new CommunityPublishError(`items 必须是 1 到 ${DISCORD_BATCH_MAX_ITEMS} 项的数组`);
        }
        // 全量预校验：任何一项参数非法则整个请求 4xx，不做半批执行
        const items = rawItems.map((raw) => {
            const url = validateDiscordAttachmentUrl(String(raw?.url || ''));
            const extension = url.pathname.toLowerCase().split('.').pop() || '';
            if (!DISCORD_CARD_URL_EXTENSIONS.has(extension)) {
                throw new CommunityPublishError('附件不是受支持的卡体格式（PNG/JSON/CHARX/BYAF/YAML）');
            }
            return {
                url: url.toString(),
                format: extension,
                source: normalizeDiscordPublicSource(raw?.source),
            };
        });
        const results = await runDiscordPublishBatch(items, {
            fetchItem: item => fetchDiscordAttachment(item.url),
            publishItem: async (item, fetched) => {
                const fileName = await importCharacterBuffer(fetched.buffer, item.format, request);
                const published = await publishDiscordCharacter(request, `${fileName}.png`, item.source);
                return { status: published.status, versionId: published.versionId, workId: published.work.id };
            },
        });
        return response.json({
            results: results.map((result, index) => {
                const cardId = items[index].source.cardId;
                if (result?.status === 'failed') {
                    console.error('AIBAR Discord batch publish item failed:', result.error);
                    return { index, cardId, status: 'failed', error: publicError(result.error, '发布失败') };
                }
                return { index, cardId, ...result };
            }),
        });
    } catch (error) {
        const status = (error instanceof CommunityPublishError || error instanceof DiscordImportFetchError)
            ? (error.status || 400)
            : 400;
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
