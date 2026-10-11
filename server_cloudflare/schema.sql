-- 青鸟平台服务端 · D1 建表。
-- 与 Go 版（server/internal/store/store.go 的 migrate）逐字段一致；多一张 ide_pairs
-- （一次性授权码——Go 版存内存，Workers 无常驻内存，落库；取出即删保证一次性）。
-- 执行：wrangler d1 execute qingniao --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL UNIQUE,
    password      TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'member',
    points        INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT '',
    token_hash   TEXT NOT NULL UNIQUE,
    ip_address   TEXT NOT NULL DEFAULT '',
    user_agent   TEXT NOT NULL DEFAULT '',
    expires_at   TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip_address  TEXT NOT NULL DEFAULT '',
    device      TEXT NOT NULL DEFAULT '',
    user_agent  TEXT NOT NULL DEFAULT '',
    login_at    TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- 一台青鸟桌面端 = 一行。token 进二维码，secret 只给桌面端自己。
CREATE TABLE IF NOT EXISTS ide_devices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT '',
    platform        TEXT NOT NULL DEFAULT '',
    token           TEXT NOT NULL UNIQUE,
    secret          TEXT NOT NULL DEFAULT '',
    lan_url         TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_seen_at    TEXT,
    mobile_seen_at  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ide_devices_user ON ide_devices(user_id, enabled);

-- 手机下发的一条指令的命运流水。
CREATE TABLE IF NOT EXISTS ide_rpcs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    INTEGER NOT NULL REFERENCES ide_devices(id) ON DELETE CASCADE,
    method       TEXT NOT NULL DEFAULT '',
    params       TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    result       TEXT,
    error        TEXT,
    picked_at    TEXT,
    finished_at  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ide_rpcs_device_status ON ide_rpcs(device_id, status);

-- 桌面端推上来的内核事件，手机按自增 id 作游标增量拉取。只留 5 分钟（写入时顺手清）。
CREATE TABLE IF NOT EXISTS ide_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL REFERENCES ide_devices(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT '',
    payload     TEXT,
    created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ide_events_device_id ON ide_events(device_id, id);

-- 一次性授权码（网页登录 → 桌面端换 token）。10 分钟过期，取出即删。
CREATE TABLE IF NOT EXISTS ide_pairs (
    code        TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device      TEXT,
    expires_at  TEXT NOT NULL
);

-- 模型库：对外可见的「模型名」清单。
CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    builtin     INTEGER NOT NULL DEFAULT 0,
    ratio       REAL NOT NULL DEFAULT 1,
    enabled     INTEGER NOT NULL DEFAULT 1,
    remark      TEXT NOT NULL DEFAULT '',
    sort        INTEGER NOT NULL DEFAULT 0,
    free        INTEGER NOT NULL DEFAULT 0,
    discount    REAL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 上游：一个 OpenAI 兼容服务。
CREATE TABLE IF NOT EXISTS ai_upstreams (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL DEFAULT '',
    driver           TEXT NOT NULL DEFAULT 'openai',
    base_url         TEXT NOT NULL DEFAULT '',
    enabled          INTEGER NOT NULL DEFAULT 1,
    sort             INTEGER NOT NULL DEFAULT 0,
    remark           TEXT NOT NULL DEFAULT '',
    models_synced_at TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- 上游 API Key：一个上游可配多把，网关按状态择优、失败自动切换。
CREATE TABLE IF NOT EXISTS ai_upstream_keys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    upstream_id     INTEGER NOT NULL REFERENCES ai_upstreams(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT '',
    api_key         TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'unknown',
    latency_ms      INTEGER,
    last_error      TEXT,
    last_checked_at TEXT,
    last_used_at    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- 上游自动获取到的模型。model_id 为空表示还没匹配到模型库。
CREATE TABLE IF NOT EXISTS ai_upstream_models (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    upstream_id     INTEGER NOT NULL REFERENCES ai_upstreams(id) ON DELETE CASCADE,
    model_id        INTEGER REFERENCES ai_models(id) ON DELETE SET NULL,
    model           TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'unknown',
    latency_ms      INTEGER,
    last_error      TEXT,
    last_checked_at TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aum_upstream ON ai_upstream_models(upstream_id);
CREATE INDEX IF NOT EXISTS idx_aum_model ON ai_upstream_models(model_id);

-- 一次网关调用的用量流水。
CREATE TABLE IF NOT EXISTS ai_usages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    device_id         INTEGER REFERENCES ide_devices(id) ON DELETE SET NULL,
    model             TEXT NOT NULL DEFAULT '',
    ratio             REAL NOT NULL DEFAULT 1,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    points            INTEGER NOT NULL DEFAULT 0,
    source            TEXT NOT NULL DEFAULT 'ide',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usages_user ON ai_usages(user_id, created_at);

-- 积分账本流水。
CREATE TABLE IF NOT EXISTS point_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    change       INTEGER NOT NULL DEFAULT 0,
    after        INTEGER NOT NULL DEFAULT 0,
    type         TEXT NOT NULL DEFAULT '',
    remark       TEXT NOT NULL DEFAULT '',
    operator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- 模型健康探测明细与按天聚合。
CREATE TABLE IF NOT EXISTS ai_model_health_checks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    upstream_model_id INTEGER NOT NULL REFERENCES ai_upstream_models(id) ON DELETE CASCADE,
    ok                INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER,
    error             TEXT,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_model_health_days (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id   INTEGER NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    total      INTEGER NOT NULL DEFAULT 0,
    ok         INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(model_id, day)
);

-- 系统配置 KV。
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- 邮箱验证码（注册 / 验证码登录 / 超管换邮箱）：email+purpose 一行，验证通过或作废时删除；
-- attempts 防暴力试码（错 5 次作废），created_at 兼作 60 秒重发节流的依据。
CREATE TABLE IF NOT EXISTS mail_codes (
    email       TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    code        TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (email, purpose)
);
