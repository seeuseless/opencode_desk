// Package store 是 SQLite 数据层。
//
// 设计取舍：
//
//	· 不用 ORM。表结构固定、查询口径必须与契约文档逐字一致（尤其是积分与用量聚合），
//	  手写 SQL 更好核对，也少一层魔法。
//	· 不用 golang-migrate。本地一体化模式下数据库是「跟着安装包走的一次性产物」，
//	  启动时 CREATE TABLE IF NOT EXISTS 就够；独立部署要升级时再引入迁移工具。
//	· 所有时间列存 RFC3339（UTC），读出来按需转本地时区。SQLite 没有原生时间类型，
//	  用 TEXT 存 ISO 串，比较时靠字符串字典序——同一格式下等价于时间序。
package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// DB 包住 *sql.DB，带上本服务的通用设置。
type DB struct {
	*sql.DB
}

// Open 打开（必要时创建）SQLite 库并建表。
func Open(path string) (*DB, error) {
	// WAL：桌面端一边认领指令一边写事件，读写并发比默认 journal 好。
	// busy_timeout：健康采集与网关可能同时写，别一遇锁就报错。
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	db.SetMaxOpenConns(4) // SQLite 单写者，别开太多连接互相锁
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}
	d := &DB{db}
	if err := d.migrate(); err != nil {
		return nil, err
	}
	return d, nil
}

// Now 统一取当前时间（UTC）。
func Now() time.Time { return time.Now().UTC() }

// FormatTime 契约里的 Y-m-d H:i:s。
func FormatTime(t time.Time) string { return t.Local().Format("2006-01-02 15:04:05") }

// FormatMinute 契约里的 Y-m-d H:i（积分流水用）。
func FormatMinute(t time.Time) string { return t.Local().Format("2006-01-02 15:04") }

// FormatDate 契约里的 Y-m-d。
func FormatDate(t time.Time) string { return t.Local().Format("2006-01-02") }

// FormatISO token 过期时间用 ISO8601。
func FormatISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05Z07:00") }

// ParseTime 解析存库的时间串；空串返回零值。
func ParseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

// migrate 建表。幂等，可反复执行。
func (d *DB) migrate() error {
	stmts := []string{
		// 用户。role: admin / member；status: active / disabled
		`CREATE TABLE IF NOT EXISTS users (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			name          TEXT NOT NULL DEFAULT '',
			email         TEXT NOT NULL UNIQUE,
			password      TEXT NOT NULL DEFAULT '',
			role          TEXT NOT NULL DEFAULT 'member',
			points        INTEGER NOT NULL DEFAULT 0,
			status        TEXT NOT NULL DEFAULT 'active',
			created_at    TEXT NOT NULL,
			updated_at    TEXT NOT NULL
		)`,
		// Sanctum 个人访问令牌。token_hash 存 SHA-256（明文只在下发时出现一次）。
		`CREATE TABLE IF NOT EXISTS personal_access_tokens (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name         TEXT NOT NULL DEFAULT '',
			token_hash   TEXT NOT NULL UNIQUE,
			ip_address   TEXT NOT NULL DEFAULT '',
			user_agent   TEXT NOT NULL DEFAULT '',
			expires_at   TEXT,
			created_at   TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS login_logs (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			ip_address  TEXT NOT NULL DEFAULT '',
			device      TEXT NOT NULL DEFAULT '',
			user_agent  TEXT NOT NULL DEFAULT '',
			login_at    TEXT NOT NULL,
			created_at  TEXT NOT NULL
		)`,
		// 一台青鸟桌面端 = 一行。token 进二维码，secret 只给桌面端自己。
		`CREATE TABLE IF NOT EXISTS ide_devices (
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
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ide_devices_user ON ide_devices(user_id, enabled)`,
		// 手机下发的一条指令的命运流水。
		`CREATE TABLE IF NOT EXISTS ide_rpcs (
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
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ide_rpcs_device_status ON ide_rpcs(device_id, status)`,
		// 桌面端推上来的内核事件，手机按自增 id 作游标增量拉取。
		`CREATE TABLE IF NOT EXISTS ide_events (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id   INTEGER NOT NULL REFERENCES ide_devices(id) ON DELETE CASCADE,
			type        TEXT NOT NULL DEFAULT '',
			payload     TEXT,
			created_at  TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ide_events_device_id ON ide_events(device_id, id)`,
		// 模型库：对外可见的「模型名」清单。
		`CREATE TABLE IF NOT EXISTS ai_models (
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
		)`,
		// 上游：一个 OpenAI 兼容服务。
		`CREATE TABLE IF NOT EXISTS ai_upstreams (
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
		)`,
		// 上游 API Key：一个上游可配多把，网关按状态择优、失败自动切换。
		`CREATE TABLE IF NOT EXISTS ai_upstream_keys (
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
		)`,
		// 上游自动获取到的模型。model_id 为空表示还没匹配到模型库。
		`CREATE TABLE IF NOT EXISTS ai_upstream_models (
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
		)`,
		`CREATE INDEX IF NOT EXISTS idx_aum_upstream ON ai_upstream_models(upstream_id)`,
		`CREATE INDEX IF NOT EXISTS idx_aum_model ON ai_upstream_models(model_id)`,
		// 一次网关调用的用量流水。
		`CREATE TABLE IF NOT EXISTS ai_usages (
			id               INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
			device_id        INTEGER REFERENCES ide_devices(id) ON DELETE SET NULL,
			model            TEXT NOT NULL DEFAULT '',
			ratio            REAL NOT NULL DEFAULT 1,
			prompt_tokens    INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens     INTEGER NOT NULL DEFAULT 0,
			points           INTEGER NOT NULL DEFAULT 0,
			source           TEXT NOT NULL DEFAULT 'ide',
			created_at       TEXT NOT NULL,
			updated_at       TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_ai_usages_user ON ai_usages(user_id, created_at)`,
		// 积分账本流水。
		`CREATE TABLE IF NOT EXISTS point_logs (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			change       INTEGER NOT NULL DEFAULT 0,
			after        INTEGER NOT NULL DEFAULT 0,
			type         TEXT NOT NULL DEFAULT '',
			remark       TEXT NOT NULL DEFAULT '',
			operator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
			created_at   TEXT NOT NULL,
			updated_at   TEXT NOT NULL
		)`,
		// 模型健康探测明细与按天聚合。
		`CREATE TABLE IF NOT EXISTS ai_model_health_checks (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			upstream_model_id INTEGER NOT NULL REFERENCES ai_upstream_models(id) ON DELETE CASCADE,
			ok                INTEGER NOT NULL DEFAULT 0,
			latency_ms        INTEGER,
			error             TEXT,
			created_at        TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS ai_model_health_days (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			model_id   INTEGER NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
			day        TEXT NOT NULL,
			total      INTEGER NOT NULL DEFAULT 0,
			ok         INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			UNIQUE(model_id, day)
		)`,
		// 系统配置 KV。
		`CREATE TABLE IF NOT EXISTS settings (
			key        TEXT PRIMARY KEY,
			value      TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	}

	for _, s := range stmts {
		if _, err := d.Exec(s); err != nil {
			return fmt.Errorf("建表失败: %w\nSQL: %s", err, s)
		}
	}
	return nil
}
