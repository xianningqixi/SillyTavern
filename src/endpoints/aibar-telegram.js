import express from 'express';

import { requireAdminMiddleware } from '../users.js';
import { getConfigValue } from '../util.js';
import { readSecret, SECRET_KEYS, writeSecret } from './secrets.js';

export const router = express.Router();

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ROUTES = new Map([
    ['/telegram/status', { method: 'GET', upstream: '/api/status' }],
    ['/telegram/config', { method: 'POST', upstream: '/api/config' }],
    ['/telegram/polling/restart', { method: 'POST', upstream: '/api/polling/restart' }],
    ['/telegram/debug/telegram', { method: 'POST', upstream: '/api/debug/telegram' }],
    ['/telegram/debug/st', { method: 'POST', upstream: '/api/debug/st' }],
    ['/telegram/debug/full', { method: 'POST', upstream: '/api/debug/full' }],
]);

function companionBaseUrl() {
    const configured = String(getConfigValue('aibar.telegramBotAdminUrl', 'http://127.0.0.1:8787') || '').trim();
    const url = new URL(configured);
    const hostname = url.hostname.toLowerCase();
    if (
        url.protocol !== 'http:'
        || url.username
        || url.password
        || url.search
        || url.hash
        || !['127.0.0.1', 'localhost', '::1'].includes(hostname)
    ) {
        throw new Error('aibar.telegramBotAdminUrl must be a loopback HTTP URL');
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
}

function adminToken(request) {
    const supplied = typeof request.body?.adminToken === 'string'
        ? request.body.adminToken.trim()
        : '';
    if (supplied && supplied.length < 24) {
        const error = new Error('Admin Token 至少需要 24 位');
        error.status = 400;
        throw error;
    }
    return {
        supplied,
        token: supplied || readSecret(request.user.directories, SECRET_KEYS.AIBAR_TELEGRAM_ADMIN),
    };
}

async function readLimitedResponse(response) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE_BYTES) throw new Error('Telegram companion response is too large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Telegram companion response is too large');
    const text = new TextDecoder().decode(bytes);
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { message: text.slice(0, 1000) };
    }
}

router.use('/telegram', requireAdminMiddleware);
async function proxyCompanionRequest(request, response) {
    response.set('Cache-Control', 'no-store');
    const route = ROUTES.get(request.path);
    if (!route) return response.sendStatus(404);

    try {
        const credentials = adminToken(request);
        if (!credentials.token) {
            return response.status(428).json({
                message: '请先输入 Telegram companion 的 Admin Token',
            });
        }

        const target = new URL(route.upstream, companionBaseUrl());
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let upstream;
        try {
            const body = { ...(request.body || {}) };
            delete body.adminToken;
            delete body.stBaseUrl;
            upstream = await fetch(target, {
                method: route.method,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'X-AIBAR-Admin-Token': credentials.token,
                },
                ...(route.method === 'POST' ? { body: JSON.stringify(body) } : {}),
            });
        } finally {
            clearTimeout(timeout);
        }

        const payload = await readLimitedResponse(upstream);
        if (upstream.ok && credentials.supplied) {
            writeSecret(request.user.directories, SECRET_KEYS.AIBAR_TELEGRAM_ADMIN, credentials.supplied);
        }
        return response.status(upstream.status).json(payload || { ok: upstream.ok });
    } catch (error) {
        const timedOut = error?.name === 'AbortError';
        console.warn('AIBAR Telegram companion proxy failed:', timedOut ? 'timeout' : error?.message || error);
        return response.status(error?.status || (timedOut ? 504 : 502)).json({
            message: timedOut ? 'Telegram companion 请求超时' : String(error?.message || 'Telegram companion 不可用'),
        });
    }
}

for (const routePath of ROUTES.keys()) {
    router.post(routePath, proxyCompanionRequest);
}
