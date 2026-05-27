import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

export const router = express.Router();

function getStoriesDirectory(request) {
    return path.join(request.user.directories.root, 'aibar', 'stories');
}

function ensureStoriesDirectory(request) {
    const directory = getStoriesDirectory(request);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function normalizeId(value) {
    const id = sanitize(String(value || '').replace(/\.json$/i, '').trim());
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
