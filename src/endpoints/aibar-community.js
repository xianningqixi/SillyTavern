import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { publicError, publicErrorStatus } from '../aibar-errors.js';
import { createUserRateLimiter } from '../aibar-rate-limit.js';
import { getCommunityDb, getCommunityRoot, hashInviteCode } from '../aibar-community-db.js';
import {
    CommunityPublishError,
    getManagedWorkRow,
    getWorkRow,
    normalizeModSnapshot,
    nowIso,
    publishCommunitySource,
    readUserSettings,
    requestedStoryModIds,
    requestedStoryWorldName,
    resolveCommunityAsset,
    resolveStoryModDependencies,
    safeJson,
    workSelect,
    workStats,
} from '../aibar-community-shared.js';
import { requireAdminMiddleware } from '../users.js';
import { generateThumbnail } from './thumbnails.js';
import {
    ensureCommunityCoverPreview,
    removeCommunityCoverPreviews,
} from '../aibar-community-previews.js';
import { router as discordImportRouter } from './aibar-discord-import.js';
import { router as registrationReviewRouter } from './aibar-registration-review.js';

export { resolveStoryModDependencies } from '../aibar-community-shared.js';
export { DISCORD_BATCH_FETCH_CONCURRENCY, runDiscordPublishBatch } from './aibar-discord-import.js';

export const router = express.Router();

// Discord 导入路由原先直接注册在本文件最前部，这里无路径前缀合并挂载，保持既有匹配顺序。
router.use(discordImportRouter);

const publishRateLimiter = createUserRateLimiter({ points: 12, duration: 60, message: '发布操作过于频繁，请稍后再试' });
const launchRateLimiter = createUserRateLimiter({ points: 12, duration: 60, message: '启动操作过于频繁，请稍后再试' });
const commentRateLimiter = createUserRateLimiter({ points: 20, duration: 60, message: '评论发送过于频繁，请稍后再试' });

const MAX_PAGE_SIZE = 48;
const WORK_VERSIONS_MAX_ITEMS = 50;
const IMMUTABLE_COVER_CACHE_CONTROL = 'private, max-age=31536000, immutable';

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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
    }
});

// 已发布作品最新版本的标签聚合：社区页标签筛选 chips 的数据源
router.post('/works/tags', (request, response) => {
    try {
        const db = getCommunityDb();
        const type = ['character', 'story', 'mod'].includes(request.body.type) ? request.body.type : '';
        const params = [];
        let where = 'w.status = \'published\'';
        if (type) {
            where += ' AND w.type = ?';
            params.push(type);
        }
        const tags = db.prepare(`
            SELECT wt.tag AS tag, COUNT(*) AS count
            FROM work_tags wt
            JOIN works w ON w.latest_version_id = wt.version_id
            WHERE ${where}
            GROUP BY wt.tag
            ORDER BY count DESC, wt.tag ASC
            LIMIT 60
        `).all(...params);
        return response.json({ tags });
    } catch (error) {
        console.error('AIBAR work tags failed:', error);
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
    }
});

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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
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
        return response.status(publicErrorStatus(error)).json({ error: publicError(error, '请求处理失败') });
    }
});

// 注册审核路由原先注册在本文件最末尾，这里最后合并挂载，保持既有匹配顺序。
router.use(registrationReviewRouter);
