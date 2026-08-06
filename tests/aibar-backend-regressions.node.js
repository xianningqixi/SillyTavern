/* global globalThis */
/* eslint-disable playwright/expect-expect, playwright/no-conditional-in-test */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import Database from 'better-sqlite3';
import { imageSize as sizeOf } from 'image-size';
import storage from 'node-persist';

import '../src/fetch-patch.js';
import { setConfigFilePath } from '../src/util.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aibar-backend-regressions-'));
const userRoot = path.join(testRoot, 'user');
const directories = {
    root: userRoot,
    characters: path.join(userRoot, 'characters'),
    chats: path.join(userRoot, 'chats'),
    thumbnailsAvatar: path.join(userRoot, 'thumbnails', 'avatar'),
    worlds: path.join(userRoot, 'worlds'),
};

for (const directory of [
    directories.root,
    directories.characters,
    directories.chats,
    directories.thumbnailsAvatar,
    directories.worlds,
    path.join(userRoot, 'aibar', 'stories'),
]) {
    fs.mkdirSync(directory, { recursive: true });
}

globalThis.DATA_ROOT = testRoot;
setConfigFilePath(path.resolve('default/config.yaml'));
await storage.init({ dir: path.join(testRoot, '_storage'), ttl: false, expiredInterval: 0 });

const [
    { createCommunityDatabase, getCommunityDb, getCommunityRoot, hashInviteCode },
    { communityCoverPreviewPath },
    modelsModule,
    publicModule,
    { router: communityRouter },
    { router: aibarRouter },
    { getChatDataStrict },
    { isCsrfProtectionDisabled, setupPrivateEndpoints },
    { getClaudeApiConfig },
] = await Promise.all([
    import('../src/aibar-community-db.js'),
    import('../src/aibar-community-previews.js'),
    import('../src/endpoints/aibar-models.js'),
    import('../src/endpoints/aibar-public.js'),
    import('../src/endpoints/aibar-community.js'),
    import('../src/endpoints/aibar.js'),
    import('../src/endpoints/chats.js'),
    import('../src/server-startup.js'),
    import('../src/endpoints/backends/chat-completions.js'),
]);

globalThis.DATA_ROOT = path.relative(process.cwd(), testRoot);
assert.equal(getCommunityRoot(), path.join(testRoot, '_aibar'));
globalThis.DATA_ROOT = testRoot;

const {
    determineSettlementCharge,
    estimateInputTokens,
    estimateSettlementInputTokens,
    legacyProviderGuard,
    releaseStaleReservations,
    router: modelsRouter,
    sharedModelGuard,
    summarizeCapture,
    trackActiveReservation,
    untrackActiveReservation,
} = modelsModule;
const { normalizeRegistrationHandle, registrationRateLimitKey } = publicModule;

const settingsPath = path.join(userRoot, 'settings.json');
const settings = {
    aibar: {
        simple_ui_mods: [
            {
                id: 'valid-mod',
                name: 'Valid MOD',
                description: '',
                content: 'Keep the response focused.',
                position: 'system_append',
                enabled: true,
                builtin: false,
            },
            {
                id: 'invalid-mod',
                name: 'Invalid MOD',
                description: '',
                content: '',
                position: 'system_append',
                enabled: true,
                builtin: false,
            },
        ],
    },
};
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4), 'utf8');

const characterAvatar = 'story-character.png';
fs.copyFileSync(
    path.resolve('default/content/default_Seraphina.png'),
    path.join(directories.characters, characterAvatar),
);

function writeStory(id, modIds, world = '') {
    fs.writeFileSync(
        path.join(userRoot, 'aibar', 'stories', `${id}.json`),
        JSON.stringify({
            id,
            title: id,
            summary: '',
            characterAvatar,
            modIds,
            world,
        }, null, 4),
        'utf8',
    );
}

writeStory('missing-mod-story', ['missing-mod']);
writeStory('invalid-mod-story', ['invalid-mod']);
writeStory('valid-mod-story', ['valid-mod']);
writeStory('missing-world-story', [], 'missing-world');
writeStory('invalid-world-story', [], 'invalid-world');
writeStory('valid-world-story', [], 'valid-world');
fs.writeFileSync(path.join(directories.worlds, 'invalid-world.json'), '{ invalid json', 'utf8');
fs.writeFileSync(path.join(directories.worlds, 'valid-world.json'), JSON.stringify({ entries: {} }), 'utf8');

function getRouteHandler(router, routePath) {
    const routeLayer = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods.post);
    assert.ok(routeLayer, `missing POST route ${routePath}`);
    return routeLayer.route.stack.at(-1).handle;
}

function getGetRouteHandler(router, routePath) {
    const routeLayer = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods.get);
    assert.ok(routeLayer, `missing GET route ${routePath}`);
    return routeLayer.route.stack.at(-1).handle;
}

const saveModel = getRouteHandler(modelsRouter, '/admin/models/save');
const listModels = getRouteHandler(modelsRouter, '/models/list');

test('strict chat reads distinguish a missing chat from malformed JSONL', () => {
    const chatPath = path.join(testRoot, 'strict-chat.jsonl');
    assert.deepEqual(getChatDataStrict(chatPath), []);

    fs.writeFileSync(chatPath, '{"chat_metadata":{}}\n{"mes":"hello"}', 'utf8');
    assert.equal(getChatDataStrict(chatPath)[1].mes, 'hello');

    fs.writeFileSync(chatPath, '{"chat_metadata":{}}\nnot-json', 'utf8');
    assert.throws(() => getChatDataStrict(chatPath), SyntaxError);
});
const registerUser = getRouteHandler(publicModule.router, '/register');
const saveImage = getRouteHandler(aibarRouter, '/images/save');
const saveStory = getRouteHandler(aibarRouter, '/stories/save');
const listWorks = getRouteHandler(communityRouter, '/works/list');
const getWork = getRouteHandler(communityRouter, '/works/get');
const publishWork = getRouteHandler(communityRouter, '/works/publish');
const registerDiscordBatch = getRouteHandler(communityRouter, '/admin/discord-import/batches');
const uploadDiscordItem = getRouteHandler(communityRouter, '/admin/discord-import/items/:itemId/upload');
const publishDiscordItem = getRouteHandler(communityRouter, '/admin/discord-import/items/:itemId/publish');
const setWorkStatus = getRouteHandler(communityRouter, '/works/status');
const deleteWork = getRouteHandler(communityRouter, '/works/delete');
const launchWork = getRouteHandler(communityRouter, '/works/launch');
const reviewRegistration = getRouteHandler(communityRouter, '/admin/registrations/review');
const getWorkVersion = getGetRouteHandler(communityRouter, '/works/version/:versionId/:kind');

function makeDirectoriesWritable(directory) {
    if (!fs.existsSync(directory)) return;
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) makeDirectoriesWritable(path.join(directory, entry.name));
    }
}

function snapshotTree(directory) {
    if (!fs.existsSync(directory)) return [];
    const entries = [];
    const visit = (current, relative = '') => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const absolute = path.join(current, entry.name);
            const childRelative = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                entries.push(['directory', childRelative]);
                visit(absolute, childRelative);
            } else {
                entries.push(['file', childRelative, fs.readFileSync(absolute).toString('base64')]);
            }
        }
    };
    visit(directory);
    return entries;
}

after(async () => {
    await storage.clear();
    getCommunityDb().close();
    makeDirectoriesWritable(testRoot);
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

function insertInvite(id, code, maxUses = 10) {
    getCommunityDb().prepare(`
        INSERT INTO invites (id, code_hash, label, created_by, max_uses, created_at)
        VALUES (?, ?, '', 'admin', ?, ?)
    `).run(id, hashInviteCode(code), maxUses, new Date().toISOString());
}

function insertRegistration(id, handle, inviteId) {
    getCommunityDb().prepare(`
        INSERT INTO registration_requests (
            id, handle, name, password_hash, password_salt, invite_id, created_at
        ) VALUES (?, ?, ?, 'hash', 'salt', ?, ?)
    `).run(id, handle, handle, inviteId, new Date().toISOString());
}

async function invokeRoute(
    handler,
    requestBody,
    profile = { handle: 'admin', name: 'Admin', admin: true },
    { params = {}, file = undefined } = {},
) {
    const request = {
        body: requestBody,
        params,
        file,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        user: {
            profile,
            directories,
        },
    };
    const result = { status: 200, body: null, headers: {} };
    const response = {
        status(value) {
            result.status = value;
            return this;
        },
        json(value) {
            result.body = value;
            return this;
        },
        send(value) {
            result.body = value;
            return this;
        },
        sendFile(value) {
            result.body = value;
            return this;
        },
        setHeader(name, value) {
            result.headers[String(name).toLowerCase()] = String(value);
            return this;
        },
        sendStatus(value) {
            result.status = value;
            return this;
        },
    };
    await handler(request, response, () => {});
    return result;
}

const DISCORD_TEST_GUILD_ID = '1380075940285124724';
const DISCORD_TEST_CHANNEL_ID = '1478612237869519021';

function discordManifest({
    threadId,
    cardId = threadId,
    syncedAt,
    title = 'Discord Test Card',
    period = 'today',
    filters,
}) {
    return {
        version: 1,
        guildId: DISCORD_TEST_GUILD_ID,
        channelId: DISCORD_TEST_CHANNEL_ID,
        channelName: 'hot-cards',
        syncedAt,
        timezone: 'Asia/Shanghai',
        period,
        sort: 'reactions',
        ...(filters ? { filters } : {}),
        cards: [{
            id: cardId,
            threadId,
            title,
            authorName: 'Discord Author',
            sourceUrl: `https://discord.com/channels/${DISCORD_TEST_GUILD_ID}/${threadId}`,
            tags: ['中文', '剧情'],
            publishedAt: syncedAt,
            lastActiveAt: syncedAt,
            reactionCount: 12,
            replyCount: 3,
            resource: {
                availability: 'ready',
                kind: 'character-card',
                fileName: 'card.png',
            },
        }],
    };
}

async function uploadDiscordTestFile(
    itemId,
    contents,
    fileName = 'card.png',
    profile = { handle: 'admin', name: 'Admin', admin: true },
) {
    const uploadPath = path.join(testRoot, `discord-upload-${crypto.randomUUID()}`);
    fs.writeFileSync(uploadPath, contents);
    return invokeRoute(uploadDiscordItem, {}, profile, {
        params: { itemId },
        file: {
            path: uploadPath,
            size: Buffer.byteLength(contents),
            originalname: fileName,
        },
    });
}

async function suppressExpectedErrors(callback) {
    const originalError = console.error;
    const originalInfo = console.info;
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.error = () => {};
    console.info = () => {};
    console.log = () => {};
    console.warn = () => {};
    try {
        return await callback();
    } finally {
        console.error = originalError;
        console.info = originalInfo;
        console.log = originalLog;
        console.warn = originalWarn;
    }
}

function runSharedModelGuard(requestPath, admin = false) {
    let nextCalls = 0;
    let status = 200;
    let body;
    const response = {
        status(value) {
            status = value;
            return this;
        },
        json(value) {
            body = value;
            return this;
        },
    };
    sharedModelGuard(
        { path: requestPath, user: { profile: { admin } } },
        response,
        () => { nextCalls += 1; },
    );
    return { body, nextCalls, status };
}

test('sharedModelGuard blocks case and trailing-slash variants', () => {
    for (const requestPath of ['/generate', '/generate/', '/Generate', '/GeNeRaTe/', '/STATUS/']) {
        const result = runSharedModelGuard(requestPath);
        assert.equal(result.status, 403, requestPath);
        assert.equal(result.nextCalls, 0, requestPath);
        assert.match(result.body.error.message, /共享模型/);
    }

    assert.equal(runSharedModelGuard('/models').nextCalls, 1);
    assert.equal(runSharedModelGuard('/GeNeRaTe/', true).nextCalls, 1);
});

test('legacyProviderGuard blocks ordinary users and permits administrators', () => {
    for (const admin of [false, undefined]) {
        let nextCalls = 0;
        let status = 200;
        let body;
        legacyProviderGuard(
            { user: { profile: { admin } } },
            {
                status(value) {
                    status = value;
                    return this;
                },
                json(value) {
                    body = value;
                    return this;
                },
            },
            () => { nextCalls += 1; },
        );
        assert.equal(status, 403);
        assert.equal(nextCalls, 0);
        assert.match(body.error.message, /共享模型/);
    }

    let adminNextCalls = 0;
    legacyProviderGuard(
        { user: { profile: { admin: true } } },
        {},
        () => { adminNextCalls += 1; },
    );
    assert.equal(adminNextCalls, 1);
});

test('the translation proxy is mounted behind the legacy provider guard', async () => {
    const mounts = [];
    const fakeApp = {
        use(...args) {
            mounts.push(args);
        },
    };
    await suppressExpectedErrors(() => setupPrivateEndpoints(fakeApp, { disableCsrf: false }));

    const translateMounts = mounts.filter(mount => mount[0] === '/api/translate');
    assert.equal(translateMounts.length, 1);
    assert.ok(translateMounts[0].includes(legacyProviderGuard), '/api/translate must require an administrator');
});

test('AIBAR routers refuse to mount when CSRF protection is disabled', () => {
    assert.equal(isCsrfProtectionDisabled({ disableCsrf: true }), true);
    assert.equal(isCsrfProtectionDisabled({ disableCsrf: false }), false);

    const source = fs.readFileSync(path.resolve('src/server-startup.js'), 'utf8');
    assert.match(source, /const csrfDisabled = isCsrfProtectionDisabled\(cliArgs\);/);
    assert.match(source, /} else if \(csrfDisabled\) \{[\s\S]*?aibarCsrfRequired\);/);
    assert.ok(
        source.indexOf('aibarCsrfRequired);') < source.indexOf('app.use(\'/api/aibar\', aibarRouter);'),
        'the CSRF stub must short-circuit before the AIBAR routers are mounted',
    );
    assert.match(fs.readFileSync(path.resolve('src/server-main.js'), 'utf8'), /setupPrivateEndpoints\(app, cliArgs\)/);
});

test('story saves cap unbounded fields and reject oversized covers', async () => {
    const result = await invokeRoute(saveStory, {
        story: {
            id: 'capped-story',
            title: 'T'.repeat(5_000),
            summary: 'S'.repeat(100_000),
            characterAvatar,
            world: 'W'.repeat(100_000),
            scenario: 'C'.repeat(100_000),
            openingUserMessage: 'U'.repeat(200_000),
            openingAssistantMessage: 'A'.repeat(200_000),
            systemAppend: 'P'.repeat(200_000),
            coverAssetId: 'i'.repeat(5_000),
            modelProfileId: 'm'.repeat(5_000),
            tags: Array.from({ length: 500 }, (_, index) => `tag-${index}`.padEnd(500, 'x')),
            modIds: Array.from({ length: 500 }, (_, index) => `mod-${index}`.padEnd(500, 'x')),
        },
    });

    assert.equal(result.status, 200);
    const story = result.body;
    assert.equal(story.title.length, 200);
    assert.equal(story.summary.length, 20_000);
    assert.equal(story.world.length, 20_000);
    assert.equal(story.scenario.length, 20_000);
    assert.equal(story.openingUserMessage.length, 50_000);
    assert.equal(story.openingAssistantMessage.length, 50_000);
    assert.equal(story.systemAppend.length, 50_000);
    assert.equal(story.coverAssetId.length, 200);
    assert.equal(story.modelProfileId.length, 200);
    assert.equal(story.tags.length, 50);
    assert.equal(story.tags[0].length, 100);
    assert.equal(story.modIds.length, 50);
    assert.equal(story.modIds[0].length, 200);
    assert.ok(
        Buffer.byteLength(JSON.stringify(story), 'utf8') < 1024 * 1024,
        'a normalized story must stay far below the 500 MB body limit',
    );

    const oversized = await suppressExpectedErrors(() => invokeRoute(saveStory, {
        story: {
            id: 'oversized-cover-story',
            title: 'Oversized cover',
            characterAvatar,
            coverImage: `data:image/png;base64,${'A'.repeat(28 * 1000 * 1000)}`,
        },
    }));
    assert.equal(oversized.status, 413);
    assert.match(String(oversized.body), /20 MB/);
    assert.equal(fs.existsSync(path.join(userRoot, 'aibar', 'stories', 'oversized-cover-story.json')), false);
});

test('chat completion proxy preserves provider usage fields required for billing', () => {
    const source = fs.readFileSync(path.resolve('src/endpoints/backends/chat-completions.js'), 'utf8');
    assert.match(source, /usage:\s*generateResponseJson\.usage/);
    assert.match(source, /usageMetadata:\s*generateResponseJson\.usageMetadata/);
});

test('saved images reject invalid data and payloads above 20 MB', async () => {
    const invalid = await suppressExpectedErrors(() => invokeRoute(saveImage, { image: 'not-base64%%%' }));
    assert.equal(invalid.status, 400);

    const oversized = Buffer.alloc((20 * 1024 * 1024) + 1).toString('base64');
    const result = await suppressExpectedErrors(() => invokeRoute(saveImage, {
        id: 'oversized-image',
        image: oversized,
        format: 'png',
    }));
    assert.equal(result.status, 413);
    assert.match(String(result.body), /20 MB/);
    assert.equal(fs.existsSync(path.join(userRoot, 'aibar', 'images', 'oversized-image.png')), false);
});

test('message estimation includes fields outside message.content', () => {
    assert.equal(typeof estimateInputTokens, 'function', 'aibar-models.js must export estimateInputTokens');
    assert.equal(typeof estimateSettlementInputTokens, 'function', 'aibar-models.js must export estimateSettlementInputTokens');

    const contentOnly = estimateInputTokens([{ content: 'same content' }]);
    const completeMessage = estimateInputTokens([{
        role: 'assistant',
        name: 'tool-runner',
        content: 'same content',
        tool_call_id: 'call_123',
        tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: {
                name: 'lookup',
                arguments: JSON.stringify({ query: 'x'.repeat(400) }),
            },
        }],
    }]);

    assert.ok(completeMessage > contentOnly, `${completeMessage} should exceed ${contentOnly}`);
    const highEntropyMessage = {
        role: 'user',
        content: Buffer.from(Array.from({ length: 512 }, (_, index) => (index * 47) % 256)).toString('base64'),
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(highEntropyMessage), 'utf8');
    assert.ok(estimateInputTokens([highEntropyMessage]) >= serializedBytes);
    assert.ok(estimateSettlementInputTokens([highEntropyMessage]) < estimateInputTokens([highEntropyMessage]));
    assert.equal(estimateInputTokens('高熵\n输入'), Buffer.byteLength(JSON.stringify('高熵\n输入'), 'utf8'));
    assert.equal(estimateSettlementInputTokens('高熵\n输入'), 5);
});

test('settlement can charge beyond an underestimated reservation without consuming other holds', () => {
    const reservedMicros = 100;
    const chargedMicros = determineSettlementCharge(600, 1_000, 200, reservedMicros);
    assert.equal(chargedMicros, 600);
    assert.ok(chargedMicros > reservedMicros);

    assert.equal(determineSettlementCharge(1_200, 1_000, 200, reservedMicros), 900);
});

test('settlement prefers provider usage and does not count wrapped Claude content twice', () => {
    const claude = summarizeCapture({
        body: {
            choices: [{ message: { content: 'abcd' } }],
            content: [{ type: 'text', text: 'abcd' }],
            usage: { input_tokens: 123, output_tokens: 7 },
        },
        chunks: [],
        statusCode: 200,
    }, 999);
    assert.deepEqual(claude, {
        inputTokens: 123,
        outputTokens: 7,
        hasError: false,
        usageReported: true,
    });

    const fallback = summarizeCapture({
        body: {
            choices: [{ message: { content: 'abcd' } }],
            content: [{ type: 'text', text: 'abcd' }],
        },
        chunks: [],
        statusCode: 200,
    }, 5);
    assert.equal(fallback.inputTokens, 5);
    assert.equal(fallback.outputTokens, 1);

    const gemini = summarizeCapture({
        body: {
            choices: [{ message: { content: 'reply' } }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
        },
        chunks: [],
        statusCode: 200,
    }, 99);
    assert.equal(gemini.inputTokens, 9);
    assert.equal(gemini.outputTokens, 4);
});

test('stale cleanup preserves active reservations until the request completes', () => {
    const db = getCommunityDb();
    const usageId = 'active-stale-reservation';
    const handle = 'active-stale-user';
    db.prepare(`
        INSERT INTO point_accounts (user_handle, balance_micros, held_micros, updated_at)
        VALUES (?, 1000, 200, ?)
    `).run(handle, new Date().toISOString());
    db.prepare(`
        INSERT INTO model_usage (
            id, user_handle, model_id, reserved_micros, status, created_at
        ) VALUES (?, ?, 'model', 200, 'reserved', ?)
    `).run(usageId, handle, '2020-01-01T00:00:00.000Z');

    trackActiveReservation(usageId);
    releaseStaleReservations(db);
    assert.equal(db.prepare('SELECT status FROM model_usage WHERE id = ?').get(usageId).status, 'reserved');
    assert.equal(db.prepare('SELECT held_micros FROM point_accounts WHERE user_handle = ?').get(handle).held_micros, 200);

    untrackActiveReservation(usageId);
    releaseStaleReservations(db);
    assert.equal(db.prepare('SELECT status FROM model_usage WHERE id = ?').get(usageId).status, 'failed');
    assert.equal(db.prepare('SELECT held_micros FROM point_accounts WHERE user_handle = ?').get(handle).held_micros, 0);
});

test('shared model source validation rejects providers needing unsupported persisted fields', async () => {
    const accepted = await invokeRoute(saveModel, {
        id: 'accepted-openai',
        name: 'Accepted OpenAI',
        source: 'openai',
        model: 'gpt-test',
    });
    assert.equal(accepted.status, 200);

    const acceptedClaude = await invokeRoute(saveModel, {
        id: 'accepted-claude',
        name: 'Accepted Anthropic',
        source: 'claude',
        model: 'claude-sonnet-4-5',
        endpoint: 'https://anthropic-compatible.example/v1',
    });
    assert.equal(acceptedClaude.status, 200);
    assert.equal(acceptedClaude.body.source, 'claude');
    assert.equal(acceptedClaude.body.endpoint, 'https://anthropic-compatible.example/v1');

    for (const source of ['azure_openai', 'vertexai', 'workers_ai', 'cometapi', 'unknown-provider']) {
        const result = await invokeRoute(saveModel, {
            id: `blocked-${source}`,
            name: `Blocked ${source}`,
            source,
            model: 'model-test',
        });
        assert.equal(result.status, 400, source);
    }
});

test('Claude requests use the native Anthropic endpoint and authentication contract', () => {
    const config = getClaudeApiConfig({
        reverse_proxy: 'https://anthropic-compatible.example/v1/',
        proxy_password: 'anthropic-test-key',
    }, directories);
    assert.deepEqual(config, {
        apiUrl: 'https://anthropic-compatible.example/v1',
        apiKey: 'anthropic-test-key',
        apiKeyHeader: 'x-api-key',
        headers: { 'anthropic-version': '2023-06-01' },
    });
});

test('editing a shared model preserves its credential owner', async () => {
    const id = 'owner-preservation';
    const created = await invokeRoute(saveModel, {
        id,
        name: 'Owner Preservation',
        source: 'openai',
        model: 'gpt-test',
        secretId: 'owner-secret',
    });
    assert.equal(created.status, 200);

    const edited = await invokeRoute(saveModel, {
        id,
        name: 'Edited By Another Admin',
        source: 'openai',
        model: 'gpt-test-2',
        secretId: 'owner-secret',
    }, { handle: 'other-admin', name: 'Other Admin', admin: true });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.canManageCredentials, false);
    assert.equal(Object.hasOwn(edited.body, 'secretId'), false);
    assert.equal(Object.hasOwn(edited.body, 'endpoint'), false);
    assert.equal(getCommunityDb().prepare('SELECT owner_handle FROM shared_models WHERE id = ?').get(id).owner_handle, 'admin');
});

test('shared model credential metadata is visible only to its owner', async () => {
    const id = 'owner-list-isolation';
    const created = await invokeRoute(saveModel, {
        id,
        name: 'Owner List Isolation',
        source: 'openai',
        model: 'gpt-test',
        endpoint: 'https://owner.example/v1?token=private',
        secretId: 'private-secret-id',
    });
    assert.equal(created.body.canManageCredentials, true);
    assert.equal(created.body.secretId, 'private-secret-id');

    const otherAdmin = await invokeRoute(
        listModels,
        {},
        { handle: 'other-admin', name: 'Other Admin', admin: true },
    );
    const redacted = otherAdmin.body.models.find(model => model.id === id);
    assert.equal(redacted.canManageCredentials, false);
    assert.equal(redacted.apiKeySaved, true);
    assert.equal(Object.hasOwn(redacted, 'secretId'), false);
    assert.equal(Object.hasOwn(redacted, 'endpoint'), false);

    const edited = await invokeRoute(saveModel, {
        ...redacted,
        name: 'Safely Edited By Another Admin',
        model: 'gpt-test-2',
    }, { handle: 'other-admin', name: 'Other Admin', admin: true });
    assert.equal(edited.status, 200);
    const stored = getCommunityDb().prepare(`
        SELECT endpoint, secret_id, owner_handle FROM shared_models WHERE id = ?
    `).get(id);
    assert.deepEqual(stored, {
        endpoint: 'https://owner.example/v1?token=private',
        secret_id: 'private-secret-id',
        owner_handle: 'admin',
    });
});

test('another admin cannot redirect credentials owned by the original admin', async () => {
    const id = 'owner-endpoint-isolation';
    const created = await invokeRoute(saveModel, {
        id,
        name: 'Owner Endpoint Isolation',
        source: 'openai',
        model: 'gpt-test',
        endpoint: 'https://owner.example/v1',
        secretId: 'owner-secret',
    });
    assert.equal(created.status, 200);

    const edited = await invokeRoute(saveModel, {
        id,
        name: 'Redirected By Another Admin',
        source: 'openai',
        model: 'gpt-test',
        endpoint: 'https://attacker.example/v1',
        secretId: 'owner-secret',
    }, { handle: 'other-admin', name: 'Other Admin', admin: true });
    assert.equal(edited.status, 403);

    const stored = getCommunityDb().prepare(`
        SELECT endpoint, secret_id, owner_handle FROM shared_models WHERE id = ?
    `).get(id);
    assert.deepEqual(stored, {
        endpoint: 'https://owner.example/v1',
        secret_id: 'owner-secret',
        owner_handle: 'admin',
    });
});

test('registration handles are normalized and bounded', () => {
    assert.equal(normalizeRegistrationHandle('  Alice Smith  '), 'alice-smith');
    assert.equal(normalizeRegistrationHandle('a'.repeat(64)), 'a'.repeat(64));
    assert.equal(normalizeRegistrationHandle('a'.repeat(65)), '');
    assert.equal(normalizeRegistrationHandle('a'.repeat(1_000)), '');
    assert.equal(normalizeRegistrationHandle('../'), '');
});

test('registration rate limiting can distinguish clients behind a reverse proxy', () => {
    const request = {
        headers: { 'x-real-ip': '203.0.113.42' },
        socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(registrationRateLimitKey(request, false), '127.0.0.1');
    assert.equal(registrationRateLimitKey(request, true), '127.0.0.1 (forwarded: 203.0.113.42)');
});

test('registration without an invite creates a pending review request', async () => {
    const body = {
        inviteCode: '',
        handle: 'review-registration-user',
        name: 'Review Registration',
        password: 'password-123',
    };
    const result = await invokeRoute(registerUser, body);
    assert.equal(result.status, 202);
    assert.equal(result.body.status, 'pending');

    const db = getCommunityDb();
    assert.equal(db.prepare(`
        SELECT invite_id FROM registration_requests WHERE id = ?
    `).get(result.body.id).invite_id, null);
    assert.equal(await storage.getItem(`user:${body.handle}`), undefined);
    assert.equal(db.prepare('SELECT 1 FROM point_accounts WHERE user_handle = ?').get(body.handle), undefined);
});

test('concurrent invite registrations create one approved account with initial points', async () => {
    const inviteId = 'registration-race-invite';
    const inviteCode = 'REGISTRATION-RACE';
    insertInvite(inviteId, inviteCode, 2);

    const body = {
        inviteCode,
        handle: 'registration-race-user',
        name: 'Registration Race',
        password: 'password-123',
    };
    const results = await Promise.all([
        invokeRoute(registerUser, body),
        invokeRoute(registerUser, body),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);

    const db = getCommunityDb();
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM registration_requests
        WHERE handle = ? AND status = 'approved'
    `).get(body.handle).count, 1);
    assert.equal(db.prepare('SELECT use_count FROM invites WHERE id = ?').get(inviteId).use_count, 1);
    assert.equal((await storage.getItem(`user:${body.handle}`)).handle, body.handle);
    assert.deepEqual(
        db.prepare(`
            SELECT balance_micros, held_micros FROM point_accounts WHERE user_handle = ?
        `).get(body.handle),
        { balance_micros: 10_000_000_000, held_micros: 0 },
    );
    assert.deepEqual(
        db.prepare(`
            SELECT delta_micros, balance_after_micros, kind
            FROM point_ledger WHERE user_handle = ?
        `).get(body.handle),
        { delta_micros: 10_000_000_000, balance_after_micros: 10_000_000_000, kind: 'signup_bonus' },
    );
});

test('concurrent approval of one request cannot delete the winning account', async () => {
    const inviteId = 'same-request-approval-invite';
    const registrationId = 'same-request-approval';
    const handle = 'same-request-user';
    insertInvite(inviteId, 'SAME-REQUEST-APPROVAL');
    insertRegistration(registrationId, handle, inviteId);

    const results = await suppressExpectedErrors(() => Promise.all([
        invokeRoute(reviewRegistration, { id: registrationId, action: 'approve' }, { handle: 'admin-a', name: 'Admin A', admin: true }),
        invokeRoute(reviewRegistration, { id: registrationId, action: 'approve' }, { handle: 'admin-b', name: 'Admin B', admin: true }),
    ]));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);

    const account = await storage.getItem(`user:${handle}`);
    assert.equal(account.handle, handle);
    assert.equal(account._aibarApprovalClaim, undefined);
    assert.equal(
        getCommunityDb().prepare('SELECT balance_micros FROM point_accounts WHERE user_handle = ?').get(handle).balance_micros,
        10_000_000_000,
    );
    assert.equal(
        getCommunityDb().prepare(`
            SELECT COUNT(*) AS count FROM point_ledger
            WHERE user_handle = ? AND kind = 'signup_bonus'
        `).get(handle).count,
        1,
    );
    assert.deepEqual(
        getCommunityDb().prepare(`
            SELECT status, password_hash, password_salt
            FROM registration_requests WHERE id = ?
        `).get(registrationId),
        { status: 'approved', password_hash: '', password_salt: '' },
    );
});

test('registration rejection clears retained password material', async () => {
    const inviteId = 'rejected-registration-invite';
    const registrationId = 'rejected-registration';
    insertInvite(inviteId, 'REJECTED-REGISTRATION');
    insertRegistration(registrationId, 'rejected-registration-user', inviteId);

    const result = await invokeRoute(reviewRegistration, {
        id: registrationId,
        action: 'reject',
        reviewNote: 'not approved',
    });
    assert.equal(result.status, 200);
    assert.deepEqual(
        getCommunityDb().prepare(`
            SELECT status, password_hash, password_salt
            FROM registration_requests WHERE id = ?
        `).get(registrationId),
        { status: 'rejected', password_hash: '', password_salt: '' },
    );
});

test('the database rejects duplicate active registration handles', () => {
    const inviteId = 'duplicate-handle-approval-invite';
    const handle = 'duplicate-handle-user';
    insertInvite(inviteId, 'DUPLICATE-HANDLE-APPROVAL');
    insertRegistration('duplicate-handle-a', handle, inviteId);
    assert.throws(
        () => insertRegistration('duplicate-handle-b', handle, inviteId),
        error => String(error.code || '').startsWith('SQLITE_CONSTRAINT'),
    );
});

test('registration requests allow review-based submissions without invites', () => {
    const db = getCommunityDb();
    const id = 'registration-without-invite';
    db.prepare(`
        INSERT INTO registration_requests (
            id, handle, name, password_hash, password_salt, invite_id, created_at
        ) VALUES (?, 'registration-without-invite', 'No Invite', 'hash', 'salt', NULL, ?)
    `).run(id, new Date().toISOString());
    assert.equal(db.prepare('SELECT invite_id FROM registration_requests WHERE id = ?').get(id).invite_id, null);
});

test('database migration makes legacy registration invite references optional', () => {
    const databasePath = path.join(testRoot, 'legacy-required-invites.sqlite');
    let db = new Database(databasePath);
    db.exec(`
        CREATE TABLE invites (
            id TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL DEFAULT '',
            created_by TEXT NOT NULL,
            max_uses INTEGER NOT NULL DEFAULT 1,
            use_count INTEGER NOT NULL DEFAULT 0,
            expires_at TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE registration_requests (
            id TEXT PRIMARY KEY,
            handle TEXT NOT NULL,
            name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            invite_id TEXT NOT NULL REFERENCES invites(id),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
            review_note TEXT NOT NULL DEFAULT '',
            reviewed_by TEXT,
            created_at TEXT NOT NULL,
            reviewed_at TEXT
        );
        INSERT INTO invites (id, code_hash, created_by, created_at)
        VALUES ('legacy-required-invite', 'legacy-required-hash', 'admin', '2026-01-01T00:00:00.000Z');
        INSERT INTO registration_requests (
            id, handle, name, password_hash, password_salt, invite_id, created_at
        ) VALUES (
            'legacy-required-registration', 'legacy-required-registration', 'Legacy',
            'hash', 'salt', 'legacy-required-invite', '2026-01-01T00:00:00.000Z'
        );
    `);
    db.close();

    db = createCommunityDatabase(databasePath);
    try {
        assert.equal(
            db.prepare('SELECT invite_id FROM registration_requests WHERE id = ?')
                .get('legacy-required-registration').invite_id,
            'legacy-required-invite',
        );
        db.prepare(`
            INSERT INTO registration_requests (
                id, handle, name, password_hash, password_salt, invite_id, created_at
            ) VALUES ('legacy-review-registration', 'legacy-review-registration', 'Review', 'hash', 'salt', NULL, ?)
        `).run(new Date().toISOString());
    } finally {
        db.close();
    }
});

test('database migration closes historical duplicate active registrations', () => {
    const databasePath = path.join(testRoot, 'legacy-registrations.sqlite');
    let db = createCommunityDatabase(databasePath);
    db.exec('DROP INDEX idx_registrations_active_handle');
    db.prepare(`
        INSERT INTO invites (id, code_hash, label, created_by, max_uses, created_at)
        VALUES ('legacy-invite', 'legacy-hash', '', 'admin', 10, ?)
    `).run(new Date().toISOString());
    const insert = db.prepare(`
        INSERT INTO registration_requests (
            id, handle, name, password_hash, password_salt, invite_id, created_at
        ) VALUES (?, 'legacy-duplicate', 'Legacy', 'hash', 'salt', 'legacy-invite', ?)
    `);
    insert.run('legacy-a', '2026-01-01T00:00:00.000Z');
    insert.run('legacy-b', '2026-01-02T00:00:00.000Z');
    db.close();

    db = createCommunityDatabase(databasePath);
    try {
        const statuses = db.prepare(`
            SELECT status FROM registration_requests WHERE handle = 'legacy-duplicate' ORDER BY id
        `).all().map(row => row.status).sort();
        assert.deepEqual(statuses, ['pending', 'rejected']);
        assert.throws(
            () => db.prepare(`
                INSERT INTO registration_requests (
                    id, handle, name, password_hash, password_salt, invite_id, created_at
                ) VALUES ('legacy-c', 'legacy-duplicate', 'Legacy', 'hash', 'salt', 'legacy-invite', ?)
            `).run(new Date().toISOString()),
            error => String(error.code || '').startsWith('SQLITE_CONSTRAINT'),
        );
    } finally {
        db.close();
    }
});

test('database migration erases credentials from historical reviewed registrations', () => {
    const databasePath = path.join(testRoot, 'legacy-reviewed-registration.sqlite');
    let db = createCommunityDatabase(databasePath);
    db.prepare(`
        INSERT INTO invites (id, code_hash, label, created_by, max_uses, created_at)
        VALUES ('reviewed-invite', 'reviewed-hash', '', 'admin', 10, ?)
    `).run(new Date().toISOString());
    db.prepare(`
        INSERT INTO registration_requests (
            id, handle, name, password_hash, password_salt, invite_id,
            status, reviewed_by, created_at, reviewed_at
        ) VALUES (
            'legacy-reviewed', 'legacy-reviewed', 'Legacy', 'old-hash', 'old-salt',
            'reviewed-invite', 'approved', 'admin', ?, ?
        )
    `).run(new Date().toISOString(), new Date().toISOString());
    db.close();

    db = createCommunityDatabase(databasePath);
    try {
        assert.deepEqual(
            db.prepare(`
                SELECT password_hash, password_salt
                FROM registration_requests WHERE id = 'legacy-reviewed'
            `).get(),
            { password_hash: '', password_salt: '' },
        );
    } finally {
        db.close();
    }
});

test('failed approval provisioning rolls back only its claimed account and directory', async () => {
    const inviteId = 'failed-approval-invite';
    const registrationId = 'failed-approval';
    const handle = 'failed-approval-user';
    const accountRoot = path.join(testRoot, handle);
    const expectedSettingsPath = path.join(accountRoot, 'settings.json');
    insertInvite(inviteId, 'FAILED-APPROVAL');
    insertRegistration(registrationId, handle, inviteId);

    const originalExistsSync = fs.existsSync;
    fs.existsSync = target => target === expectedSettingsPath ? false : originalExistsSync(target);
    let result;
    try {
        result = await suppressExpectedErrors(() => invokeRoute(
            reviewRegistration,
            { id: registrationId, action: 'approve' },
            { handle: 'admin-a', name: 'Admin A', admin: true },
        ));
    } finally {
        fs.existsSync = originalExistsSync;
    }

    assert.equal(result.status, 400);
    assert.equal(await storage.getItem(`user:${handle}`), undefined);
    assert.equal(fs.existsSync(accountRoot), false);
    const registration = getCommunityDb().prepare(`
        SELECT status, reviewed_at FROM registration_requests WHERE id = ?
    `).get(registrationId);
    assert.equal(registration.status, 'pending');
    assert.equal(registration.reviewed_at, null);
    assert.equal(getCommunityDb().prepare('SELECT 1 FROM point_accounts WHERE user_handle = ?').get(handle), undefined);
});

test('failed invite registration returns its invite use and leaves no account or points', async () => {
    const inviteId = 'failed-invite-registration-invite';
    const inviteCode = 'FAILED-INVITE-REGISTRATION';
    const handle = 'failed-invite-registration-user';
    const accountRoot = path.join(testRoot, handle);
    const expectedSettingsPath = path.join(accountRoot, 'settings.json');
    insertInvite(inviteId, inviteCode, 1);

    const originalExistsSync = fs.existsSync;
    fs.existsSync = target => target === expectedSettingsPath ? false : originalExistsSync(target);
    let result;
    try {
        result = await suppressExpectedErrors(() => invokeRoute(registerUser, {
            inviteCode,
            handle,
            name: 'Failed Invite Registration',
            password: 'password-123',
        }));
    } finally {
        fs.existsSync = originalExistsSync;
    }

    assert.equal(result.status, 500);
    assert.equal(await storage.getItem(`user:${handle}`), undefined);
    assert.equal(fs.existsSync(accountRoot), false);
    assert.equal(getCommunityDb().prepare('SELECT use_count FROM invites WHERE id = ?').get(inviteId).use_count, 0);
    assert.equal(getCommunityDb().prepare('SELECT 1 FROM registration_requests WHERE handle = ?').get(handle), undefined);
    assert.equal(getCommunityDb().prepare('SELECT 1 FROM point_accounts WHERE user_handle = ?').get(handle), undefined);
});

test('Discord import batches validate provenance and register idempotently', async () => {
    const manifest = discordManifest({
        threadId: '1478612237869519201',
        syncedAt: '2026-08-03T01:00:00.000Z',
        period: 'previous-day',
        filters: { tags: ['中文', '剧情'], tagMatch: 'all' },
    });
    const invalid = await suppressExpectedErrors(() => invokeRoute(registerDiscordBatch, {
        manifest: { ...manifest, guildId: '1478612237869519299' },
    }));
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /来源/);

    const created = await invokeRoute(registerDiscordBatch, { manifest });
    assert.equal(created.status, 201);
    assert.equal(created.body.items.length, 1);
    assert.equal(created.body.items[0].status, 'queued');
    assert.equal(created.body.manifest.period, 'previous-day');
    assert.deepEqual(created.body.manifest.filters, { tags: ['中文', '剧情'], tagMatch: 'all' });

    const mismatchedFilters = await suppressExpectedErrors(() => invokeRoute(registerDiscordBatch, {
        manifest: { ...manifest, syncedAt: '2026-08-03T01:01:00.000Z', filters: { tags: ['原创'], tagMatch: 'any' } },
    }));
    assert.equal(mismatchedFilters.status, 400);
    assert.match(mismatchedFilters.body.error, /筛选条件/);

    const repeated = await invokeRoute(registerDiscordBatch, { manifest });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.id, created.body.id);
    assert.equal(getCommunityDb().prepare(`
        SELECT COUNT(*) AS count FROM discord_import_items WHERE batch_id = ?
    `).get(created.body.id).count, 1);
});

test('Discord imports store trusted hashes, publish versions, and deduplicate cross-posts', async () => {
    const firstManifest = discordManifest({
        threadId: '1478612237869519202',
        syncedAt: '2026-08-03T02:00:00.000Z',
        title: 'Discord Imported Work',
    });
    const firstBatch = await invokeRoute(registerDiscordBatch, { manifest: firstManifest });
    const firstItem = firstBatch.body.items[0];
    const firstBytes = Buffer.from('discord-card-version-one');
    const firstHash = crypto.createHash('sha256').update(firstBytes).digest('hex');
    const foreignUpload = await uploadDiscordTestFile(
        firstItem.id,
        firstBytes,
        'card.png',
        { handle: 'other-admin', name: 'Other Admin', admin: true },
    );
    assert.equal(foreignUpload.status, 404);
    assert.equal(getCommunityDb().prepare(`
        SELECT status FROM discord_import_items WHERE id = ?
    `).get(firstItem.id).status, 'queued');

    const firstUpload = await uploadDiscordTestFile(firstItem.id, firstBytes);
    assert.equal(firstUpload.status, 200);
    assert.equal(firstUpload.body.status, 'validated');
    assert.equal(firstUpload.body.fileSha256, firstHash);
    const repeatedValidatedBatch = await invokeRoute(registerDiscordBatch, { manifest: firstManifest });
    assert.equal(repeatedValidatedBatch.body.items[0].status, 'validated');
    const storedAsset = getCommunityDb().prepare(`
        SELECT raw_asset_path FROM discord_import_items WHERE id = ?
    `).get(firstItem.id).raw_asset_path;
    assert.equal(fs.readFileSync(path.join(testRoot, '_aibar', storedAsset)).toString(), firstBytes.toString());

    const firstPublish = await invokeRoute(publishDiscordItem, { sourceId: characterAvatar }, undefined, {
        params: { itemId: firstItem.id },
    });
    assert.equal(firstPublish.status, 201);
    assert.equal(firstPublish.body.item.status, 'published');
    assert.equal(firstPublish.body.work.versionNumber, 1);
    const firstWorkId = firstPublish.body.work.id;
    const firstVersionId = firstPublish.body.item.workVersionId;
    const firstSnapshot = JSON.parse(getCommunityDb().prepare(`
        SELECT payload_json FROM work_versions WHERE id = ?
    `).get(firstVersionId).payload_json);
    assert.equal(firstSnapshot.externalSource.provider, 'discord');
    assert.equal(firstSnapshot.externalSource.fileSha256, firstHash);
    assert.equal(firstSnapshot.externalSource.threadId, firstManifest.cards[0].threadId);
    const repeatedPublish = await invokeRoute(publishDiscordItem, { sourceId: characterAvatar }, undefined, {
        params: { itemId: firstItem.id },
    });
    assert.equal(repeatedPublish.status, 200);
    assert.equal(repeatedPublish.body.work.id, firstWorkId);
    assert.equal(getCommunityDb().prepare(`
        SELECT COUNT(*) AS count FROM work_versions WHERE work_id = ?
    `).get(firstWorkId).count, 1);

    const updateManifest = discordManifest({
        threadId: firstManifest.cards[0].threadId,
        syncedAt: '2026-08-03T03:00:00.000Z',
        title: 'Discord Imported Work v2',
    });
    const updateBatch = await invokeRoute(registerDiscordBatch, { manifest: updateManifest });
    const updateItem = updateBatch.body.items[0];
    await uploadDiscordTestFile(updateItem.id, Buffer.from('discord-card-version-two'));
    const updatedPublish = await invokeRoute(publishDiscordItem, { sourceId: characterAvatar }, undefined, {
        params: { itemId: updateItem.id },
    });
    assert.equal(updatedPublish.status, 200);
    assert.equal(updatedPublish.body.work.id, firstWorkId);
    assert.equal(updatedPublish.body.work.versionNumber, 2);

    const mirrorManifest = discordManifest({
        threadId: '1478612237869519203',
        syncedAt: '2026-08-03T04:00:00.000Z',
        title: 'Mirrored Discord Work',
    });
    const mirrorBatch = await invokeRoute(registerDiscordBatch, { manifest: mirrorManifest });
    const mirrorItem = mirrorBatch.body.items[0];
    await uploadDiscordTestFile(mirrorItem.id, firstBytes);
    const duplicatePublish = await invokeRoute(publishDiscordItem, { sourceId: characterAvatar }, undefined, {
        params: { itemId: mirrorItem.id },
    });
    assert.equal(duplicatePublish.status, 200);
    assert.equal(duplicatePublish.body.item.status, 'duplicate');
    assert.equal(duplicatePublish.body.item.workId, firstWorkId);
    assert.equal(duplicatePublish.body.item.workVersionId, firstVersionId);
    assert.equal(getCommunityDb().prepare('SELECT COUNT(*) AS count FROM works WHERE id = ?').get(firstWorkId).count, 1);
});

test('story publication rejects missing and invalid MOD snapshots', async () => {
    for (const sourceId of ['missing-mod-story', 'invalid-mod-story']) {
        const result = await suppressExpectedErrors(() => invokeRoute(publishWork, {
            sourceType: 'story',
            sourceId,
            title: sourceId,
        }));
        assert.equal(result.status, 400, sourceId);
        assert.match(result.body.error, /MOD|提示词/);
    }
});

test('community character publication creates and serves an immutable WebP preview', async () => {
    const published = await invokeRoute(publishWork, {
        sourceType: 'character',
        sourceId: characterAvatar,
        title: 'Preview Character',
    });
    assert.equal(published.status, 201);

    const previewPath = communityCoverPreviewPath(published.body.id, published.body.latestVersionId);
    assert.equal(fs.existsSync(previewPath), true);
    const preview = fs.readFileSync(previewPath);
    const original = fs.readFileSync(path.join(directories.characters, characterAvatar));
    const dimensions = sizeOf(preview);
    assert.equal(preview.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(preview.subarray(8, 12).toString('ascii'), 'WEBP');
    assert.deepEqual({ width: dimensions.width, height: dimensions.height }, { width: 384, height: 512 });
    assert.ok(preview.length < original.length);

    const asset = await invokeRoute(getWorkVersion, {}, undefined, {
        params: { versionId: published.body.latestVersionId, kind: 'asset' },
    });
    assert.match(asset.body, /character\.png$/);

    fs.unlinkSync(previewPath);
    const cover = await invokeRoute(getWorkVersion, {}, undefined, {
        params: { versionId: published.body.latestVersionId, kind: 'cover' },
    });
    assert.equal(cover.status, 200);
    assert.equal(cover.body, previewPath);
    assert.equal(cover.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(fs.existsSync(previewPath), true);

    assert.equal((await invokeRoute(deleteWork, { id: published.body.id })).status, 204);
    assert.equal(fs.existsSync(previewPath), false);
});

test('hidden community works enforce author and administrator governance', async () => {
    const author = { handle: 'community-author', name: 'Community Author', admin: false };
    const outsider = { handle: 'community-outsider', name: 'Community Outsider', admin: false };
    const administrator = { handle: 'community-admin', name: 'Community Admin', admin: true };
    const published = await invokeRoute(publishWork, {
        sourceType: 'mod',
        sourceId: 'valid-mod',
        title: 'Governed Work',
    }, author);
    assert.equal(published.status, 201);
    assert.equal(published.body.canManage, true);

    const forbiddenStatus = await invokeRoute(setWorkStatus, {
        id: published.body.id,
        status: 'hidden',
    }, outsider);
    assert.equal(forbiddenStatus.status, 403);

    const hidden = await invokeRoute(setWorkStatus, {
        id: published.body.id,
        status: 'hidden',
    }, author);
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.status, 'hidden');

    const publicList = await invokeRoute(listWorks, {}, outsider);
    assert.equal(publicList.body.works.some(work => work.id === published.body.id), false);
    const authorList = await invokeRoute(listWorks, { mineOnly: true }, author);
    assert.equal(authorList.body.works.find(work => work.id === published.body.id)?.status, 'hidden');
    const moderationList = await invokeRoute(listWorks, { includeHidden: true }, administrator);
    assert.equal(moderationList.body.works.find(work => work.id === published.body.id)?.canManage, true);

    assert.equal((await invokeRoute(getWork, { id: published.body.id }, outsider)).status, 404);
    assert.equal((await invokeRoute(getWork, { id: published.body.id }, author)).status, 200);
    assert.equal((await invokeRoute(getWorkVersion, {}, outsider, {
        params: { versionId: published.body.latestVersionId, kind: 'asset' },
    })).status, 404);

    const republished = await invokeRoute(publishWork, {
        sourceType: 'mod',
        sourceId: 'valid-mod',
        workId: published.body.id,
        title: 'Governed Work v2',
    }, author);
    assert.equal(republished.status, 200);
    assert.equal(republished.body.status, 'published');

    const hiddenByAdmin = await invokeRoute(setWorkStatus, {
        id: published.body.id,
        status: 'hidden',
    }, administrator);
    assert.equal(hiddenByAdmin.status, 200);
    assert.equal(hiddenByAdmin.body.canManage, true);
    assert.equal((await invokeRoute(deleteWork, { id: published.body.id }, outsider)).status, 403);
    assert.equal((await invokeRoute(deleteWork, { id: published.body.id }, administrator)).status, 204);
    assert.equal(getCommunityDb().prepare('SELECT 1 FROM works WHERE id = ?').get(published.body.id), undefined);
});

test('story publication rejects missing and invalid world dependencies', async () => {
    for (const sourceId of ['missing-world-story', 'invalid-world-story']) {
        const result = await suppressExpectedErrors(() => invokeRoute(publishWork, {
            sourceType: 'story',
            sourceId,
            title: sourceId,
        }));
        assert.equal(result.status, 400, sourceId);
        assert.match(result.body.error, /世界书|JSON/);
    }
});

test('story launch returns the installed MOD snapshots', async () => {
    const published = await invokeRoute(publishWork, {
        sourceType: 'story',
        sourceId: 'valid-mod-story',
        title: 'Valid MOD Story',
    });
    assert.equal(published.status, 201);

    const launched = await invokeRoute(launchWork, { id: published.body.id });
    assert.equal(launched.status, 201);
    assert.equal(fs.existsSync(path.join(directories.thumbnailsAvatar, launched.body.avatar)), true);
    assert.deepEqual(launched.body.story.modIds, ['valid-mod']);
    assert.equal(launched.body.installedMods.length, 1);
    assert.deepEqual(launched.body.installedMods[0], settings.aibar.simple_ui_mods[0]);
});

test('story launch rejects an old snapshot with a missing world dependency', async () => {
    const published = await invokeRoute(publishWork, {
        sourceType: 'story',
        sourceId: 'valid-world-story',
        title: 'Missing Snapshot World',
    });
    assert.equal(published.status, 201);

    const db = getCommunityDb();
    const work = db.prepare('SELECT latest_version_id FROM works WHERE id = ?').get(published.body.id);
    const version = db.prepare('SELECT payload_json FROM work_versions WHERE id = ?').get(work.latest_version_id);
    const snapshot = JSON.parse(version.payload_json);
    delete snapshot.dependencies.world;
    db.prepare('UPDATE work_versions SET payload_json = ? WHERE id = ?')
        .run(JSON.stringify(snapshot), work.latest_version_id);

    const launched = await suppressExpectedErrors(() => invokeRoute(launchWork, { id: published.body.id }));
    assert.equal(launched.status, 400);
    assert.match(launched.body.error, /世界书/);
});

test('launch database failure rolls back MOD and story filesystem changes', async () => {
    const sources = [
        { sourceType: 'mod', sourceId: 'valid-mod', title: 'Rollback MOD Launch' },
        { sourceType: 'story', sourceId: 'valid-world-story', title: 'Rollback Story Launch' },
    ];

    for (const source of sources) {
        const published = await invokeRoute(publishWork, source);
        assert.equal(published.status, 201, source.sourceType);

        const db = getCommunityDb();
        const beforeTree = snapshotTree(userRoot);
        const beforeLaunches = db.prepare('SELECT COUNT(*) AS count FROM launch_events').get().count;
        db.exec(`
            CREATE TRIGGER fail_launch_insert
            BEFORE INSERT ON launch_events
            BEGIN
                SELECT RAISE(ABORT, 'injected launch insert failure');
            END;
        `);

        let launched;
        try {
            launched = await suppressExpectedErrors(() => invokeRoute(launchWork, { id: published.body.id }));
        } finally {
            db.exec('DROP TRIGGER fail_launch_insert');
        }

        assert.equal(launched.status, 400, source.sourceType);
        assert.deepEqual(snapshotTree(userRoot), beforeTree, source.sourceType);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM launch_events').get().count, beforeLaunches, source.sourceType);
    }
});

test('publish finalization failure leaves no committed database rows', async (t) => {
    const originalChmodSync = fs.chmodSync;
    let injected = false;
    fs.chmodSync = (target, mode) => {
        if (!injected && mode === 0o444) {
            injected = true;
            throw new Error('injected publish finalization failure');
        }
        return originalChmodSync(target, mode);
    };
    t.after(() => { fs.chmodSync = originalChmodSync; });

    const title = 'Rollback Probe';
    const result = await suppressExpectedErrors(() => invokeRoute(publishWork, {
        sourceType: 'mod',
        sourceId: 'valid-mod',
        title,
    }));
    assert.equal(result.status, 400);
    assert.equal(injected, true);

    const db = getCommunityDb();
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM works WHERE title = ?').get(title).count, 0);
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM work_versions v
        LEFT JOIN works w ON w.id = v.work_id
        WHERE v.title = ? OR w.id IS NULL
    `).get(title).count, 0);
});
