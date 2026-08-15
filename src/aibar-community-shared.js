import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { getCommunityDb, getCommunityRoot } from './aibar-community-db.js';
import { ensureCommunityCoverPreview } from './aibar-community-previews.js';
import { readCharacterData } from './endpoints/characters.js';

const MAX_TAGS = 8;
const MAX_MOD_SNAPSHOT_BYTES = 64 * 1024;
const MOD_POSITIONS = new Set(['system_prepend', 'system_append', 'user_suffix']);

export function nowIso() {
    return new Date().toISOString();
}

function stringArray(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(item => String(item || '').trim().slice(0, 32)).filter(Boolean))].slice(0, MAX_TAGS);
}

export function safeJson(value, fallback = {}) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

export function readUserSettings(request) {
    const settingsPath = path.join(request.user.directories.root, 'settings.json');
    const settings = fs.existsSync(settingsPath) ? safeJson(fs.readFileSync(settingsPath, 'utf8'), {}) : {};
    return {
        settingsPath,
        settings: settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {},
    };
}

export function normalizeModSnapshot(value, { rejectBuiltin = false } = {}) {
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

export function requestedStoryModIds(story) {
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

export function requestedStoryWorldName(story) {
    if (story?.world === undefined || story.world === null || story.world === '') return '';
    if (typeof story.world !== 'string' || !story.world.trim() || story.world !== story.world.trim()) {
        throw new Error('故事包含无效的世界书名称');
    }
    return story.world;
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

function versionAssetUrl(versionId, kind) {
    return `/api/aibar/works/version/${encodeURIComponent(versionId)}/${kind}`;
}

export function workStats(row, userHandle, isAdmin = false, enrichment = null) {
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

export const workSelect = `
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

export function getWorkRow(workId) {
    return getCommunityDb().prepare(`${workSelect} WHERE w.id = ? AND w.status = 'published'`).get(workId);
}

export function getManagedWorkRow(workId, request) {
    const row = getCommunityDb().prepare(`${workSelect} WHERE w.id = ?`).get(workId);
    if (!row) return null;
    if (row.status === 'published') return row;
    if (request.user.profile.admin || row.author_handle === request.user.profile.handle) return row;
    return null;
}

export function resolveCommunityAsset(relativePath) {
    const root = getCommunityRoot();
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(`${root}${path.sep}`) || !fs.existsSync(resolved)) {
        throw new Error('Community asset not found');
    }
    return resolved;
}

export async function capturePrivateSource(request, sourceType, sourceId) {
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

export class CommunityPublishError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/**
 * Discord 发布查重的索引列取值。thread key 把作者拼进键里，使"同一作者同一
 * thread 找旧版本"的查询单列索引即可命中。拼法与数据库迁移回填保持一致
 * （aibar-community-db.js migrateWorkVersionExternalKeys）。
 */
export function externalVersionKeys(authorHandle, externalSource) {
    if (!externalSource) return { externalSha256: null, externalThreadKey: null };
    // 写入端传完整 externalSource（带 provider）；查重端传 normalizeDiscordPublicSource
    // 的产物（只有三个 id），无 provider 字段时按 discord 键处理。
    if (externalSource.provider !== undefined && externalSource.provider !== 'discord') {
        return { externalSha256: null, externalThreadKey: null };
    }
    const sha256 = String(externalSource.fileSha256 || '').trim();
    return {
        externalSha256: sha256 || null,
        externalThreadKey: [
            externalSource.guildId,
            externalSource.channelId,
            externalSource.threadId,
        ].join(':') + `@${authorHandle}`,
    };
}

export async function publishCommunitySource(request, input, options = {}) {
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
        const externalKeys = externalVersionKeys(request.user.profile.handle, options.externalSource);
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
                    payload_json, asset_path, cover_path, external_sha256, external_thread_key, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                externalKeys.externalSha256,
                externalKeys.externalThreadKey,
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
