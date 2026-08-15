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
    { router: aibarRouter, validateDiscordAttachmentUrl },
    { getChatDataStrict },
    { isCsrfProtectionDisabled, setupPrivateEndpoints },
    { getClaudeApiConfig },
    { createUserRateLimiter },
    { publicError },
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
    import('../src/aibar-rate-limit.js'),
    import('../src/aibar-errors.js'),
]);

globalThis.DATA_ROOT = path.relative(process.cwd(), testRoot);
assert.equal(getCommunityRoot(), path.join(testRoot, '_aibar'));
globalThis.DATA_ROOT = testRoot;

const {
    determineReservationMicros,
    determineSettlementCharge,
    estimateInputTokens,
    estimateSettlementInputTokens,
    isSupportedSharedModelSource,
    legacyProviderGuard,
    releaseStaleReservations,
    router: modelsRouter,
    settleGeneration,
    sharedModelGuard,
    summarizeCapture,
    trackActiveReservation,
    untrackActiveReservation,
    validateGenerationMessages,
} = modelsModule;
const { charaFormatData } = await import('../src/endpoints/characters.js');
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

// aibar-community.js 通过 router.use() 合并 Discord 导入与注册审核子 router，路由层可能嵌套一层，这里递归查找。
function findRouteLayer(router, routePath, method) {
    for (const layer of router.stack) {
        if (layer.route?.path === routePath && layer.route.methods[method]) return layer;
        if (!layer.route && Array.isArray(layer.handle?.stack)) {
            const nested = findRouteLayer(layer.handle, routePath, method);
            if (nested) return nested;
        }
    }
    return undefined;
}

function getRouteHandler(router, routePath) {
    const routeLayer = findRouteLayer(router, routePath, 'post');
    assert.ok(routeLayer, `missing POST route ${routePath}`);
    return routeLayer.route.stack.at(-1).handle;
}

function getGetRouteHandler(router, routePath) {
    const routeLayer = findRouteLayer(router, routePath, 'get');
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

test('editing a Tavern Card V3 preserves its spec and executable extension payload', () => {
    const original = {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        vendor_extension: { keep: true },
        data: {
            name: 'Complex card',
            description: 'before',
            personality: '',
            scenario: '',
            first_mes: 'start',
            mes_example: '',
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: '',
            character_version: '1',
            alternate_greetings: [],
            character_book: { entries: [{ content: 'state' }] },
            extensions: {
                tavern_helper: { scripts: [{ name: 'MVU', content: 'initialize()' }] },
                regex_scripts: [{ script_name: 'render' }],
            },
        },
    };

    const edited = charaFormatData({
        json_data: JSON.stringify(original),
        ch_name: 'Complex card',
        description: 'after',
        personality: '',
        scenario: '',
        first_mes: 'start',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: '',
        character_version: '2',
        alternate_greetings: [],
    }, directories);

    assert.equal(edited.spec, 'chara_card_v3');
    assert.equal(edited.spec_version, '3.0');
    assert.equal(edited.data.description, 'after');
    assert.deepEqual(edited.data.character_book, original.data.character_book);
    assert.deepEqual(edited.data.extensions.tavern_helper, original.data.extensions.tavern_helper);
    assert.deepEqual(edited.data.extensions.regex_scripts, original.data.extensions.regex_scripts);
    assert.deepEqual(edited.vendor_extension, { keep: true });
});

test('the ST compatibility entry point cache-busts the module graph and bypasses onboarding only with approval', () => {
    const indexHtml = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
    const clientScript = fs.readFileSync(path.resolve('public/script.js'), 'utf8');

    assert.match(indexHtml, /"\/script\.js": "\/script\.js\?v=aibar-compat-3"/);
    assert.match(indexHtml, /"\/lib\.js": "\/lib\.js\?v=aibar-compat-3"/);
    assert.match(indexHtml, /src="script\.js\?v=aibar-compat-3"/);
    assert.match(clientScript, /from '\.\/lib\.js';/);
    assert.match(clientScript, /if \(firstRun && !hasValidAibarCompatibilityApproval\(\)\)/);
    assert.match(clientScript, /getAibarCompatibilityApproval\(\{ consume: true \}\)/);
});
const registerUser = getRouteHandler(publicModule.router, '/register');
const saveImage = getRouteHandler(aibarRouter, '/images/save');
const saveStory = getRouteHandler(aibarRouter, '/stories/save');
const listStories = getRouteHandler(aibarRouter, '/stories/list');
const generateShared = getRouteHandler(modelsRouter, '/models/generate');
const listWorks = getRouteHandler(communityRouter, '/works/list');
const getWork = getRouteHandler(communityRouter, '/works/get');
const publishWork = getRouteHandler(communityRouter, '/works/publish');
const publishDiscordWork = getRouteHandler(communityRouter, '/works/publish-discord');
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
    { params = {}, file = undefined, userDirectories = directories } = {},
) {
    const request = {
        body: requestBody,
        params,
        file,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        user: {
            profile,
            directories: userDirectories,
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

test('every legacy provider route registers its guard before the upstream router', async () => {
    const { AIBAR_LEGACY_PROVIDER_ROUTES } = await import('../src/aibar-guards.js');
    const { requireAdminMiddleware } = await import('../src/users.js');
    const mounts = [];
    const fakeApp = {
        use(...args) {
            mounts.push(args);
        },
    };
    await suppressExpectedErrors(() => setupPrivateEndpoints(fakeApp, { disableCsrf: false }));

    // guard 由 applyAibarProviderGuards 预挂载，必须先于上游 router 注册；
    // 两次挂载缺一（guard 丢失或 router 丢失）都意味着权限回归或路由失效。
    for (const route of AIBAR_LEGACY_PROVIDER_ROUTES) {
        const routeMounts = mounts.filter(mount => mount[0] === route);
        assert.ok(routeMounts.length >= 2, `${route} must mount both the guard and the upstream router`);
        assert.ok(routeMounts[0].includes(legacyProviderGuard), `${route} must be guarded before its router`);
    }
    const secretsMounts = mounts.filter(mount => mount[0] === '/api/secrets');
    assert.ok(secretsMounts.length >= 2, '/api/secrets must mount both the admin guard and the upstream router');
    assert.ok(secretsMounts[0].includes(requireAdminMiddleware), '/api/secrets must require an administrator');
    const chatCompletionMounts = mounts.filter(mount => mount[0] === '/api/backends/chat-completions');
    assert.ok(chatCompletionMounts[0].includes(sharedModelGuard), 'chat completions must sit behind sharedModelGuard');
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

test('saved images reject non-image bytes regardless of the declared format', async () => {
    // 合法 base64 但不是 PNG/JPG/WebP 魔数开头
    const notAnImage = Buffer.from('<script>alert(1)</script>' + 'x'.repeat(64)).toString('base64');
    const rejected = await suppressExpectedErrors(() => invokeRoute(saveImage, {
        id: 'not-an-image',
        image: notAnImage,
        format: 'png',
    }));
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.body), /PNG/);
    assert.equal(fs.existsSync(path.join(userRoot, 'aibar', 'images', 'not-an-image.png')), false);

    // 真实 PNG：落盘扩展名按魔数取 png，与声明格式一致
    const realPng = fs.readFileSync(path.resolve('default/content/default_Seraphina.png'));
    const accepted = await invokeRoute(saveImage, {
        id: 'real-png',
        image: realPng.toString('base64'),
        format: 'jpg',
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.format, 'png');
    assert.equal(accepted.body.fileName, 'real-png.png');
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

test('reservation holds the byte upper bound when affordable and falls back to the realistic estimate', () => {
    assert.equal(typeof determineReservationMicros, 'function', 'aibar-models.js must export determineReservationMicros');

    // 余额充足：按保守上限冻结，覆盖高熵内容
    assert.equal(determineReservationMicros(1_000, 300, 5_000), 1_000);
    // 上限冻不住但现实成本付得起：放行并冻结全部可用余额，而不是拒绝
    assert.equal(determineReservationMicros(1_000, 300, 400), 400);
    assert.equal(determineReservationMicros(1_000, 300, 300), 300);
    // 连现实成本都不够：拒绝
    assert.equal(determineReservationMicros(1_000, 300, 299), null);
    assert.equal(determineReservationMicros(1_000, 300, 0), null);
    // 边界：非法输入按 0 处理，现实成本与可用余额同为 0 时放行 0 冻结
    assert.equal(determineReservationMicros(NaN, NaN, NaN), 0);
    assert.equal(determineReservationMicros(0, 0, 0), 0);
});

test('settlement prefers provider usage and does not count wrapped Claude content twice', () => {
    const claude = summarizeCapture({
        body: {
            choices: [{ message: { content: 'abcd' } }],
            content: [{ type: 'text', text: 'abcd' }],
            usage: { input_tokens: 123, output_tokens: 7 },
        },
        chunks: [],
        capturedBytes: 10,
        statusCode: 200,
    }, 999);
    assert.deepEqual(claude, {
        inputTokens: 123,
        outputTokens: 7,
        truncated: false,
        hasError: false,
        hasContent: true,
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

test('summarizeCapture flags truncated captures so settlement can fall back to the requested cap', () => {
    const truncated = summarizeCapture({
        body: { choices: [{ message: { content: 'partial' } }] },
        chunks: [],
        capturedBytes: 8 * 1024 * 1024,
        statusCode: 200,
    }, 10);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.usageReported, false);

    // 提供商上报了用量时截断标记仍在，但结算端会优先采用上报值
    const truncatedWithUsage = summarizeCapture({
        body: {
            choices: [{ message: { content: 'partial' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
        },
        chunks: [],
        capturedBytes: 8 * 1024 * 1024,
        statusCode: 200,
    }, 10);
    assert.equal(truncatedWithUsage.truncated, true);
    assert.equal(truncatedWithUsage.usageReported, true);
    assert.equal(truncatedWithUsage.outputTokens, 2);
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
    // 模拟版本化迁移引入之前的历史库：游标拨回 2，重开时应重放去重迁移。
    db.pragma('user_version = 2');
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

test('manual Discord publication creates one public work and deduplicates by server-side PNG hash', async () => {
    const firstSource = {
        guildId: DISCORD_TEST_GUILD_ID,
        channelId: '1478601254312874024',
        threadId: '1478612237869519301',
        cardId: '1478612237869519301',
        sourceUrl: `https://discord.com/channels/${DISCORD_TEST_GUILD_ID}/1478612237869519301`,
        title: 'Manual Discord Public Work',
        authorName: 'Discord Author',
        tags: ['中文', '剧情'],
    };
    const sourceBytes = fs.readFileSync(path.join(directories.characters, characterAvatar));
    const trustedHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');

    const firstPublish = await invokeRoute(publishDiscordWork, {
        sourceId: characterAvatar,
        source: firstSource,
    });
    assert.equal(firstPublish.status, 201);
    assert.equal(firstPublish.body.status, 'published');
    assert.equal(firstPublish.body.work.status, 'published');
    assert.equal(firstPublish.body.work.versionNumber, 1);
    const firstWorkId = firstPublish.body.work.id;
    const firstSnapshot = JSON.parse(getCommunityDb().prepare(`
        SELECT payload_json FROM work_versions WHERE id = ?
    `).get(firstPublish.body.versionId).payload_json);
    assert.equal(firstSnapshot.externalSource.provider, 'discord');
    assert.equal(firstSnapshot.externalSource.fileSha256, trustedHash);
    assert.equal(firstSnapshot.externalSource.channelId, firstSource.channelId);
    // 查重走索引列而不是 json_extract 全表扫描：发布后两列都必须落库
    const indexed = getCommunityDb().prepare(`
        SELECT external_sha256, external_thread_key FROM work_versions WHERE id = ?
    `).get(firstPublish.body.versionId);
    assert.equal(indexed.external_sha256, trustedHash);
    assert.equal(indexed.external_thread_key, `${firstSource.guildId}:${firstSource.channelId}:${firstSource.threadId}@admin`);

    const duplicatePublish = await invokeRoute(publishDiscordWork, {
        sourceId: characterAvatar,
        source: {
            ...firstSource,
            threadId: '1478612237869519302',
            cardId: '1478612237869519302',
            sourceUrl: `https://discord.com/channels/${DISCORD_TEST_GUILD_ID}/1478612237869519302`,
            title: 'Mirrored Manual Discord Work',
        },
    });
    assert.equal(duplicatePublish.status, 200);
    assert.equal(duplicatePublish.body.status, 'duplicate');
    assert.equal(duplicatePublish.body.work.id, firstWorkId);
    assert.equal(getCommunityDb().prepare(`
        SELECT COUNT(*) AS count FROM work_versions WHERE work_id = ?
    `).get(firstWorkId).count, 1);
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

        // 注入的 SQLite 故障属于内部错误，publicErrorStatus 应给出 500 而非 400。
        assert.equal(launched.status, 500, source.sourceType);
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

test('the per-user rate limiter rejects excess requests with 429 and isolates users', async () => {
    const limiter = createUserRateLimiter({ points: 2, duration: 60, message: '测试限流' });
    const run = async (handle) => {
        const result = { status: 200, body: null, headers: {}, nextCalls: 0 };
        const response = {
            headersSent: false,
            set(name, value) {
                result.headers[String(name).toLowerCase()] = String(value);
                return this;
            },
            status(value) {
                result.status = value;
                return this;
            },
            json(value) {
                result.body = value;
                return this;
            },
        };
        await limiter({ user: { profile: { handle } } }, response, () => { result.nextCalls += 1; });
        return result;
    };

    assert.equal((await run('rate-limit-user')).nextCalls, 1);
    assert.equal((await run('rate-limit-user')).nextCalls, 1);
    const limited = await run('rate-limit-user');
    assert.equal(limited.status, 429);
    assert.equal(limited.nextCalls, 0);
    assert.match(limited.body.error, /测试限流/);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await run('other-rate-limit-user')).nextCalls, 1, 'other users must not share the budget');
});

test('expensive AIBAR routes are mounted behind per-user rate limiters', () => {
    const guardedRoutes = [
        [modelsRouter, '/models/generate'],
        [modelsRouter, '/points/redeem'],
        [aibarRouter, '/discord-import/fetch'],
        [aibarRouter, '/images/save'],
        [communityRouter, '/works/publish'],
        [communityRouter, '/works/launch'],
        [communityRouter, '/works/comments/add'],
    ];
    for (const [router, routePath] of guardedRoutes) {
        const layer = findRouteLayer(router, routePath, 'post');
        assert.ok(layer, routePath);
        assert.ok(layer.route.stack.length >= 2, `${routePath} must have a middleware in front of the handler`);
        assert.equal(layer.route.stack[0].handle.name, 'userRateLimit', routePath);
    }
});

test('the story list skips corrupt files, strips oversized covers, and caps at 200 items', async () => {
    const storiesDirectory = path.join(userRoot, 'aibar', 'stories');
    fs.writeFileSync(path.join(storiesDirectory, 'corrupt-story.json'), '{ not json', 'utf8');
    fs.writeFileSync(path.join(storiesDirectory, 'big-cover-story.json'), JSON.stringify({
        id: 'big-cover-story',
        title: 'Big Cover',
        characterAvatar,
        updatedAt: '2099-01-01T00:00:00.000Z',
        coverImage: `data:image/png;base64,${'A'.repeat(70_000)}`,
    }), 'utf8');

    const listed = await suppressExpectedErrors(() => invokeRoute(listStories, {}));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.some(story => story.id === 'corrupt-story'), false, 'corrupt stories must be skipped');
    assert.equal(listed.body.find(story => story.id === 'big-cover-story').coverImage, '', 'oversized covers must be stripped');
    assert.equal(listed.body.some(story => story.id === 'valid-mod-story'), true, 'valid stories must still be listed');

    for (let index = 0; index < 210; index += 1) {
        fs.writeFileSync(
            path.join(storiesDirectory, `bulk-story-${index}.json`),
            JSON.stringify({ id: `bulk-story-${index}`, title: 'Bulk', characterAvatar }),
            'utf8',
        );
    }
    const capped = await suppressExpectedErrors(() => invokeRoute(listStories, {}));
    assert.equal(capped.status, 200);
    assert.equal(capped.body.length, 200);
});

test('shared generation rejects oversized or malformed message payloads', async () => {
    assert.equal(validateGenerationMessages([{ role: 'user', content: 'hi' }]), null);
    assert.equal(validateGenerationMessages('prompt'), null);
    assert.match(validateGenerationMessages(Array.from({ length: 401 }, () => ({ content: 'x' }))), /上限/);
    assert.match(validateGenerationMessages([42]), /无效/);
    assert.match(validateGenerationMessages(null), /消息列表/);
    assert.match(validateGenerationMessages([{ content: 'y'.repeat(400_001) }]), /长度上限/);

    const tooMany = await suppressExpectedErrors(() => invokeRoute(generateShared, {
        aibar_model_id: 'any',
        messages: Array.from({ length: 401 }, () => ({ content: 'x' })),
    }, { handle: 'bounds-user', name: 'Bounds', admin: false }));
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error.message, /消息数量/);

    const badEntry = await suppressExpectedErrors(() => invokeRoute(generateShared, {
        aibar_model_id: 'any',
        messages: [{ content: 'ok' }, 42],
    }, { handle: 'bounds-user', name: 'Bounds', admin: false }));
    assert.equal(badEntry.status, 400);
    assert.match(badEntry.body.error.message, /无效/);
});

test('public error messages hide internal details but keep validation text', async () => {
    const validation = new Error('作品标题不能为空');
    assert.equal(publicError(validation, '请求处理失败'), '作品标题不能为空');

    const statusError = new Error('自定义校验失败');
    statusError.statusCode = 422;
    assert.equal(publicError(statusError, '请求处理失败'), '自定义校验失败');

    await suppressExpectedErrors(() => {
        const fsError = new Error(`ENOENT: no such file or directory, open '${path.join(userRoot, 'secret.json')}'`);
        fsError.code = 'ENOENT';
        fsError.syscall = 'open';
        assert.equal(publicError(fsError, '请求处理失败'), '请求处理失败');

        const sqliteError = new Error('UNIQUE constraint failed: works.id');
        sqliteError.code = 'SQLITE_CONSTRAINT_PRIMARYKEY';
        assert.equal(publicError(sqliteError, '请求处理失败'), '请求处理失败');

        assert.equal(publicError(new SyntaxError('Unexpected token in JSON'), '请求处理失败'), '请求处理失败');
    });
});

test('settlement charges produced content even when the stream reports a trailing error', () => {
    const db = getCommunityDb();
    const model = { id: 'partial-billing-model', input_price_micros: 10, output_price_micros: 20 };
    const now = new Date().toISOString();
    const insertReservedUsage = (usageId, handle, reservedMicros) => {
        db.prepare(`
            INSERT OR REPLACE INTO point_accounts (user_handle, balance_micros, held_micros, updated_at)
            VALUES (?, 1000000, ?, ?)
        `).run(handle, reservedMicros, now);
        db.prepare(`
            INSERT INTO model_usage (
                id, user_handle, model_id, input_tokens, reserved_micros, status, created_at
            ) VALUES (?, ?, ?, 0, ?, 'reserved', ?)
        `).run(usageId, handle, model.id, reservedMicros, now);
    };

    insertReservedUsage('partial-billing-usage', 'partial-billing-user', 500);
    settleGeneration({ usageId: 'partial-billing-usage' }, model, {
        body: null,
        chunks: [
            'data: {"choices":[{"delta":{"content":"partial reply"}}]}\n\n',
            'data: {"error":{"message":"stream aborted"}}\n\n',
        ],
        statusCode: 200,
    }, 50);
    const partial = db.prepare('SELECT * FROM model_usage WHERE id = ?').get('partial-billing-usage');
    assert.equal(partial.status, 'failed');
    assert.ok(partial.charged_micros > 0, 'produced content must still be charged');
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM point_ledger WHERE reference_id = ?
    `).get('partial-billing-usage').count, 1);

    insertReservedUsage('empty-billing-usage', 'empty-billing-user', 500);
    settleGeneration({ usageId: 'empty-billing-usage' }, model, {
        body: null,
        chunks: ['data: {"error":{"message":"upstream exploded"}}\n\n'],
        statusCode: 200,
    }, 50);
    const empty = db.prepare('SELECT * FROM model_usage WHERE id = ?').get('empty-billing-usage');
    assert.equal(empty.status, 'failed');
    assert.equal(empty.charged_micros, 0, 'content-free errors stay free');

    insertReservedUsage('http-failure-usage', 'http-failure-user', 500);
    settleGeneration({ usageId: 'http-failure-usage' }, model, {
        body: null,
        chunks: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'],
        statusCode: 502,
    }, 50);
    const httpFailure = db.prepare('SELECT * FROM model_usage WHERE id = ?').get('http-failure-usage');
    assert.equal(httpFailure.status, 'failed');
    assert.equal(httpFailure.charged_micros, 0, 'HTTP-level failures stay free');
});

test('PNG character metadata survives zTXt/iTXt chunks, broken CRCs and corrupt ccv3 payloads', async () => {
    const zlib = await import('node:zlib');
    const crc32 = (await import('crc-32')).default;
    const { read } = await import('../src/character-card-parser.js');

    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    /** @type {(name: string, data: Buffer, corruptCrc?: boolean) => Buffer} */
    const pngChunk = (name, data, corruptCrc = false) => {
        const nameBuffer = Buffer.from(name, 'latin1');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const crcBuffer = Buffer.alloc(4);
        const crcValue = (crc32.buf(Buffer.concat([nameBuffer, data])) >>> 0);
        crcBuffer.writeUInt32BE(corruptCrc ? ((crcValue ^ 0xDEADBEEF) >>> 0) : crcValue);
        return Buffer.concat([length, nameBuffer, data, crcBuffer]);
    };
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(1, 0);
    ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 6;
    /** @type {(chunks: Buffer[], trailing?: Buffer) => Buffer} */
    const buildPng = (chunks, trailing = Buffer.alloc(0)) => Buffer.concat([
        signature,
        pngChunk('IHDR', ihdrData),
        ...chunks,
        pngChunk('IEND', Buffer.alloc(0)),
        trailing,
    ]);
    /** @type {(json: object) => string} */
    const encodeCard = json => Buffer.from(JSON.stringify(json), 'utf8').toString('base64');

    const v2Card = { name: '测试角色', description: 'v2' };
    const v3Card = { spec: 'chara_card_v3', data: { name: '测试角色', description: 'v3' } };

    // zTXt：keyword \0 compressionMethod(0) + deflate(base64)
    const ztxtData = Buffer.concat([
        Buffer.from('chara', 'latin1'),
        Buffer.from([0, 0]),
        zlib.deflateSync(Buffer.from(encodeCard(v2Card), 'latin1')),
    ]);
    assert.deepEqual(JSON.parse(read(buildPng([pngChunk('zTXt', ztxtData)]))), v2Card);

    // iTXt（压缩）：keyword \0 compFlag(1) compMethod(0) lang \0 translated \0 deflate(base64)
    const itxtData = Buffer.concat([
        Buffer.from('ccv3', 'latin1'),
        Buffer.from([0, 1, 0, 0, 0]),
        zlib.deflateSync(Buffer.from(encodeCard(v3Card), 'utf8')),
    ]);
    assert.deepEqual(JSON.parse(read(buildPng([pngChunk('iTXt', itxtData)]))), v3Card);

    // CRC 损坏 + IEND 后尾随垃圾：仍能读出 tEXt chara
    const textData = Buffer.concat([
        Buffer.from('chara', 'latin1'),
        Buffer.from([0]),
        Buffer.from(encodeCard(v2Card), 'latin1'),
    ]);
    const brokenPng = buildPng([pngChunk('tEXt', textData, true)], Buffer.from('junk-after-iend'));
    assert.deepEqual(JSON.parse(read(brokenPng)), v2Card);

    // ccv3 载荷损坏时回退到有效的 chara，而不是判死整张卡
    const corruptCcv3 = Buffer.concat([
        Buffer.from('ccv3', 'latin1'),
        Buffer.from([0]),
        Buffer.from('!!not-base64-json!!', 'latin1'),
    ]);
    const mixedPng = buildPng([pngChunk('tEXt', corruptCcv3), pngChunk('tEXt', textData)]);
    assert.deepEqual(JSON.parse(read(mixedPng)), v2Card);

    // 没有任何角色数据 chunk：保持原错误语义
    assert.throws(() => read(buildPng([])), /No PNG metadata/);
});

test('discord batch publish orchestration caps fetch concurrency and isolates failures', async () => {
    const { runDiscordPublishBatch } = await import('../src/endpoints/aibar-community.js');

    const items = Array.from({ length: 7 }, (_, index) => ({ id: `card-${index}` }));
    let inFlightFetches = 0;
    let maxInFlightFetches = 0;
    let publishActive = 0;
    const publishOrder = [];

    const results = await runDiscordPublishBatch(items, {
        fetchConcurrency: 3,
        fetchItem: async (item, index) => {
            inFlightFetches += 1;
            maxInFlightFetches = Math.max(maxInFlightFetches, inFlightFetches);
            await new Promise(resolve => setTimeout(resolve, 12 - index));
            inFlightFetches -= 1;
            if (index === 2) throw new Error(`fetch failed for ${item.id}`);
            return { buffer: Buffer.from(item.id) };
        },
        publishItem: async (item, fetched, index) => {
            publishActive += 1;
            assert.equal(publishActive, 1, 'imports/publishes must be serialized');
            await new Promise(resolve => setTimeout(resolve, 2));
            publishActive -= 1;
            publishOrder.push(index);
            if (index === 4) throw new Error(`publish failed for ${item.id}`);
            return { status: 'published', workId: `work-${fetched.buffer.toString()}` };
        },
    });

    assert.equal(results.length, items.length);
    assert.ok(maxInFlightFetches <= 3, `fetch concurrency must stay <= 3, saw ${maxInFlightFetches}`);
    assert.equal(results[2].status, 'failed');
    assert.match(String(results[2].error?.message), /fetch failed/);
    assert.equal(results[4].status, 'failed');
    assert.match(String(results[4].error?.message), /publish failed/);
    for (const index of [0, 1, 3, 5, 6]) {
        assert.equal(results[index].status, 'published', `item ${index} should publish`);
        assert.equal(results[index].workId, `work-card-${index}`);
    }
    assert.equal(publishOrder.length, 6, 'failed fetch skips publish; failed publish still counts as attempted');
});

test('the discord batch publish route is admin-gated behind a per-user rate limiter', () => {
    const layer = findRouteLayer(communityRouter, '/works/publish-discord-batch', 'post');
    assert.ok(layer, 'batch route must exist');
    assert.ok(layer.route.stack.length >= 3, 'admin middleware + rate limiter + handler');
    assert.equal(layer.route.stack[1].handle.name, 'userRateLimit');
});

test('work tags aggregate published latest-version tags for the filter chips', async () => {
    const worksTags = getRouteHandler(communityRouter, '/works/tags');
    const all = await invokeRoute(worksTags, {});
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.body.tags));
    for (const entry of all.body.tags) {
        assert.equal(typeof entry.tag, 'string');
        assert.ok(Number.isInteger(entry.count) && entry.count >= 1);
    }
    // 类型过滤只接受白名单值；非法类型按“全部”处理而不是报错
    const typed = await invokeRoute(worksTags, { type: 'character' });
    assert.equal(typed.status, 200);
    const bogus = await invokeRoute(worksTags, { type: 'DROP TABLE' });
    assert.equal(bogus.status, 200);
    assert.deepEqual(bogus.body.tags, all.body.tags);
});

const redeemPoints = getRouteHandler(modelsRouter, '/points/redeem');
const createCreditCodes = getRouteHandler(modelsRouter, '/admin/points/codes/create');
const getStory = getRouteHandler(aibarRouter, '/stories/get');
const deleteStory = getRouteHandler(aibarRouter, '/stories/delete');
const deleteImage = getRouteHandler(aibarRouter, '/images/delete');
const getImageFile = getGetRouteHandler(aibarRouter, '/images/file/:fileName');
const getAibarSettings = getRouteHandler(aibarRouter, '/settings/get');
const saveAibarSettings = getRouteHandler(aibarRouter, '/settings/save');

function insertCreditCode(id, code, amountMicros, { enabled = 1, expiresAt = null, redeemedBy = null } = {}) {
    getCommunityDb().prepare(`
        INSERT INTO credit_codes (
            id, code_hash, label, amount_micros, created_by, enabled, expires_at,
            redeemed_by, redeemed_at, created_at
        ) VALUES (?, ?, '', ?, 'admin', ?, ?, ?, ?, ?)
    `).run(
        id, hashInviteCode(code), amountMicros, enabled, expiresAt,
        redeemedBy, redeemedBy ? new Date().toISOString() : null, new Date().toISOString(),
    );
}

function deleteRedemptionRows(cardIds, handles) {
    const db = getCommunityDb();
    for (const cardId of cardIds) db.prepare('DELETE FROM credit_codes WHERE id = ?').run(cardId);
    for (const handle of handles) {
        db.prepare('DELETE FROM point_ledger WHERE user_handle = ?').run(handle);
        db.prepare('DELETE FROM point_accounts WHERE user_handle = ?').run(handle);
    }
}

test('concurrent credit code redemption pays the amount out exactly once', async (t) => {
    const cardId = 'redeem-race-card';
    const code = 'REDEEM-RACE-CODE';
    const amountMicros = 5_000_000;
    const handles = ['redeem-race-a', 'redeem-race-b'];
    insertCreditCode(cardId, code, amountMicros);
    t.after(() => deleteRedemptionRows([cardId], handles));

    const results = await Promise.all(handles.map(handle => invokeRoute(
        redeemPoints,
        { code },
        { handle, name: handle, admin: false },
    )));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    const loser = results.find(result => result.status === 400);
    assert.match(String(loser.body.error), /兑换码/, 'the loser must get an explicit redemption error');

    const db = getCommunityDb();
    const winnerIndex = results.findIndex(result => result.status === 200);
    assert.equal(
        db.prepare('SELECT redeemed_by FROM credit_codes WHERE id = ?').get(cardId).redeemed_by,
        handles[winnerIndex],
        'the card must record exactly the winning handle',
    );
    // 两个账户的余额总增量必须恰好等于卡面额一次；输家的事务整体回滚，不能拿到任何积分。
    assert.equal(db.prepare(`
        SELECT COALESCE(SUM(balance_micros), 0) AS total FROM point_accounts WHERE user_handle IN (?, ?)
    `).get(...handles).total, amountMicros);
    assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM point_ledger WHERE reference_id = ?
    `).get(cardId).count, 1);
    assert.equal(results[winnerIndex].body.balance, amountMicros / 1_000_000);
});

test('credit code redemption rejects disabled, expired, and already redeemed cards', async (t) => {
    const handle = 'redeem-reject-user';
    const cases = [
        ['redeem-disabled-card', 'REDEEM-DISABLED', { enabled: 0 }],
        ['redeem-expired-card', 'REDEEM-EXPIRED', { expiresAt: '2000-01-01T00:00:00.000Z' }],
        ['redeem-used-card', 'REDEEM-USED', { redeemedBy: 'someone-else' }],
    ];
    for (const [id, code, options] of cases) insertCreditCode(id, code, 1_000_000, options);
    t.after(() => deleteRedemptionRows(cases.map(([id]) => id), [handle]));

    for (const [id, code] of cases) {
        const result = await invokeRoute(redeemPoints, { code }, { handle, name: 'Reject', admin: false });
        assert.equal(result.status, 400, id);
        assert.match(String(result.body.error), /兑换码/, id);
    }
    // 三次失败的兑换都不能给账户入账。
    assert.equal(getCommunityDb().prepare(
        'SELECT COALESCE(SUM(balance_micros), 0) AS total FROM point_accounts WHERE user_handle = ?',
    ).get(handle).total, 0);
});

test('credit code redemption refuses to overflow the safe integer balance', async (t) => {
    const handle = 'redeem-overflow-user';
    const cardId = 'redeem-overflow-card';
    const code = 'REDEEM-OVERFLOW';
    const startingBalance = Number.MAX_SAFE_INTEGER - 1_000_000;
    insertCreditCode(cardId, code, 2_000_000);
    const db = getCommunityDb();
    db.prepare(`
        INSERT OR REPLACE INTO point_accounts (user_handle, balance_micros, held_micros, updated_at)
        VALUES (?, ?, 0, ?)
    `).run(handle, startingBalance, new Date().toISOString());
    t.after(() => deleteRedemptionRows([cardId], [handle]));

    const result = await invokeRoute(redeemPoints, { code }, { handle, name: 'Overflow', admin: false });
    // Number.isSafeInteger 保护：超过安全整数上限的入账整体拒绝并回滚，卡片保持未兑换。
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /上限/);
    assert.equal(
        db.prepare('SELECT balance_micros FROM point_accounts WHERE user_handle = ?').get(handle).balance_micros,
        startingBalance,
    );
    assert.equal(db.prepare('SELECT redeemed_by FROM credit_codes WHERE id = ?').get(cardId).redeemed_by, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM point_ledger WHERE reference_id = ?').get(cardId).count, 0);
});

test('admin credit code creation clamps the count and rejects non-positive amounts', async (t) => {
    const db = getCommunityDb();
    const label = 'boundary-credit-codes';
    t.after(() => db.prepare('DELETE FROM credit_codes WHERE label = ?').run(label));

    // count 上限 100：请求 1000 张只会发出 100 张，防止一次性刷爆数据库。
    const clamped = await invokeRoute(createCreditCodes, { amount: 5, count: 1000, label });
    assert.equal(clamped.status, 201);
    assert.equal(clamped.body.cards.length, 100);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_codes WHERE label = ?').get(label).count, 100);
    assert.ok(clamped.body.cards.every(card => /^POINTS(-[0-9A-F]{4}){3}$/.test(card.code)));

    const rejected = await invokeRoute(createCreditCodes, { amount: 0, count: 1, label });
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.body.error), /大于 0/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM credit_codes WHERE label = ?').get(label).count, 100);
});

test('story routes neutralize path traversal ids without touching files outside the stories directory', async (t) => {
    const storiesDirectory = path.join(userRoot, 'aibar', 'stories');
    const settingsBefore = fs.readFileSync(settingsPath, 'utf8');

    // stories/../../settings.json 恰好指向账号根目录的 settings.json，是最现实的越界目标。
    const read = await invokeRoute(getStory, { id: '../../settings' });
    assert.equal(read.status, 404);
    assert.ok(!String(read.body).includes('simple_ui_mods'), 'must not return the settings file content');
    assert.ok(!String(read.body).includes(testRoot), 'must not leak absolute paths');

    const removed = await invokeRoute(deleteStory, { id: '../../settings' });
    assert.equal(removed.status, 404);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsBefore, 'settings.json must survive the delete attempt');

    const saved = await invokeRoute(saveStory, {
        story: { id: '../../escaped-story', title: 'Traversal Story', characterAvatar },
    });
    assert.equal(saved.status, 200);
    const savedPath = path.resolve(storiesDirectory, `${saved.body.id}.json`);
    t.after(() => fs.rmSync(savedPath, { force: true }));
    assert.ok(savedPath.startsWith(`${storiesDirectory}${path.sep}`), 'the sanitized id must stay inside the stories directory');
    assert.equal(fs.existsSync(savedPath), true);
    assert.equal(fs.existsSync(path.join(userRoot, 'escaped-story.json')), false);
    assert.equal(fs.existsSync(path.join(testRoot, 'escaped-story.json')), false);
});

test('image file routes reject traversal file names without serving or deleting outside files', async () => {
    const outside = await invokeRoute(getImageFile, {}, undefined, { params: { fileName: '../../settings.json' } });
    assert.equal(outside.status, 404);
    assert.equal(outside.body, null, 'no file path may reach sendFile');

    // '..' 会被 sanitize 成空串并触发显式拒绝。
    const invalid = await suppressExpectedErrors(() => invokeRoute(getImageFile, {}, undefined, { params: { fileName: '..' } }));
    assert.ok([400, 404].includes(invalid.status), String(invalid.status));
    assert.ok(!String(invalid.body).includes(testRoot), 'must not leak absolute paths');

    // 删除走 index.json 的 id 查找，越界 id 根本找不到条目。
    const removed = await invokeRoute(deleteImage, { id: '../../settings' });
    assert.equal(removed.status, 404);
    assert.equal(fs.existsSync(settingsPath), true);
});

test('community publication rejects traversal private source file names', async () => {
    const attempts = [
        { sourceType: 'character', sourceId: `../characters/${characterAvatar}`, title: 'Traversal Character Publish' },
        { sourceType: 'story', sourceId: '../../settings', title: 'Traversal Story Publish' },
    ];
    for (const attempt of attempts) {
        const result = await suppressExpectedErrors(() => invokeRoute(publishWork, attempt));
        // assertPrivateFile 要求 sanitize 后的文件名与原名一致，任何路径片段都会被拒绝。
        assert.equal(result.status, 400, attempt.sourceType);
        assert.ok(!String(result.body.error).includes(testRoot), attempt.sourceType);
        assert.equal(
            getCommunityDb().prepare('SELECT COUNT(*) AS count FROM works WHERE title = ?').get(attempt.title).count,
            0,
            attempt.sourceType,
        );
    }
});

test('community version assets refuse paths escaping the community root', async (t) => {
    const db = getCommunityDb();
    const workId = 'traversal-asset-work';
    const versionId = 'traversal-asset-version';
    const absoluteVersionId = 'traversal-asset-version-absolute';
    const now = new Date().toISOString();
    // 直接在数据库里伪造越界 asset_path，验证 resolveCommunityAsset 是数据被污染后的最后一道防线。
    // '../user/settings.json' 相对社区根目录（DATA_ROOT/_aibar）解析后正好落在真实存在的账号 settings.json 上。
    db.prepare(`
        INSERT INTO works (
            id, type, author_handle, author_name, title, summary,
            latest_version_id, status, published_at, updated_at
        ) VALUES (?, 'character', 'admin', 'Admin', 'Traversal Asset Work', '', ?, 'published', ?, ?)
    `).run(workId, versionId, now, now);
    const insertVersion = db.prepare(`
        INSERT INTO work_versions (id, work_id, version_number, title, payload_json, asset_path, cover_path, created_at)
        VALUES (?, ?, ?, 'Traversal Asset Work', '{}', ?, ?, ?)
    `);
    insertVersion.run(versionId, workId, 1, path.join('..', 'user', 'settings.json'), path.join('..', 'user', 'settings.json'), now);
    insertVersion.run(absoluteVersionId, workId, 2, settingsPath, settingsPath, now);
    t.after(() => db.prepare('DELETE FROM works WHERE id = ?').run(workId));

    for (const id of [versionId, absoluteVersionId]) {
        const result = await suppressExpectedErrors(() => invokeRoute(getWorkVersion, {}, undefined, {
            params: { versionId: id, kind: 'asset' },
        }));
        assert.equal(result.status, 404, id);
        assert.equal(result.body, null, 'sendFile must never receive the escaped path');
    }
});

test('the model list advertises supportedSources consistent with the shared source validator', async () => {
    const result = await invokeRoute(listModels, {});
    assert.equal(result.status, 200);
    const sources = result.body.supportedSources;
    assert.ok(Array.isArray(sources) && sources.length > 0, 'supportedSources must be a non-empty array');
    assert.ok(sources.includes('ai21'));
    // 清单与 isSupportedSharedModelSource 必须同源，防止前端下拉与后端校验漂移。
    for (const source of sources) {
        assert.equal(isSupportedSharedModelSource(source), true, source);
    }
    assert.equal(new Set(sources).size, sources.length, 'supportedSources must not contain duplicates');
    for (const blocked of ['azure_openai', 'vertexai', 'workers_ai', 'unknown-provider']) {
        assert.equal(sources.includes(blocked), false, blocked);
    }
});

test('validateDiscordAttachmentUrl accepts only canonical Discord CDN attachment URLs', () => {
    const valid = validateDiscordAttachmentUrl('https://cdn.discordapp.com/attachments/12345678901234567/76543210987654321/card.png');
    assert.equal(valid.hostname, 'cdn.discordapp.com');
    assert.equal(
        validateDiscordAttachmentUrl('https://media.discordapp.net/attachments/12345678901234567/76543210987654321/card.json').hostname,
        'media.discordapp.net',
    );

    const rejected = [
        // http 明文
        'http://cdn.discordapp.com/attachments/12345678901234567/76543210987654321/card.png',
        // 显式端口
        'https://cdn.discordapp.com:8443/attachments/12345678901234567/76543210987654321/card.png',
        // 带用户名密码（SSRF 混淆常用手法）
        'https://user:secret@cdn.discordapp.com/attachments/12345678901234567/76543210987654321/card.png',
        // 非白名单主机
        'https://cdn.evil.example/attachments/12345678901234567/76543210987654321/card.png',
        // 路径前缀不匹配
        'https://cdn.discordapp.com/files/12345678901234567/76543210987654321/card.png',
        // 不支持的扩展名
        'https://cdn.discordapp.com/attachments/12345678901234567/76543210987654321/card.exe',
        // '..' 会被 URL 规范化掉，规范化后的路径同样不匹配附件模式
        'https://cdn.discordapp.com/attachments/../76543210987654321/card.png',
    ];
    for (const url of rejected) {
        assert.throws(
            () => validateDiscordAttachmentUrl(url),
            error => error.status === 400 && /Only supported Discord CDN attachments/.test(error.message),
            url,
        );
    }
    assert.throws(
        () => validateDiscordAttachmentUrl('not-a-url'),
        error => error.status === 400 && /Invalid Discord attachment URL/.test(error.message),
    );
});

const settingsRouteProfile = { handle: 'settings-route-user', name: 'Settings Route User', admin: false };

test('AIBAR settings get returns the aibar section for every settings.json shape', async (t) => {
    // 用独立的账号根目录，避免污染其他测试共享的 settings.json 夹具。
    const root = path.join(testRoot, 'settings-get-root');
    fs.mkdirSync(root, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDirectories = { ...directories, root };
    const filePath = path.join(root, 'settings.json');

    const missing = await invokeRoute(getAibarSettings, {}, settingsRouteProfile, { userDirectories });
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { settings: {} }, 'a missing settings.json must read as empty');

    fs.writeFileSync(filePath, JSON.stringify({ foo: 1 }), 'utf8');
    assert.deepEqual(
        (await invokeRoute(getAibarSettings, {}, settingsRouteProfile, { userDirectories })).body,
        { settings: {} },
        'settings.json without an aibar key must read as empty',
    );

    fs.writeFileSync(filePath, JSON.stringify({ foo: 1, aibar: [1, 2] }), 'utf8');
    assert.deepEqual(
        (await invokeRoute(getAibarSettings, {}, settingsRouteProfile, { userDirectories })).body,
        { settings: {} },
        'a non-object aibar key must read as empty',
    );

    fs.writeFileSync(filePath, JSON.stringify({ foo: 1, aibar: { theme: 'dark' } }), 'utf8');
    assert.deepEqual(
        (await invokeRoute(getAibarSettings, {}, settingsRouteProfile, { userDirectories })).body,
        { settings: { theme: 'dark' } },
    );
});

test('AIBAR settings save shallow-merges the aibar key and leaves other top-level keys alone', async (t) => {
    const root = path.join(testRoot, 'settings-save-root');
    fs.mkdirSync(root, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDirectories = { ...directories, root };
    const filePath = path.join(root, 'settings.json');
    fs.writeFileSync(filePath, JSON.stringify({ foo: 1, aibar: { keep: 'x', old: 1 } }), 'utf8');

    // triggerAutoSave 的 throttle 定时器由 --test-force-exit 兜底，不会拖住测试进程。
    const saved = await invokeRoute(saveAibarSettings, { old: 2, added: true }, settingsRouteProfile, { userDirectories });
    assert.equal(saved.status, 200);
    // 返回值必须就是合并后的 aibar 对象。
    assert.deepEqual(saved.body, { settings: { keep: 'x', old: 2, added: true } });
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(onDisk.foo, 1, 'foreign top-level keys must survive the merge');
    assert.deepEqual(onDisk.aibar, { keep: 'x', old: 2, added: true });

    for (const body of [[1, 2], 'not-an-object', null]) {
        const invalid = await invokeRoute(saveAibarSettings, body, settingsRouteProfile, { userDirectories });
        assert.equal(invalid.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(
        JSON.parse(fs.readFileSync(filePath, 'utf8')),
        { foo: 1, aibar: { keep: 'x', old: 2, added: true } },
        'invalid bodies must not modify the file',
    );
});

test('a fresh community database lands on user_version 4 and replays from 0 without data loss', () => {
    const databasePath = path.join(testRoot, 'user-version-cursor.sqlite');
    let db = createCommunityDatabase(databasePath);
    try {
        assert.equal(Number(db.pragma('user_version', { simple: true })), 4);
        db.prepare(`
            INSERT INTO invites (id, code_hash, label, created_by, max_uses, created_at)
            VALUES ('cursor-invite', 'cursor-hash', '', 'admin', 10, ?)
        `).run(new Date().toISOString());
        db.prepare(`
            INSERT INTO registration_requests (
                id, handle, name, password_hash, password_salt, invite_id, created_at
            ) VALUES ('cursor-registration', 'cursor-registration', 'Cursor', 'hash', 'salt', 'cursor-invite', ?)
        `).run(new Date().toISOString());
        db.prepare(`
            INSERT INTO works (
                id, type, author_handle, author_name, title, summary,
                latest_version_id, status, published_at, updated_at
            ) VALUES ('cursor-work', 'mod', 'admin', 'Admin', 'Cursor Work', '', NULL, 'published', ?, ?)
        `).run(new Date().toISOString(), new Date().toISOString());
        // 把游标拨回 0，模拟 user_version 机制引入之前的存量库。
        db.pragma('user_version = 0');
    } finally {
        db.close();
    }

    db = createCommunityDatabase(databasePath);
    try {
        // 迁移重放必须幂等：游标回到 4，数据一行不丢、状态不变。
        assert.equal(Number(db.pragma('user_version', { simple: true })), 4);
        assert.equal(
            db.prepare('SELECT status FROM registration_requests WHERE id = ?').get('cursor-registration').status,
            'pending',
        );
        assert.equal(db.prepare('SELECT title FROM works WHERE id = ?').get('cursor-work').title, 'Cursor Work');
        assert.equal(
            db.prepare('SELECT COUNT(*) AS count FROM registration_requests WHERE handle = ?').get('cursor-registration').count,
            1,
        );
    } finally {
        db.close();
    }
});
