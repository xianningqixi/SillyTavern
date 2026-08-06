import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { getCommunityDb, getCommunityRoot } from './aibar-community-db.js';
import { Jimp } from './jimp.js';

const PREVIEW_WIDTH = 384;
const PREVIEW_HEIGHT = 512;
const PREVIEW_QUALITY = 80;
const PREVIEW_MIME = 'image/webp';
const MAX_CONCURRENT_GENERATIONS = 2;

const generationJobs = new Map();
const generationQueue = [];
let activeGenerations = 0;

function cacheKey(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function previewRoot() {
    return path.join(getCommunityRoot(), 'cache', 'community-covers');
}

function previewWorkDirectory(workId) {
    return path.join(previewRoot(), cacheKey(workId));
}

export function communityCoverPreviewPath(workId, versionId) {
    return path.join(previewWorkDirectory(workId), `${cacheKey(versionId)}.webp`);
}

function resolveCoverSource(relativePath) {
    const root = getCommunityRoot();
    const sourcePath = path.resolve(root, String(relativePath || ''));
    if (
        !relativePath
        || path.isAbsolute(relativePath)
        || !sourcePath.startsWith(`${root}${path.sep}`)
        || !fs.existsSync(sourcePath)
        || !fs.statSync(sourcePath).isFile()
    ) {
        throw new Error('Community cover source not found');
    }
    return sourcePath;
}

function hasUsablePreview(previewPath) {
    try {
        const stat = fs.statSync(previewPath);
        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

function drainGenerationQueue() {
    while (activeGenerations < MAX_CONCURRENT_GENERATIONS && generationQueue.length) {
        const queued = generationQueue.shift();
        activeGenerations += 1;
        Promise.resolve()
            .then(queued.task)
            .then(queued.resolve, queued.reject)
            .finally(() => {
                activeGenerations -= 1;
                drainGenerationQueue();
            });
    }
}

function scheduleGeneration(task) {
    return new Promise((resolve, reject) => {
        generationQueue.push({ task, resolve, reject });
        drainGenerationQueue();
    });
}

async function generatePreview(sourcePath, previewPath) {
    const image = await Jimp.read(fs.readFileSync(sourcePath));
    image.cover({ w: PREVIEW_WIDTH, h: PREVIEW_HEIGHT });
    const buffer = await image.getBuffer(PREVIEW_MIME, { quality: PREVIEW_QUALITY });
    fs.mkdirSync(path.dirname(previewPath), { recursive: true, mode: 0o750 });
    writeFileSyncAtomic(previewPath, buffer, { mode: 0o640 });
}

export async function ensureCommunityCoverPreview({ workId, versionId, coverPath }) {
    const destination = communityCoverPreviewPath(workId, versionId);
    if (hasUsablePreview(destination)) return { path: destination, created: false };

    const existingJob = generationJobs.get(destination);
    if (existingJob) return existingJob;

    const job = scheduleGeneration(async () => {
        if (hasUsablePreview(destination)) return { path: destination, created: false };
        const source = resolveCoverSource(coverPath);
        await generatePreview(source, destination);
        return { path: destination, created: true };
    }).finally(() => generationJobs.delete(destination));
    generationJobs.set(destination, job);
    return job;
}

export function removeCommunityCoverPreviews(workId) {
    const directory = previewWorkDirectory(workId);
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
}

export async function backfillCommunityCoverPreviews({ onProgress } = {}) {
    const rows = getCommunityDb().prepare(`
        SELECT v.id AS version_id, v.work_id, v.cover_path
        FROM work_versions v
        JOIN works w ON w.id = v.work_id
        WHERE w.type <> 'mod'
        ORDER BY v.created_at, v.id
    `).all();

    const outcomes = await Promise.all(rows.map(async (row) => {
        try {
            const result = await ensureCommunityCoverPreview({
                workId: row.work_id,
                versionId: row.version_id,
                coverPath: row.cover_path,
            });
            onProgress?.({ versionId: row.version_id, status: result.created ? 'created' : 'cached' });
            return result.created ? 'created' : 'cached';
        } catch (error) {
            onProgress?.({ versionId: row.version_id, status: 'failed', error });
            return 'failed';
        }
    }));

    return {
        total: outcomes.length,
        created: outcomes.filter(status => status === 'created').length,
        cached: outcomes.filter(status => status === 'cached').length,
        failed: outcomes.filter(status => status === 'failed').length,
    };
}
