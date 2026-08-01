import crypto from 'node:crypto';

import express from 'express';
import lodash from 'lodash';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { getCommunityDb, hashInviteCode } from '../aibar-community-db.js';
import { getPasswordHash, getPasswordSalt, getAllUserHandles } from '../users.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import { getConfigValue } from '../util.js';

export const router = express.Router();

const registrationLimiter = new RateLimiterMemory({ points: 8, duration: 60 * 60 });
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const MAX_HANDLE_INPUT_LENGTH = 80;
const MAX_HANDLE_LENGTH = 64;

function slugify(text) {
    return lodash.deburr(String(text ?? '').toLowerCase().trim()).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizeRegistrationHandle(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.length > MAX_HANDLE_INPUT_LENGTH) return '';
    const handle = slugify(raw);
    if (!handle || handle.length > MAX_HANDLE_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)) return '';
    return handle;
}

export function registrationRateLimitKey(request, preferRealIpHeader = PREFER_REAL_IP_HEADER) {
    return getIpAddress(request, preferRealIpHeader);
}

function registrationView(row) {
    const reviewedAt = String(row.reviewed_at || '').startsWith('claim:') ? null : row.reviewed_at;
    return {
        id: row.id,
        handle: row.handle,
        name: row.name,
        status: row.status,
        reviewNote: row.review_note,
        createdAt: row.created_at,
        reviewedAt,
    };
}

router.post('/register', async (request, response) => {
    try {
        await registrationLimiter.consume(registrationRateLimitKey(request));

        const inviteCode = String(request.body.inviteCode || '').trim();
        const handle = normalizeRegistrationHandle(request.body.handle);
        const name = String(request.body.name || '').trim().slice(0, 80);
        const password = String(request.body.password || '');

        if (!inviteCode || !handle || !name || password.length < 8 || password.length > 128) {
            return response.status(400).json({ error: '请填写有效的邀请码、账号、昵称和至少 8 位密码' });
        }

        const handles = await getAllUserHandles();
        if (handles.includes(handle)) {
            return response.status(409).json({ error: '账号已存在' });
        }

        const db = getCommunityDb();
        const invite = db.prepare(`
            SELECT * FROM invites
            WHERE code_hash = ? AND enabled = 1
              AND use_count < max_uses
              AND (expires_at IS NULL OR expires_at > ?)
        `).get(hashInviteCode(inviteCode), new Date().toISOString());
        if (!invite) {
            return response.status(403).json({ error: '邀请码无效、已用完或已过期' });
        }

        const existing = db.prepare(`
            SELECT * FROM registration_requests
            WHERE handle = ? AND status IN ('pending', 'approved')
            ORDER BY created_at DESC LIMIT 1
        `).get(handle);
        if (existing) {
            return response.status(409).json({ error: existing.status === 'pending' ? '该账号正在等待审核' : '账号已通过审核' });
        }

        const id = crypto.randomUUID();
        const salt = getPasswordSalt();
        const now = new Date().toISOString();
        const insert = db.transaction(() => {
            const concurrent = db.prepare(`
                SELECT status FROM registration_requests
                WHERE handle = ? AND status IN ('pending', 'approved')
                LIMIT 1
            `).get(handle);
            if (concurrent) {
                const error = new Error(concurrent.status === 'pending' ? '该账号正在等待审核' : '账号已通过审核');
                error.code = 'REGISTRATION_EXISTS';
                throw error;
            }

            const freshInvite = db.prepare(`
                SELECT * FROM invites
                WHERE id = ? AND enabled = 1 AND use_count < max_uses
                  AND (expires_at IS NULL OR expires_at > ?)
            `).get(invite.id, now);
            if (!freshInvite) throw new Error('Invite is no longer available');

            db.prepare(`
                INSERT INTO registration_requests (
                    id, handle, name, password_hash, password_salt, invite_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(id, handle, name, getPasswordHash(password, salt), salt, invite.id, now);
            db.prepare('UPDATE invites SET use_count = use_count + 1 WHERE id = ?').run(invite.id);
        });
        insert();

        const created = db.prepare('SELECT * FROM registration_requests WHERE id = ?').get(id);
        return response.status(202).json(registrationView(created));
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            return retryAfter(response, error).status(429).json({ error: '提交过于频繁，请稍后再试' });
        }
        if (error.code === 'REGISTRATION_EXISTS') {
            return response.status(409).json({ error: error.message });
        }
        if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
            return response.status(409).json({ error: '该账号已有待审核或已通过的申请' });
        }
        console.error('AIBAR registration failed:', error);
        return response.status(500).json({ error: '注册申请提交失败' });
    }
});

router.post('/registration-status', (request, response) => {
    try {
        const id = String(request.body.id || '').trim();
        if (!id) return response.status(400).json({ error: '缺少申请编号' });

        const row = getCommunityDb().prepare('SELECT * FROM registration_requests WHERE id = ?').get(id);
        if (!row) return response.status(404).json({ error: '没有找到该申请' });
        return response.json(registrationView(row));
    } catch (error) {
        console.error('AIBAR registration status failed:', error);
        return response.sendStatus(500);
    }
});
