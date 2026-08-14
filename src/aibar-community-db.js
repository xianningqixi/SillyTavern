import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

let communityDb;

const schema = `
CREATE TABLE IF NOT EXISTS works (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('character', 'story', 'mod')),
    author_handle TEXT NOT NULL,
    author_name TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    latest_version_id TEXT,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
    published_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_versions (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    version_note TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    asset_path TEXT NOT NULL,
    cover_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (work_id, version_number)
);

CREATE TABLE IF NOT EXISTS work_tags (
    version_id TEXT NOT NULL REFERENCES work_versions(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (version_id, tag)
);

CREATE TABLE IF NOT EXISTS discord_import_batches (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL DEFAULT '',
    manifest_json TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (guild_id, channel_id, synced_at, requested_by)
);

CREATE TABLE IF NOT EXISTS discord_import_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES discord_import_batches(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source_author_name TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    resource_kind TEXT NOT NULL DEFAULT 'character-card' CHECK (resource_kind IN ('character-card', 'web-app')),
    availability TEXT NOT NULL CHECK (availability IN ('ready', 'browser', 'unsupported')),
    file_name TEXT NOT NULL DEFAULT '',
    file_sha256 TEXT NOT NULL DEFAULT '',
    raw_asset_path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'downloading', 'validated', 'published', 'duplicate', 'skipped', 'failed'
    )),
    error_message TEXT NOT NULL DEFAULT '',
    work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
    work_version_id TEXT REFERENCES work_versions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (batch_id, card_id)
);

CREATE TABLE IF NOT EXISTS favorites (
    user_handle TEXT NOT NULL,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_handle, work_id)
);

CREATE TABLE IF NOT EXISTS ratings (
    user_handle TEXT NOT NULL,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_handle, work_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    user_handle TEXT NOT NULL,
    user_name TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS launch_events (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES work_versions(id) ON DELETE CASCADE,
    user_handle TEXT NOT NULL,
    private_source_id TEXT NOT NULL,
    private_chat_id TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
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

CREATE TABLE IF NOT EXISTS registration_requests (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    invite_id TEXT REFERENCES invites(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    review_note TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS shared_models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    endpoint TEXT NOT NULL DEFAULT '',
    secret_id TEXT NOT NULL DEFAULT '',
    owner_handle TEXT NOT NULL,
    temperature REAL NOT NULL DEFAULT 0.7,
    max_tokens INTEGER NOT NULL DEFAULT 4096,
    top_p REAL NOT NULL DEFAULT 1,
    presence_penalty REAL NOT NULL DEFAULT 0,
    frequency_penalty REAL NOT NULL DEFAULT 0,
    input_price_micros INTEGER NOT NULL DEFAULT 0 CHECK (input_price_micros >= 0),
    output_price_micros INTEGER NOT NULL DEFAULT 0 CHECK (output_price_micros >= 0),
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS point_accounts (
    user_handle TEXT PRIMARY KEY,
    balance_micros INTEGER NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
    held_micros INTEGER NOT NULL DEFAULT 0 CHECK (held_micros >= 0),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
    created_by TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    redeemed_by TEXT,
    redeemed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS point_ledger (
    id TEXT PRIMARY KEY,
    user_handle TEXT NOT NULL,
    delta_micros INTEGER NOT NULL,
    balance_after_micros INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reference_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_usage (
    id TEXT PRIMARY KEY,
    user_handle TEXT NOT NULL,
    model_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reserved_micros INTEGER NOT NULL DEFAULT 0,
    charged_micros INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'completed', 'failed')),
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    completed_at TEXT
);

-- Reserved for a later LiteLLM virtual-key and per-user budget integration.
CREATE TABLE IF NOT EXISTS user_budgets (
    user_handle TEXT PRIMARY KEY,
    litellm_user_id TEXT,
    litellm_key_alias TEXT,
    monthly_budget REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_works_latest ON works(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_works_author ON works(author_handle, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_works_type ON works(type);
CREATE INDEX IF NOT EXISTS idx_favorites_work ON favorites(work_id);
CREATE INDEX IF NOT EXISTS idx_ratings_work ON ratings(work_id);
CREATE INDEX IF NOT EXISTS idx_comments_work_status ON comments(work_id, status);
CREATE INDEX IF NOT EXISTS idx_versions_work ON work_versions(work_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON work_tags(tag, version_id);
CREATE INDEX IF NOT EXISTS idx_discord_batches_requester ON discord_import_batches(requested_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_discord_items_batch ON discord_import_items(batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_discord_items_source_hash ON discord_import_items(guild_id, channel_id, thread_id, file_sha256);
CREATE INDEX IF NOT EXISTS idx_discord_items_hash ON discord_import_items(file_sha256, status);
CREATE INDEX IF NOT EXISTS idx_discord_items_status ON discord_import_items(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_comments_work ON comments(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_launches_work ON launch_events(work_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registration_requests(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_shared_models_enabled ON shared_models(enabled, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_codes_created ON credit_codes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_point_ledger_user ON point_ledger(user_handle, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_point_ledger_signup_bonus
ON point_ledger(user_handle) WHERE kind = 'signup_bonus';
CREATE INDEX IF NOT EXISTS idx_model_usage_user ON model_usage(user_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_status ON model_usage(status, created_at);
`;

/**
 * SQLite does not update CHECK constraints on an existing table when a
 * CREATE TABLE IF NOT EXISTS statement changes. Rebuild the table so existing
 * community databases can store the new work type without losing rows.
 * @param {import('better-sqlite3').Database} db Community database
 */
function migrateWorksTypeConstraint(db) {
    const table = db.prepare('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = \'works\'').get();
    if (!table?.sql || table.sql.includes('\'mod\'')) return;

    const foreignKeysEnabled = !!db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
        db.exec(`
            BEGIN IMMEDIATE;
            CREATE TABLE works_migration (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK (type IN ('character', 'story', 'mod')),
                author_handle TEXT NOT NULL,
                author_name TEXT NOT NULL,
                title TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                latest_version_id TEXT,
                status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
                published_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO works_migration (
                id, type, author_handle, author_name, title, summary,
                latest_version_id, status, published_at, updated_at
            )
            SELECT
                id, type, author_handle, author_name, title, summary,
                latest_version_id, status, published_at, updated_at
            FROM works;
            DROP TABLE works;
            ALTER TABLE works_migration RENAME TO works;
            -- DROP TABLE 连带删掉了 works 的索引，迁移自己负责重建。
            CREATE INDEX IF NOT EXISTS idx_works_latest ON works(status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_works_author ON works(author_handle, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_works_type ON works(type);
            COMMIT;
        `);
    } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
    } finally {
        db.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
    }

    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
        throw new Error('AIBAR community database migration failed foreign key validation');
    }
}

/**
 * Allows review-based registrations to be submitted without an invite code.
 * @param {import('better-sqlite3').Database} db Community database
 */
function migrateRegistrationInviteConstraint(db) {
    const table = db.prepare('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = \'registration_requests\'').get();
    if (!table?.sql || !/invite_id\s+TEXT\s+NOT\s+NULL/i.test(table.sql)) return;

    const foreignKeysEnabled = !!db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
        db.exec(`
            BEGIN IMMEDIATE;
            CREATE TABLE registration_requests_migration (
                id TEXT PRIMARY KEY,
                handle TEXT NOT NULL,
                name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                invite_id TEXT REFERENCES invites(id),
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
                review_note TEXT NOT NULL DEFAULT '',
                reviewed_by TEXT,
                created_at TEXT NOT NULL,
                reviewed_at TEXT
            );
            INSERT INTO registration_requests_migration (
                id, handle, name, password_hash, password_salt, invite_id,
                status, review_note, reviewed_by, created_at, reviewed_at
            )
            SELECT
                id, handle, name, password_hash, password_salt, invite_id,
                status, review_note, reviewed_by, created_at, reviewed_at
            FROM registration_requests;
            DROP TABLE registration_requests;
            ALTER TABLE registration_requests_migration RENAME TO registration_requests;
            COMMIT;
        `);
    } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
    } finally {
        db.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
    }

    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
        throw new Error('AIBAR registration database migration failed foreign key validation');
    }
}

/**
 * Keeps only one active registration per handle before enforcing the partial
 * unique index. Approved rows win over pending rows; otherwise the oldest
 * request remains active.
 * @param {import('better-sqlite3').Database} db Community database
 */
function migrateRegistrationHandleConstraint(db) {
    const duplicateHandles = db.prepare(`
        SELECT handle FROM registration_requests
        WHERE status IN ('pending', 'approved')
        GROUP BY handle HAVING COUNT(*) > 1
    `).all();
    const migratedAt = new Date().toISOString();

    db.transaction(() => {
        const reject = db.prepare(`
            UPDATE registration_requests
            SET status = 'rejected',
                review_note = '同账号的重复申请已在数据库迁移时自动关闭',
                reviewed_by = COALESCE(reviewed_by, 'system'),
                reviewed_at = ?,
                password_hash = '',
                password_salt = ''
            WHERE id = ?
        `);
        for (const { handle } of duplicateHandles) {
            const rows = db.prepare(`
                SELECT id FROM registration_requests
                WHERE handle = ? AND status IN ('pending', 'approved')
                ORDER BY
                    CASE status WHEN 'approved' THEN 0 ELSE 1 END,
                    CASE WHEN status = 'approved' THEN datetime(reviewed_at) END DESC,
                    datetime(created_at) ASC,
                    id ASC
            `).all(handle);
            for (const row of rows.slice(1)) reject.run(migratedAt, row.id);
        }
        db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_active_handle
            ON registration_requests(handle)
            WHERE status IN ('pending', 'approved')
        `);
    })();
}

function clearReviewedRegistrationCredentials(db) {
    db.prepare(`
        UPDATE registration_requests
        SET password_hash = '', password_salt = ''
        WHERE status <> 'pending' AND (password_hash <> '' OR password_salt <> '')
    `).run();
}

/**
 * 有序迁移列表，游标记录在 PRAGMA user_version 里。
 *
 * 历史包袱：user_version 机制引入之前的库停留在 0，但四个存量迁移全部幂等
 * （字符串嗅探/IF NOT EXISTS/无条件 UPDATE），所以旧库首次升级会安全地重放
 * 一遍，然后写入版本号；之后每次启动只比较一个整数，不再全量扫描。
 * 新增迁移时在列表末尾追加严格递增的 version，不要修改已发布的条目。
 */
const MIGRATIONS = [
    { version: 1, run: migrateWorksTypeConstraint },
    { version: 2, run: migrateRegistrationInviteConstraint },
    { version: 3, run: migrateRegistrationHandleConstraint },
];

function runMigrations(db) {
    const current = Number(db.pragma('user_version', { simple: true })) || 0;
    for (const migration of MIGRATIONS) {
        if (migration.version <= current) continue;
        migration.run(db);
        db.pragma(`user_version = ${migration.version}`);
    }
}

export function getCommunityRoot() {
    const dataRoot = globalThis.DATA_ROOT || path.resolve(process.cwd(), 'data');
    const root = path.resolve(dataRoot, '_aibar');
    fs.mkdirSync(root, { recursive: true });
    return root;
}

export function createCommunityDatabase(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new Database(filePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(schema);
    runMigrations(db);
    // 凭据清除是安全兜底而非一次性迁移：即使未来某条审核路径忘记清空
    // 密码哈希，下次启动也会补救，所以每次都跑（小表全扫，代价可忽略）。
    clearReviewedRegistrationCredentials(db);
    return db;
}

export function getCommunityDb() {
    if (!communityDb) {
        communityDb = createCommunityDatabase(path.join(getCommunityRoot(), 'community.sqlite'));
    }
    return communityDb;
}

/**
 * 进程退出前把 WAL 合并回主库并关闭连接。没有 checkpoint 的话 WAL 会无限增长，
 * 且"只拷 .sqlite 文件"的临时备份会丢掉 WAL 里未合并的数据。
 * server-main 的优雅退出最终调用 process.exit()，'exit' 事件里允许同步收尾。
 */
export function closeCommunityDb() {
    if (!communityDb) return;
    try {
        // 测试等场景可能已经手动 close 过单例，跳过即可。
        if (communityDb.open) {
            communityDb.pragma('wal_checkpoint(TRUNCATE)');
            communityDb.close();
        }
    } catch (error) {
        console.error('AIBAR community database close failed:', error);
    } finally {
        communityDb = undefined;
    }
}

process.once('exit', closeCommunityDb);

export function hashInviteCode(code) {
    return crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');
}
