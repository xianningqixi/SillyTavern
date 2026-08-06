import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import storage from 'node-persist';

import {
    ensurePublicDirectoriesExist,
    getAllUserHandles,
    getUserDirectories,
    toKey,
} from './users.js';
import { checkForNewContent, CONTENT_TYPES } from './endpoints/content-manager.js';

const POINT_SCALE = 1_000_000;

export const INITIAL_POINT_BALANCE = 10_000;
export const INITIAL_POINT_BALANCE_MICROS = INITIAL_POINT_BALANCE * POINT_SCALE;

/**
 * Adds the one-time signup balance inside the caller's database transaction.
 * The partial unique index on point_ledger makes retries idempotent per user.
 * @param {import('better-sqlite3').Database} db Community database
 * @param {string} handle User handle
 * @param {string} registrationId Registration request id
 * @param {string} createdAt ISO timestamp
 */
export function grantInitialPoints(db, handle, registrationId, createdAt = new Date().toISOString()) {
    const existingGrant = db.prepare(`
        SELECT 1 FROM point_ledger WHERE user_handle = ? AND kind = 'signup_bonus'
    `).get(handle);
    if (existingGrant) {
        return db.prepare('SELECT * FROM point_accounts WHERE user_handle = ?').get(handle);
    }

    db.prepare(`
        INSERT OR IGNORE INTO point_accounts (user_handle, balance_micros, held_micros, updated_at)
        VALUES (?, 0, 0, ?)
    `).run(handle, createdAt);
    const account = db.prepare('SELECT * FROM point_accounts WHERE user_handle = ?').get(handle);
    const balanceAfter = Number(account.balance_micros) + INITIAL_POINT_BALANCE_MICROS;
    if (!Number.isSafeInteger(balanceAfter)) throw new Error('积分余额已达到系统上限');

    db.prepare(`
        UPDATE point_accounts SET balance_micros = ?, updated_at = ? WHERE user_handle = ?
    `).run(balanceAfter, createdAt, handle);
    db.prepare(`
        INSERT INTO point_ledger (
            id, user_handle, delta_micros, balance_after_micros, kind,
            reference_id, detail_json, created_at
        ) VALUES (?, ?, ?, ?, 'signup_bonus', ?, ?, ?)
    `).run(
        crypto.randomUUID(),
        handle,
        INITIAL_POINT_BALANCE_MICROS,
        balanceAfter,
        registrationId,
        JSON.stringify({ amount: INITIAL_POINT_BALANCE, reason: 'new_user_initial_balance' }),
        createdAt,
    );
    return db.prepare('SELECT * FROM point_accounts WHERE user_handle = ?').get(handle);
}

/**
 * Creates the SillyTavern account and its initial settings behind a claim marker.
 * @param {{ handle: string, name: string, passwordHash: string, passwordSalt: string, claimToken: string }} input Account fields
 */
export async function provisionRegistrationAccount(input) {
    const handles = await getAllUserHandles();
    if (handles.includes(input.handle) || await storage.getItem(toKey(input.handle))) {
        const error = new Error('账号已存在，无法重复注册');
        error.statusCode = 409;
        throw error;
    }

    const user = {
        handle: input.handle,
        name: input.name,
        created: Date.now(),
        password: input.passwordHash,
        salt: input.passwordSalt,
        admin: false,
        enabled: true,
        _aibarApprovalClaim: input.claimToken,
    };
    const directories = getUserDirectories(user.handle);
    const provisioned = {
        handle: user.handle,
        root: directories.root,
        removeRoot: !fs.existsSync(directories.root),
        token: input.claimToken,
    };

    try {
        await storage.setItem(toKey(user.handle), user);
        await ensurePublicDirectoriesExist();
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        if (!fs.existsSync(path.join(directories.root, 'settings.json'))) {
            throw new Error('账号初始化失败：未能创建设置文件');
        }
        return provisioned;
    } catch (error) {
        const rolledBack = await rollbackRegistrationAccount(provisioned);
        error.aibarAccountRollbackSucceeded = rolledBack;
        throw error;
    }
}

/** @param {{ handle: string, token: string }} provisioned Provisioning claim */
export async function finalizeRegistrationAccount(provisioned) {
    const stored = await storage.getItem(toKey(provisioned.handle));
    if (stored?._aibarApprovalClaim === provisioned.token) {
        delete stored._aibarApprovalClaim;
        await storage.setItem(toKey(provisioned.handle), stored);
    }
}

/**
 * Removes only the account created by the matching claim.
 * @param {{ handle: string, root: string, removeRoot: boolean, token: string }} provisioned Provisioning claim
 */
export async function rollbackRegistrationAccount(provisioned) {
    let accountRemoved = false;
    try {
        const stored = await storage.getItem(toKey(provisioned.handle));
        if (!stored) {
            accountRemoved = true;
        } else if (stored._aibarApprovalClaim === provisioned.token) {
            await storage.removeItem(toKey(provisioned.handle));
            accountRemoved = true;
        }
    } catch (error) {
        console.error('AIBAR registration account rollback failed:', error);
        return false;
    }

    if (provisioned.removeRoot && accountRemoved) {
        try {
            await fs.promises.rm(provisioned.root, { recursive: true, force: true });
        } catch (error) {
            console.error('AIBAR registration directory rollback failed:', error);
        }
    }
    return accountRemoved;
}
