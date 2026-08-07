import crypto from 'node:crypto';

import express from 'express';
import storage from 'node-persist';

import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import { publicError } from '../aibar-errors.js';
import { createUserRateLimiter } from '../aibar-rate-limit.js';
import { getCommunityDb, hashInviteCode } from '../aibar-community-db.js';
import { KEY_PREFIX, getUserDirectories, requireAdminMiddleware, toKey } from '../users.js';
import { checkChatCompletionStatus, generateChatCompletion } from './backends/chat-completions.js';
import { SECRET_KEYS, readSecret } from './secrets.js';

export const router = express.Router();

const POINT_SCALE = 1_000_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const STALE_RESERVATION_MINUTES = 30;
const GENERATE_MAX_MESSAGES = 400;
const GENERATE_MAX_MESSAGES_LENGTH = 400_000;
const GENERATE_MAX_CONCURRENCY = 3;
const activeReservationIds = new Set();
/** @type {Map<string, number>} 每个用户当前进行中的共享生成请求数 */
const activeGenerationCounts = new Map();
const supportedSources = new Set([
    CHAT_COMPLETION_SOURCES.OPENAI,
    CHAT_COMPLETION_SOURCES.CLAUDE,
    CHAT_COMPLETION_SOURCES.OPENROUTER,
    CHAT_COMPLETION_SOURCES.AI21,
    CHAT_COMPLETION_SOURCES.MAKERSUITE,
    CHAT_COMPLETION_SOURCES.MISTRALAI,
    CHAT_COMPLETION_SOURCES.CUSTOM,
    CHAT_COMPLETION_SOURCES.COHERE,
    CHAT_COMPLETION_SOURCES.PERPLEXITY,
    CHAT_COMPLETION_SOURCES.GROQ,
    CHAT_COMPLETION_SOURCES.CHUTES,
    CHAT_COMPLETION_SOURCES.ELECTRONHUB,
    CHAT_COMPLETION_SOURCES.NANOGPT,
    CHAT_COMPLETION_SOURCES.DEEPSEEK,
    CHAT_COMPLETION_SOURCES.AIMLAPI,
    CHAT_COMPLETION_SOURCES.XAI,
    CHAT_COMPLETION_SOURCES.POLLINATIONS,
    CHAT_COMPLETION_SOURCES.MOONSHOT,
    CHAT_COMPLETION_SOURCES.FIREWORKS,
    CHAT_COMPLETION_SOURCES.ZAI,
    CHAT_COMPLETION_SOURCES.SILICONFLOW,
    CHAT_COMPLETION_SOURCES.MINIMAX,
]);
const sourceSecretKeys = {
    [CHAT_COMPLETION_SOURCES.OPENAI]: SECRET_KEYS.OPENAI,
    [CHAT_COMPLETION_SOURCES.CLAUDE]: SECRET_KEYS.CLAUDE,
    [CHAT_COMPLETION_SOURCES.OPENROUTER]: SECRET_KEYS.OPENROUTER,
    [CHAT_COMPLETION_SOURCES.AI21]: SECRET_KEYS.AI21,
    [CHAT_COMPLETION_SOURCES.MAKERSUITE]: SECRET_KEYS.MAKERSUITE,
    [CHAT_COMPLETION_SOURCES.MISTRALAI]: SECRET_KEYS.MISTRALAI,
    [CHAT_COMPLETION_SOURCES.CUSTOM]: SECRET_KEYS.CUSTOM,
    [CHAT_COMPLETION_SOURCES.COHERE]: SECRET_KEYS.COHERE,
    [CHAT_COMPLETION_SOURCES.PERPLEXITY]: SECRET_KEYS.PERPLEXITY,
    [CHAT_COMPLETION_SOURCES.GROQ]: SECRET_KEYS.GROQ,
    [CHAT_COMPLETION_SOURCES.CHUTES]: SECRET_KEYS.CHUTES,
    [CHAT_COMPLETION_SOURCES.ELECTRONHUB]: SECRET_KEYS.ELECTRONHUB,
    [CHAT_COMPLETION_SOURCES.NANOGPT]: SECRET_KEYS.NANOGPT,
    [CHAT_COMPLETION_SOURCES.DEEPSEEK]: SECRET_KEYS.DEEPSEEK,
    [CHAT_COMPLETION_SOURCES.AIMLAPI]: SECRET_KEYS.AIMLAPI,
    [CHAT_COMPLETION_SOURCES.XAI]: SECRET_KEYS.XAI,
    [CHAT_COMPLETION_SOURCES.POLLINATIONS]: SECRET_KEYS.POLLINATIONS,
    [CHAT_COMPLETION_SOURCES.MOONSHOT]: SECRET_KEYS.MOONSHOT,
    [CHAT_COMPLETION_SOURCES.FIREWORKS]: SECRET_KEYS.FIREWORKS,
    [CHAT_COMPLETION_SOURCES.ZAI]: SECRET_KEYS.ZAI,
    [CHAT_COMPLETION_SOURCES.SILICONFLOW]: SECRET_KEYS.SILICONFLOW,
    [CHAT_COMPLETION_SOURCES.MINIMAX]: SECRET_KEYS.MINIMAX,
};

export function isSupportedSharedModelSource(source) {
    return supportedSources.has(source);
}

function nowIso() {
    return new Date().toISOString();
}

function safeJson(value, fallback = {}) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function pointsToMicros(value) {
    const points = clampNumber(value, 0, 1_000_000_000, 0);
    return Math.round(points * POINT_SCALE);
}

function microsToPoints(value) {
    return Number(value || 0) / POINT_SCALE;
}

function ensurePointAccount(db, handle) {
    db.prepare(`
        INSERT OR IGNORE INTO point_accounts (user_handle, balance_micros, held_micros, updated_at)
        VALUES (?, 0, 0, ?)
    `).run(handle, nowIso());
    return db.prepare('SELECT * FROM point_accounts WHERE user_handle = ?').get(handle);
}

function accountView(row) {
    const balanceMicros = Number(row?.balance_micros || 0);
    const heldMicros = Number(row?.held_micros || 0);
    return {
        balance: microsToPoints(balanceMicros),
        held: microsToPoints(heldMicros),
        available: microsToPoints(Math.max(0, balanceMicros - heldMicros)),
        updatedAt: row?.updated_at || '',
    };
}

function modelView(row, { includePrivate = false, includeAdminState = false } = {}) {
    return {
        id: row.id,
        name: row.name,
        source: row.source,
        model: row.model,
        ...(includePrivate ? {
            endpoint: row.endpoint,
            secretId: row.secret_id,
        } : {}),
        ...(includeAdminState ? {
            apiKeySaved: Boolean(row.secret_id),
            canManageCredentials: includePrivate,
        } : {}),
        temperature: Number(row.temperature),
        maxTokens: Number(row.max_tokens),
        topP: Number(row.top_p),
        presencePenalty: Number(row.presence_penalty),
        frequencyPenalty: Number(row.frequency_penalty),
        inputPrice: microsToPoints(row.input_price_micros),
        outputPrice: microsToPoints(row.output_price_micros),
        enabled: Boolean(row.enabled),
        sortOrder: Number(row.sort_order),
        updatedAt: row.updated_at,
    };
}

export function releaseStaleReservations(db) {
    const stale = db.prepare(`
        SELECT * FROM model_usage
        WHERE status = 'reserved' AND datetime(created_at) < datetime('now', ?)
    `).all(`-${STALE_RESERVATION_MINUTES} minutes`)
        .filter(usage => !activeReservationIds.has(usage.id));
    if (!stale.length) return;

    db.transaction(() => {
        const release = db.prepare(`
            UPDATE point_accounts
            SET held_micros = MAX(0, held_micros - ?), updated_at = ?
            WHERE user_handle = ?
        `);
        const fail = db.prepare(`
            UPDATE model_usage SET status = 'failed', detail_json = ?, completed_at = ?
            WHERE id = ? AND status = 'reserved'
        `);
        for (const usage of stale) {
            const completedAt = nowIso();
            const result = fail.run(JSON.stringify({ reason: 'stale_reservation_released' }), completedAt, usage.id);
            if (result.changes) {
                release.run(usage.reserved_micros, completedAt, usage.user_handle);
            }
        }
    })();
}

export function trackActiveReservation(usageId) {
    activeReservationIds.add(String(usageId || ''));
}

export function untrackActiveReservation(usageId) {
    activeReservationIds.delete(String(usageId || ''));
}

function estimateTextTokens(value) {
    const text = String(value || '');
    if (!text) return 0;
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return Math.ceil(cjk + Math.max(0, text.length - cjk) / 4);
}

export function estimateInputTokens(messages) {
    if (typeof messages === 'string') return Buffer.byteLength(JSON.stringify(messages), 'utf8');
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((total, message) => {
        const serialized = JSON.stringify(message ?? '');
        return total + Buffer.byteLength(serialized, 'utf8') + 4;
    }, 2);
}

export function estimateSettlementInputTokens(messages) {
    if (typeof messages === 'string') return estimateTextTokens(messages);
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((total, message) => {
        const serialized = JSON.stringify(message ?? '');
        return total + estimateTextTokens(serialized) + 4;
    }, 2);
}

function calculateCostMicros(inputTokens, inputPriceMicros, outputTokens, outputPriceMicros) {
    const cost = (inputTokens * Number(inputPriceMicros)) + (outputTokens * Number(outputPriceMicros));
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(cost)));
}

export function determineSettlementCharge(calculatedMicros, balanceMicros, heldMicros, reservedMicros) {
    const otherHeldMicros = Math.max(0, Number(heldMicros) - Number(reservedMicros));
    const spendableMicros = Math.max(0, Number(balanceMicros) - otherHeldMicros);
    return Math.min(Math.max(0, Number(calculatedMicros)), spendableMicros);
}

function reserveGeneration(userHandle, model, inputTokens, maxOutputTokens) {
    const db = getCommunityDb();
    releaseStaleReservations(db);
    const reservedMicros = calculateCostMicros(
        inputTokens,
        model.input_price_micros,
        maxOutputTokens,
        model.output_price_micros,
    );
    const usageId = crypto.randomUUID();
    const createdAt = nowIso();

    const account = db.transaction(() => {
        const current = ensurePointAccount(db, userHandle);
        const available = Number(current.balance_micros) - Number(current.held_micros);
        if (available < reservedMicros) {
            const error = new Error('积分不足，请先兑换额度卡');
            error.code = 'INSUFFICIENT_POINTS';
            error.availableMicros = Math.max(0, available);
            error.requiredMicros = reservedMicros;
            throw error;
        }
        db.prepare(`
            UPDATE point_accounts SET held_micros = held_micros + ?, updated_at = ?
            WHERE user_handle = ?
        `).run(reservedMicros, createdAt, userHandle);
        db.prepare(`
            INSERT INTO model_usage (
                id, user_handle, model_id, input_tokens, reserved_micros, status, created_at
            ) VALUES (?, ?, ?, ?, ?, 'reserved', ?)
        `).run(usageId, userHandle, model.id, inputTokens, reservedMicros, createdAt);
        return db.prepare('SELECT * FROM point_accounts WHERE user_handle = ?').get(userHandle);
    })();

    trackActiveReservation(usageId);
    return { usageId, reservedMicros, maxOutputTokens, account };
}

function extractContent(payload) {
    const choiceParts = [];
    const add = (value) => {
        if (typeof value === 'string') choiceParts.push(value);
        if (Array.isArray(value)) value.forEach(item => add(item?.text ?? item?.content ?? item));
    };
    if (!payload || typeof payload !== 'object') return '';
    for (const choice of payload.choices || []) {
        add(choice?.message?.content);
        add(choice?.delta?.content);
        add(choice?.text);
    }
    if (choiceParts.length) return choiceParts.join('');

    const parts = [];
    const addFallback = (value) => {
        if (typeof value === 'string') parts.push(value);
        if (Array.isArray(value)) value.forEach(item => addFallback(item?.text ?? item?.content ?? item));
    };
    addFallback(payload.content);
    addFallback(payload.delta?.text);
    addFallback(payload.delta?.content);
    addFallback(payload.response);
    for (const candidate of payload.candidates || []) addFallback(candidate?.content?.parts);
    return parts.join('');
}

function extractUsage(payload) {
    const usage = payload?.usage || payload?.usageMetadata;
    if (!usage || typeof usage !== 'object') return null;
    const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount);
    const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount);
    return {
        input: Number.isFinite(input) && input >= 0 ? Math.round(input) : 0,
        output: Number.isFinite(output) && output >= 0 ? Math.round(output) : 0,
    };
}

function capturedPayloads(capture) {
    const payloads = [];
    if (capture.body && typeof capture.body === 'object' && !Buffer.isBuffer(capture.body)) {
        payloads.push(capture.body);
    } else if (capture.body) {
        const parsed = safeJson(Buffer.isBuffer(capture.body) ? capture.body.toString('utf8') : String(capture.body), null);
        if (parsed) payloads.push(parsed);
    }

    const raw = capture.chunks.join('');
    for (const line of raw.split(/\r?\n/)) {
        const data = line.match(/^data:\s?(.*)$/)?.[1]?.trim();
        if (!data || data === '[DONE]') continue;
        const parsed = safeJson(data, null);
        if (parsed) payloads.push(parsed);
    }
    if (!payloads.length && raw.trim()) {
        const parsed = safeJson(raw, null);
        if (parsed) payloads.push(parsed);
    }
    return payloads;
}

export function summarizeCapture(capture, estimatedInputTokens) {
    const payloads = capturedPayloads(capture);
    let inputTokens = 0;
    let outputTokens = 0;
    let content = '';
    let hasError = false;
    for (const payload of payloads) {
        hasError ||= Boolean(payload?.error);
        const usage = extractUsage(payload);
        if (usage) {
            inputTokens = Math.max(inputTokens, usage.input);
            outputTokens = Math.max(outputTokens, usage.output);
        }
        content += extractContent(payload);
    }
    return {
        inputTokens: inputTokens || estimatedInputTokens,
        outputTokens: outputTokens || estimateTextTokens(content),
        hasError,
        hasContent: content.trim().length > 0,
        usageReported: inputTokens > 0 || outputTokens > 0,
    };
}

export function settleGeneration(reservation, model, capture, estimatedInputTokens) {
    try {
        const db = getCommunityDb();
        const summary = summarizeCapture(capture, estimatedInputTokens);
        const failed = capture.statusCode >= 400 || summary.hasError;
        // 流式响应中途出错但已经产出内容时，仍按实际用量计费；完全没有内容才免单。
        const billable = capture.statusCode < 400 && (!summary.hasError || summary.hasContent);
        const calculatedMicros = !billable ? 0 : calculateCostMicros(
            summary.inputTokens,
            model.input_price_micros,
            summary.outputTokens,
            model.output_price_micros,
        );
        const completedAt = nowIso();

        db.transaction(() => {
            const usage = db.prepare('SELECT * FROM model_usage WHERE id = ? AND status = \'reserved\'').get(reservation.usageId);
            if (!usage) return;
            const account = ensurePointAccount(db, usage.user_handle);
            const chargedMicros = determineSettlementCharge(
                calculatedMicros,
                account.balance_micros,
                account.held_micros,
                usage.reserved_micros,
            );
            const balanceAfter = Math.max(0, Number(account.balance_micros) - chargedMicros);
            db.prepare(`
                UPDATE point_accounts
                SET balance_micros = ?, held_micros = MAX(0, held_micros - ?), updated_at = ?
                WHERE user_handle = ?
            `).run(balanceAfter, usage.reserved_micros, completedAt, usage.user_handle);
            db.prepare(`
                UPDATE model_usage SET
                    input_tokens = ?, output_tokens = ?, charged_micros = ?, status = ?,
                    detail_json = ?, completed_at = ?
                WHERE id = ?
            `).run(
                summary.inputTokens,
                summary.outputTokens,
                chargedMicros,
                failed ? 'failed' : 'completed',
                JSON.stringify({
                    statusCode: capture.statusCode,
                    usageReported: summary.usageReported,
                    calculatedMicros,
                    unchargedMicros: Math.max(0, calculatedMicros - chargedMicros),
                }),
                completedAt,
                usage.id,
            );
            if (chargedMicros > 0) {
                db.prepare(`
                    INSERT INTO point_ledger (
                        id, user_handle, delta_micros, balance_after_micros, kind,
                        reference_id, detail_json, created_at
                    ) VALUES (?, ?, ?, ?, 'generation', ?, ?, ?)
                `).run(
                    crypto.randomUUID(),
                    usage.user_handle,
                    -chargedMicros,
                    balanceAfter,
                    usage.id,
                    JSON.stringify({ modelId: model.id, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens }),
                    completedAt,
                );
            }
        })();
    } finally {
        untrackActiveReservation(reservation.usageId);
    }
}

function instrumentResponse(response, onComplete) {
    const capture = { body: null, chunks: [], capturedBytes: 0, statusCode: 200 };
    const originalSend = response.send.bind(response);
    const originalWrite = response.write.bind(response);
    response.send = function (body) {
        capture.body = body;
        return originalSend(body);
    };
    response.write = function (chunk, ...args) {
        if (capture.capturedBytes < MAX_CAPTURE_BYTES && chunk !== undefined && chunk !== null) {
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            const remaining = MAX_CAPTURE_BYTES - capture.capturedBytes;
            capture.chunks.push(text.slice(0, remaining));
            capture.capturedBytes += Math.min(remaining, Buffer.byteLength(text));
        }
        return originalWrite(chunk, ...args);
    };

    let completed = false;
    const complete = () => {
        if (completed) return;
        completed = true;
        capture.statusCode = response.statusCode;
        try {
            onComplete(capture);
        } catch (error) {
            console.error('AIBAR generation settlement failed:', error);
        }
    };
    response.once('finish', complete);
    response.once('close', complete);
}

function applySharedModel(body, model, directories) {
    const blocked = [
        'secret_id', 'proxy_password', 'custom_url', 'reverse_proxy',
        'custom_include_headers', 'custom_include_body', 'custom_exclude_body',
    ];
    for (const key of blocked) delete body[key];
    body.chat_completion_source = model.source;
    body.model = model.model;
    body.secret_id = model.secret_id || undefined;
    body.temperature = Number(model.temperature);
    body.max_tokens = Math.round(clampNumber(body.max_tokens, 1, model.max_tokens, model.max_tokens));
    body.top_p = Number(model.top_p);
    body.presence_penalty = Number(model.presence_penalty);
    body.frequency_penalty = Number(model.frequency_penalty);
    if (model.source === CHAT_COMPLETION_SOURCES.CUSTOM) {
        body.custom_url = model.endpoint;
    } else if (model.endpoint) {
        body.reverse_proxy = model.endpoint;
        const secretKey = sourceSecretKeys[model.source];
        if (secretKey) {
            body.proxy_password = readSecret(directories, secretKey, model.secret_id) || undefined;
        }
    }
}

/**
 * 校验共享生成请求的消息列表，越界或格式非法时返回中文错误文案。
 * @param {any} messages 请求中的 messages 字段
 * @returns {string|null} 错误文案；合法时返回 null
 */
export function validateGenerationMessages(messages) {
    if (!Array.isArray(messages) && typeof messages !== 'string') {
        return '缺少有效的消息列表';
    }
    if (Array.isArray(messages)) {
        if (messages.length > GENERATE_MAX_MESSAGES) {
            return `消息数量超过上限（${GENERATE_MAX_MESSAGES} 条）`;
        }
        for (const message of messages) {
            if (typeof message !== 'string' && (typeof message !== 'object' || message === null)) {
                return '消息列表包含无效条目';
            }
        }
    }
    if (JSON.stringify(messages).length > GENERATE_MAX_MESSAGES_LENGTH) {
        return `消息内容超过长度上限（${GENERATE_MAX_MESSAGES_LENGTH.toLocaleString('en-US')} 字符）`;
    }
    return null;
}

function trustedGenerationBody(body, maxOutputTokens) {
    return {
        type: 'normal',
        messages: body.messages,
        stream: Boolean(body.stream),
        max_tokens: maxOutputTokens,
        user_name: String(body.user_name || '').slice(0, 100),
        char_name: String(body.char_name || '').slice(0, 100),
    };
}

export function sharedModelGuard(request, response, next) {
    if (request.user?.profile?.admin) return next();
    const normalizedPath = String(request.path || '').toLowerCase().replace(/\/+$/, '') || '/';
    if (normalizedPath === '/generate' || normalizedPath === '/status') {
        return response.status(403).json({ error: { message: '请使用管理员提供的共享模型' } });
    }
    return next();
}

/**
 * AIBAR ordinary users must generate through /api/aibar/models/generate so the
 * server can select credentials, reserve points, and settle usage. Native ST
 * provider routers remain available to administrators for maintenance only.
 */
export function legacyProviderGuard(request, response, next) {
    if (request.user?.profile?.admin) return next();
    return response.status(403).json({
        error: { message: '普通用户只能使用管理员提供的共享模型' },
    });
}

router.post('/models/list', async (request, response) => {
    try {
        const isAdmin = Boolean(request.user.profile.admin);
        const rows = getCommunityDb().prepare(`
            SELECT * FROM shared_models
            ${isAdmin ? '' : 'WHERE enabled = 1'}
            ORDER BY sort_order ASC, created_at ASC
        `).all();
        const visibleRows = isAdmin ? rows : rows.filter(row => isSupportedSharedModelSource(row.source));
        const handle = request.user.profile.handle;
        return response.json({
            models: visibleRows.map(row => modelView(row, {
                includePrivate: isAdmin && row.owner_handle === handle,
                includeAdminState: isAdmin,
            })),
        });
    } catch (error) {
        console.error('AIBAR model list failed:', error);
        return response.status(500).json({ error: '模型列表加载失败' });
    }
});

router.post('/admin/models/save', requireAdminMiddleware, (request, response) => {
    try {
        const db = getCommunityDb();
        const body = request.body || {};
        const requestedId = String(body.id || '').trim();
        const id = /^[a-zA-Z0-9_-]{1,100}$/.test(requestedId) ? requestedId : crypto.randomUUID();
        const existing = db.prepare('SELECT * FROM shared_models WHERE id = ?').get(id);
        const source = String(body.source || '');
        const name = String(body.name || '').trim().slice(0, 100);
        const model = String(body.model || '').trim().slice(0, 200);
        if (!name || !model || !isSupportedSharedModelSource(source)) {
            return response.status(400).json({ error: '请填写有效的名称、渠道和模型' });
        }
        const now = nowIso();
        const values = {
            endpoint: String(body.endpoint || '').trim().slice(0, 1000),
            secretId: String(body.secretId || '').trim().slice(0, 200),
            temperature: clampNumber(body.temperature, 0, 2, 0.7),
            maxTokens: Math.round(clampNumber(body.maxTokens, 64, 131072, 4096)),
            topP: clampNumber(body.topP, 0, 1, 1),
            presencePenalty: clampNumber(body.presencePenalty, -2, 2, 0),
            frequencyPenalty: clampNumber(body.frequencyPenalty, -2, 2, 0),
            inputPrice: pointsToMicros(body.inputPrice),
            outputPrice: pointsToMicros(body.outputPrice),
            enabled: body.enabled === false ? 0 : 1,
            sortOrder: Math.round(clampNumber(body.sortOrder, -10000, 10000, existing?.sort_order || 0)),
        };
        let ownerHandle = existing?.owner_handle || request.user.profile.handle;
        if (existing && existing.owner_handle !== request.user.profile.handle && body.transferCredentials !== true) {
            const credentialChanged = source !== existing.source
                || (values.endpoint && values.endpoint !== existing.endpoint)
                || (values.secretId && values.secretId !== existing.secret_id);
            if (credentialChanged) {
                return response.status(403).json({ error: '只有模型凭据所属管理员才能修改渠道、端点或密钥' });
            }
            values.endpoint = existing.endpoint;
            values.secretId = existing.secret_id;
        }
        if (existing && body.transferCredentials === true) {
            const secretKey = sourceSecretKeys[source];
            if (!values.secretId || !secretKey) {
                return response.status(400).json({ error: '转移模型凭据时必须选择有效密钥' });
            }
            const directories = getUserDirectories(request.user.profile.handle);
            if (!readSecret(directories, secretKey, values.secretId)) {
                return response.status(400).json({ error: '转移模型凭据时必须选择当前管理员名下的有效密钥' });
            }
            ownerHandle = request.user.profile.handle;
        }

        db.prepare(`
            INSERT INTO shared_models (
                id, name, source, model, endpoint, secret_id, owner_handle,
                temperature, max_tokens, top_p, presence_penalty, frequency_penalty,
                input_price_micros, output_price_micros, enabled, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, source = excluded.source, model = excluded.model,
                endpoint = excluded.endpoint, secret_id = excluded.secret_id,
                owner_handle = excluded.owner_handle, temperature = excluded.temperature,
                max_tokens = excluded.max_tokens, top_p = excluded.top_p,
                presence_penalty = excluded.presence_penalty,
                frequency_penalty = excluded.frequency_penalty,
                input_price_micros = excluded.input_price_micros,
                output_price_micros = excluded.output_price_micros,
                enabled = excluded.enabled, sort_order = excluded.sort_order,
                updated_at = excluded.updated_at
        `).run(
            id, name, source, model, values.endpoint, values.secretId, ownerHandle,
            values.temperature, values.maxTokens, values.topP, values.presencePenalty,
            values.frequencyPenalty, values.inputPrice, values.outputPrice, values.enabled,
            values.sortOrder, existing?.created_at || now, now,
        );
        const saved = db.prepare('SELECT * FROM shared_models WHERE id = ?').get(id);
        return response.json(modelView(saved, {
            includePrivate: saved.owner_handle === request.user.profile.handle,
            includeAdminState: true,
        }));
    } catch (error) {
        console.error('AIBAR model save failed:', error);
        return response.status(400).json({ error: publicError(error, '模型保存失败') });
    }
});

router.post('/admin/models/delete', requireAdminMiddleware, (request, response) => {
    try {
        const result = getCommunityDb().prepare('DELETE FROM shared_models WHERE id = ?')
            .run(String(request.body.id || ''));
        if (!result.changes) return response.status(404).json({ error: '模型不存在' });
        return response.sendStatus(204);
    } catch (error) {
        console.error('AIBAR model delete failed:', error);
        return response.status(400).json({ error: publicError(error, '模型删除失败') });
    }
});

router.post('/admin/models/test', requireAdminMiddleware, async (request, response) => {
    try {
        const model = getCommunityDb().prepare('SELECT * FROM shared_models WHERE id = ?')
            .get(String(request.body.id || ''));
        if (!model) return response.status(404).json({ error: '共享模型不存在' });
        if (!isSupportedSharedModelSource(model.source)) {
            return response.status(400).json({ error: '共享模型渠道不受支持' });
        }
        const owner = await storage.getItem(toKey(model.owner_handle));
        if (!owner?.enabled || !owner.admin) {
            return response.status(503).json({ error: '模型所属管理员账号不可用' });
        }
        const directories = getUserDirectories(owner.handle);
        request.body = {};
        applySharedModel(request.body, model, directories);
        request.user = { ...request.user, profile: owner, directories };
        return await checkChatCompletionStatus(request, response);
    } catch (error) {
        console.error('AIBAR model test failed:', error);
        return response.status(500).json({ error: publicError(error, '模型连通性测试失败') });
    }
});

const generateRateLimiter = createUserRateLimiter({ points: 20, duration: 60, message: '生成请求过于频繁，请稍后再试' });

router.post('/models/generate', generateRateLimiter, async (request, response) => {
    const userHandle = String(request.user?.profile?.handle || '');
    // 每个用户最多同时进行 3 个共享生成请求，防止并发挤占共享额度。
    const activeCount = activeGenerationCounts.get(userHandle) || 0;
    if (activeCount >= GENERATE_MAX_CONCURRENCY) {
        return response.status(429).json({ error: { message: '同时进行的生成请求过多，请等待现有回复完成' } });
    }
    activeGenerationCounts.set(userHandle, activeCount + 1);

    let reservation;
    try {
        if (!request.body || typeof request.body !== 'object') {
            return response.status(400).json({ error: { message: '请求内容无效' } });
        }
        const messagesError = validateGenerationMessages(request.body.messages);
        if (messagesError) {
            return response.status(400).json({ error: { message: messagesError } });
        }
        const modelId = String(request.body?.aibar_model_id || '').trim();
        const model = getCommunityDb().prepare('SELECT * FROM shared_models WHERE id = ? AND enabled = 1').get(modelId);
        if (!model) return response.status(404).json({ error: { message: '共享模型不存在或已停用' } });
        if (!isSupportedSharedModelSource(model.source)) {
            return response.status(400).json({ error: { message: '共享模型渠道不受支持' } });
        }
        const owner = await storage.getItem(toKey(model.owner_handle));
        if (!owner?.enabled || !owner.admin) {
            return response.status(503).json({ error: { message: '模型所属管理员账号不可用' } });
        }

        const reservationInputTokens = estimateInputTokens(request.body.messages);
        const settlementInputTokens = estimateSettlementInputTokens(request.body.messages);
        const maxOutputTokens = Math.round(clampNumber(
            request.body.max_tokens,
            1,
            Number(model.max_tokens),
            Number(model.max_tokens),
        ));
        reservation = reserveGeneration(request.user.profile.handle, model, reservationInputTokens, maxOutputTokens);
        instrumentResponse(response, capture => settleGeneration(reservation, model, capture, settlementInputTokens));
        request.body = trustedGenerationBody(request.body, maxOutputTokens);
        const directories = getUserDirectories(owner.handle);
        applySharedModel(request.body, model, directories);
        request.user = {
            ...request.user,
            profile: owner,
            directories,
        };
        return await generateChatCompletion(request, response);
    } catch (error) {
        if (error.code === 'INSUFFICIENT_POINTS') {
            return response.status(402).json({
                error: { message: error.message },
                code: error.code,
                available: microsToPoints(error.availableMicros),
                required: microsToPoints(error.requiredMicros),
            });
        }
        console.error('AIBAR shared generation failed:', error);
        // 流式响应已经开始发送时不能再写状态码，直接结束响应即可。
        if (response.headersSent) {
            return response.end();
        }
        return response.status(500).json({ error: { message: publicError(error, '生成请求失败，请稍后重试') } });
    } finally {
        const current = activeGenerationCounts.get(userHandle) || 1;
        if (current <= 1) {
            activeGenerationCounts.delete(userHandle);
        } else {
            activeGenerationCounts.set(userHandle, current - 1);
        }
    }
});

router.post('/points/me', (request, response) => {
    try {
        const db = getCommunityDb();
        releaseStaleReservations(db);
        const account = ensurePointAccount(db, request.user.profile.handle);
        const ledger = db.prepare(`
            SELECT * FROM point_ledger WHERE user_handle = ? ORDER BY created_at DESC LIMIT 50
        `).all(request.user.profile.handle).map(row => ({
            id: row.id,
            delta: microsToPoints(row.delta_micros),
            balanceAfter: microsToPoints(row.balance_after_micros),
            kind: row.kind,
            referenceId: row.reference_id,
            detail: safeJson(row.detail_json, {}),
            createdAt: row.created_at,
        }));
        return response.json({ ...accountView(account), ledger });
    } catch (error) {
        console.error('AIBAR point balance failed:', error);
        return response.sendStatus(500);
    }
});

const redeemRateLimiter = createUserRateLimiter({ points: 10, duration: 60 * 60, message: '兑换尝试过于频繁，请一小时后再试' });

router.post('/points/redeem', redeemRateLimiter, (request, response) => {
    try {
        const code = String(request.body.code || '').trim();
        if (!code) return response.status(400).json({ error: '请输入额度卡兑换码' });
        const db = getCommunityDb();
        const handle = request.user.profile.handle;
        const redeemed = db.transaction(() => {
            const card = db.prepare(`
                SELECT * FROM credit_codes
                WHERE code_hash = ? AND enabled = 1 AND redeemed_by IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
            `).get(hashInviteCode(code), nowIso());
            if (!card) throw new Error('兑换码无效、已使用或已过期');
            const account = ensurePointAccount(db, handle);
            const balanceAfter = Number(account.balance_micros) + Number(card.amount_micros);
            if (!Number.isSafeInteger(balanceAfter)) throw new Error('积分余额已达到系统上限');
            const now = nowIso();
            const update = db.prepare(`
                UPDATE credit_codes SET redeemed_by = ?, redeemed_at = ?
                WHERE id = ? AND redeemed_by IS NULL
            `).run(handle, now, card.id);
            if (!update.changes) throw new Error('兑换码已被使用');
            db.prepare(`
                UPDATE point_accounts SET balance_micros = ?, updated_at = ? WHERE user_handle = ?
            `).run(balanceAfter, now, handle);
            db.prepare(`
                INSERT INTO point_ledger (
                    id, user_handle, delta_micros, balance_after_micros, kind,
                    reference_id, detail_json, created_at
                ) VALUES (?, ?, ?, ?, 'redemption', ?, ?, ?)
            `).run(
                crypto.randomUUID(), handle, card.amount_micros, balanceAfter,
                card.id, JSON.stringify({ label: card.label }), now,
            );
            return db.prepare('SELECT * FROM point_accounts WHERE user_handle = ?').get(handle);
        })();
        return response.json(accountView(redeemed));
    } catch (error) {
        return response.status(400).json({ error: publicError(error, '兑换失败，请稍后再试') });
    }
});

function createCreditCode() {
    const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `POINTS-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

router.post('/admin/points/codes/create', requireAdminMiddleware, (request, response) => {
    try {
        const amountMicros = pointsToMicros(request.body.amount);
        const count = Math.round(clampNumber(request.body.count, 1, 100, 1));
        const label = String(request.body.label || '').trim().slice(0, 100);
        const expiresAt = request.body.expiresAt ? new Date(request.body.expiresAt).toISOString() : null;
        if (amountMicros <= 0) return response.status(400).json({ error: '积分必须大于 0' });
        const db = getCommunityDb();
        const createdAt = nowIso();
        const cards = [];
        const insert = db.prepare(`
            INSERT INTO credit_codes (
                id, code_hash, label, amount_micros, created_by, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        db.transaction(() => {
            for (let index = 0; index < count; index += 1) {
                const code = createCreditCode();
                const id = crypto.randomUUID();
                insert.run(
                    id, hashInviteCode(code), label, amountMicros,
                    request.user.profile.handle, expiresAt, createdAt,
                );
                cards.push({ id, code, label, amount: microsToPoints(amountMicros), expiresAt, createdAt });
            }
        })();
        return response.status(201).json({ cards });
    } catch (error) {
        console.error('AIBAR credit code creation failed:', error);
        return response.status(400).json({ error: publicError(error, '额度卡创建失败') });
    }
});

router.post('/admin/points/codes/toggle', requireAdminMiddleware, (request, response) => {
    try {
        const result = getCommunityDb().prepare(`
            UPDATE credit_codes SET enabled = ? WHERE id = ? AND redeemed_by IS NULL
        `).run(request.body.enabled === false ? 0 : 1, String(request.body.id || ''));
        if (!result.changes) return response.status(404).json({ error: '额度卡不存在或已兑换' });
        return response.sendStatus(204);
    } catch (error) {
        return response.status(400).json({ error: publicError(error, '额度卡更新失败') });
    }
});

router.post('/admin/points/overview', requireAdminMiddleware, async (_request, response) => {
    try {
        const db = getCommunityDb();
        releaseStaleReservations(db);
        const users = await storage.values(item => item.key.startsWith(KEY_PREFIX));
        const accounts = users.map(user => {
            const account = ensurePointAccount(db, user.handle);
            return { handle: user.handle, name: user.name, ...accountView(account) };
        });
        const cards = db.prepare(`
            SELECT * FROM credit_codes ORDER BY created_at DESC LIMIT 300
        `).all().map(row => ({
            id: row.id,
            label: row.label,
            amount: microsToPoints(row.amount_micros),
            enabled: Boolean(row.enabled),
            expiresAt: row.expires_at,
            redeemedBy: row.redeemed_by,
            redeemedAt: row.redeemed_at,
            createdAt: row.created_at,
        }));
        return response.json({ accounts, cards });
    } catch (error) {
        console.error('AIBAR point overview failed:', error);
        return response.sendStatus(500);
    }
});
