import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import storage from 'node-persist';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { getCommunityDb, getCommunityRoot, hashInviteCode } from '../aibar-community-db.js';
import {
    KEY_PREFIX,
    ensurePublicDirectoriesExist,
    getAllUserHandles,
    getUserDirectories,
    requireAdminMiddleware,
    toKey,
} from '../users.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { readCharacterData } from './characters.js';

export const router = express.Router();

const MAX_PAGE_SIZE = 48;
const MAX_TAGS = 8;
const MAX_MOD_SNAPSHOT_BYTES = 64 * 1024;
const MOD_POSITIONS = new Set(['system_prepend', 'system_append', 'user_suffix']);
const APPROVAL_CLAIM_PREFIX = 'claim:';
const APPROVAL_CLAIM_TTL_MS = 10 * 60 * 1000;

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
            where.push('(w.title LIKE ? OR w.summary LIKE ? OR w.author_name LIKE ? OR w.author_handle LIKE ?)');
            const query = `%${search}%`;
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
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.status(400).json({ error: String(error.message || error) });
    }
});

router.post('/works/publish', async (request, response) => {
    let versionDirectory = '';
    let published = false;
    try {
        const sourceType = String(request.body.sourceType || '');
        const sourceId = String(request.body.sourceId || '');
        const source = await capturePrivateSource(request, sourceType, sourceId);
        const db = getCommunityDb();
        const requestedWorkId = String(request.body.workId || '').trim();
        const existing = requestedWorkId ? db.prepare('SELECT * FROM works WHERE id = ?').get(requestedWorkId) : null;
        if (requestedWorkId && !existing) return response.status(404).json({ error: '作品不存在' });
        if (existing && existing.author_handle !== request.user.profile.handle) return response.status(403).json({ error: '只能发布自己的作品版本' });
        if (existing && existing.type !== sourceType) return response.status(400).json({ error: '新版本类型与原作品不一致' });

        const title = String(request.body.title || source.defaults.title || '').trim().slice(0, 120);
        const summary = String(request.body.summary || source.defaults.summary || '').trim().slice(0, 1200);
        const tags = stringArray(request.body.tags?.length ? request.body.tags : source.defaults.tags);
        const versionNote = String(request.body.versionNote || '').trim().slice(0, 240);
        if (!title) return response.status(400).json({ error: '作品标题不能为空' });

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
        })();
        published = true;

        const row = getWorkRow(workId);
        return response.status(existing ? 200 : 201).json(workStats(
            row,
            request.user.profile.handle,
            request.user.profile.admin,
        ));
    } catch (error) {
        if (!published && versionDirectory && fs.existsSync(versionDirectory)) {
            try {
                fs.chmodSync(versionDirectory, 0o755);
                fs.rmSync(versionDirectory, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('AIBAR publish cleanup failed:', cleanupError);
            }
        }
        console.error('AIBAR publish failed:', error);
        return response.status(400).json({ error: String(error.message || error) });
    }
});

router.get('/works/version/:versionId/:kind', (request, response) => {
    try {
        const kind = request.params.kind === 'asset' ? 'asset_path' : 'cover_path';
        const version = getCommunityDb().prepare(`
            SELECT v.${kind} AS file_path, w.status, w.author_handle
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
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.sendStatus(204);
    } catch (error) {
        console.error('AIBAR work delete failed:', error);
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.status(400).json({ error: String(error.message || error) });
    }
});

router.post('/works/comments/add', (request, response) => {
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
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.status(400).json({ error: String(error.message || error) });
    }
});

router.post('/works/launch', (request, response) => {
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
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.status(400).json({ error: String(error.message || error) });
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
        return response.status(400).json({ error: String(error.message || error) });
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

        const handles = await getAllUserHandles();
        if (handles.includes(registration.handle) || await storage.getItem(toKey(registration.handle))) {
            const error = new Error('账号已存在，无法重复批准');
            error.statusCode = 409;
            throw error;
        }

        const user = {
            handle: registration.handle,
            name: registration.name,
            created: Date.now(),
            password: registration.password_hash,
            salt: registration.password_salt,
            admin: false,
            enabled: true,
            _aibarApprovalClaim: claimToken,
        };
        const directories = getUserDirectories(user.handle);
        provisionedAccount = {
            handle: user.handle,
            root: directories.root,
            removeRoot: !fs.existsSync(directories.root),
            token: claimToken,
        };
        await storage.setItem(toKey(user.handle), user);
        await ensurePublicDirectoriesExist();
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        if (!fs.existsSync(path.join(directories.root, 'settings.json'))) {
            throw new Error('账号初始化失败：未能创建设置文件');
        }

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
        })();
        approvalFinalized = true;

        try {
            const stored = await storage.getItem(toKey(user.handle));
            if (stored?._aibarApprovalClaim === claimToken) {
                delete stored._aibarApprovalClaim;
                await storage.setItem(toKey(user.handle), stored);
            }
        } catch (cleanupError) {
            console.error('AIBAR registration approval marker cleanup failed:', cleanupError);
        }

        provisionedAccount = null;
        approvalClaim = null;
        return response.json({ id, status: action, reviewNote, reviewedAt });
    } catch (error) {
        let claimCanBeReleased = true;
        if (provisionedAccount && !approvalFinalized) {
            let accountRemoved = false;
            try {
                const stored = await storage.getItem(toKey(provisionedAccount.handle));
                if (!stored) {
                    accountRemoved = true;
                } else if (stored._aibarApprovalClaim === provisionedAccount.token) {
                    await storage.removeItem(toKey(provisionedAccount.handle));
                    accountRemoved = true;
                } else {
                    claimCanBeReleased = false;
                }
            } catch (rollbackError) {
                claimCanBeReleased = false;
                console.error('AIBAR registration account rollback failed:', rollbackError);
            }
            if (provisionedAccount.removeRoot && accountRemoved) {
                try {
                    await fs.promises.rm(provisionedAccount.root, { recursive: true, force: true });
                } catch (rollbackError) {
                    console.error('AIBAR registration directory rollback failed:', rollbackError);
                }
            }
        }
        if (approvalClaim && !approvalFinalized && claimCanBeReleased) {
            approvalClaim.db.prepare(`
                UPDATE registration_requests SET reviewed_by = NULL, reviewed_at = NULL
                WHERE id = ? AND status = 'pending' AND reviewed_at = ?
            `).run(approvalClaim.id, approvalClaim.token);
        }
        console.error('AIBAR registration review failed:', error);
        return response.status(error.statusCode || 400).json({ error: String(error.message || error) });
    }
});
