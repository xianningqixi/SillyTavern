import crypto from 'node:crypto';

import express from 'express';
import storage from 'node-persist';

import { publicError } from '../aibar-errors.js';
import { getCommunityDb } from '../aibar-community-db.js';
import {
    finalizeRegistrationAccount,
    grantInitialPoints,
    provisionRegistrationAccount,
    rollbackRegistrationAccount,
} from '../aibar-registration.js';
import {
    KEY_PREFIX,
    requireAdminMiddleware,
} from '../users.js';
import { nowIso } from '../aibar-community-shared.js';

export const router = express.Router();

const APPROVAL_CLAIM_PREFIX = 'claim:';
const APPROVAL_CLAIM_TTL_MS = 10 * 60 * 1000;

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

        provisionedAccount = await provisionRegistrationAccount({
            handle: registration.handle,
            name: registration.name,
            passwordHash: registration.password_hash,
            passwordSalt: registration.password_salt,
            claimToken,
        });

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
            grantInitialPoints(db, registration.handle, id, reviewedAt);
        })();
        approvalFinalized = true;

        try {
            await finalizeRegistrationAccount(provisionedAccount);
        } catch (cleanupError) {
            console.error('AIBAR registration approval marker cleanup failed:', cleanupError);
        }

        provisionedAccount = null;
        approvalClaim = null;
        return response.json({ id, status: action, reviewNote, reviewedAt });
    } catch (error) {
        let claimCanBeReleased = true;
        if (provisionedAccount && !approvalFinalized) {
            claimCanBeReleased = await rollbackRegistrationAccount(provisionedAccount);
        } else if (!provisionedAccount && error.aibarAccountRollbackSucceeded === false) {
            claimCanBeReleased = false;
        }
        if (approvalClaim && !approvalFinalized && claimCanBeReleased) {
            approvalClaim.db.prepare(`
                UPDATE registration_requests SET reviewed_by = NULL, reviewed_at = NULL
                WHERE id = ? AND status = 'pending' AND reviewed_at = ?
            `).run(approvalClaim.id, approvalClaim.token);
        }
        console.error('AIBAR registration review failed:', error);
        return response.status(error.statusCode || 400).json({ error: publicError(error, '请求处理失败') });
    }
});
