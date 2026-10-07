package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 上游 Key 状态。
const (
	KeyStatusUnknown = "unknown"
	KeyStatusOK      = "ok"
	KeyStatusError   = "error"
)

// 上游模型状态。
const (
	ModelStatusUnknown = "unknown"
	ModelStatusOK      = "ok"
	ModelStatusError   = "error"
)

// Upstream 一个 OpenAI 兼容上游服务。
type Upstream struct {
	ID             int64
	Name           string
	Driver         string
	BaseURL        string
	Enabled        bool
	Sort           int64
	Remark         string
	ModelsSyncedAt time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Endpoint 拼上游接口地址。
func (u *Upstream) Endpoint(path string) string {
	base := strings.TrimRight(u.BaseURL, "/")
	if path == "" {
		return base
	}
	return base + "/" + strings.TrimLeft(path, "/")
}

// UpstreamKey 上游的一把 API Key。
type UpstreamKey struct {
	ID            int64
	UpstreamID    int64
	Name          string
	APIKey        string
	Enabled       bool
	Status        string
	LatencyMS     int64
	LastError     string
	LastCheckedAt time.Time
	LastUsedAt    time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// UpstreamModel 上游自动获取到的一个模型。
type UpstreamModel struct {
	ID            int64
	UpstreamID    int64
	ModelID       int64
	Model         string
	Enabled       bool
	Status        string
	LatencyMS     int64
	LastError     string
	LastCheckedAt time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// Model 模型库里的一条（对外可见的模型名）。
type Model struct {
	ID        int64
	Name      string
	Builtin   bool
	Ratio     float64
	Enabled   bool
	Remark    string
	Sort      int64
	Free      bool
	Discount  sql.NullFloat64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// EffectiveRatio 实际计费倍率：限免为 0；有折扣在 ratio 之上再乘一次。
//
// 全平台只有这一个口径——网关扣分、给客户端的价目展示都调它，
// 免得「列表上写着打折、扣费却按原价」这种对不上的情况。
func (m *Model) EffectiveRatio() float64 {
	if m.Free {
		return 0
	}
	discount := 1.0
	if m.Discount.Valid {
		discount = m.Discount.Float64
	}
	return round4(m.Ratio * discount)
}

// DiscountLabel 折扣的展示形式：0.2 → "0.2x"；没折扣返回空串。
func (m *Model) DiscountLabel() string {
	if !m.Discount.Valid {
		return ""
	}
	s := fmt.Sprintf("%g", m.Discount.Float64)
	return s + "x"
}

// Usage 一次网关调用的用量流水。
type Usage struct {
	ID               int64
	UserID           int64
	DeviceID         int64
	Model            string
	Ratio            float64
	PromptTokens     int64
	CompletionTokens int64
	TotalTokens      int64
	Points           int64
	Source           string
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// PointLog 一条积分流水。
type PointLog struct {
	ID         int64
	UserID     int64
	Change     int64
	After      int64
	Type       string
	Remark     string
	OperatorID int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// TypeLabel 变动类型的中文说明。
func (p *PointLog) TypeLabel() string {
	switch p.Type {
	case "consume":
		return "消耗"
	case "grant":
		return "发放"
	default:
		return "调整"
	}
}

// HealthCheck 一次模型健康探测。
type HealthCheck struct {
	ID              int64
	UpstreamModelID int64
	OK              bool
	LatencyMS       int64
	Error           string
	CreatedAt       time.Time
}

// HealthDay 按天聚合的稳定率。
type HealthDay struct {
	ID      int64
	ModelID int64
	Day     string
	Total   int64
	OK      int64
}

const upstreamCols = `id, name, driver, base_url, enabled, sort, remark, models_synced_at, created_at, updated_at`

func scanUpstream(row interface{ Scan(...any) error }) (*Upstream, error) {
	var u Upstream
	var syncedAt, createdAt, updatedAt sql.NullString
	if err := row.Scan(&u.ID, &u.Name, &u.Driver, &u.BaseURL, &u.Enabled, &u.Sort, &u.Remark,
		&syncedAt, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	u.ModelsSyncedAt = ParseTime(syncedAt.String)
	u.CreatedAt = ParseTime(createdAt.String)
	u.UpdatedAt = ParseTime(updatedAt.String)
	return &u, nil
}

const keyCols = `id, upstream_id, name, api_key, enabled, status, latency_ms, last_error, last_checked_at, last_used_at, created_at, updated_at`

func scanKey(row interface{ Scan(...any) error }) (*UpstreamKey, error) {
	var k UpstreamKey
	var latency sql.NullInt64
	var lastErr sql.NullString
	var lastChecked, lastUsed, createdAt, updatedAt sql.NullString
	if err := row.Scan(&k.ID, &k.UpstreamID, &k.Name, &k.APIKey, &k.Enabled, &k.Status, &latency,
		&lastErr, &lastChecked, &lastUsed, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	k.LatencyMS = latency.Int64
	k.LastError = lastErr.String
	k.LastCheckedAt = ParseTime(lastChecked.String)
	k.LastUsedAt = ParseTime(lastUsed.String)
	k.CreatedAt = ParseTime(createdAt.String)
	k.UpdatedAt = ParseTime(updatedAt.String)
	return &k, nil
}

const upstreamModelCols = `id, upstream_id, model_id, model, enabled, status, latency_ms, last_error, last_checked_at, created_at, updated_at`

func scanUpstreamModel(row interface{ Scan(...any) error }) (*UpstreamModel, error) {
	var m UpstreamModel
	var modelID sql.NullInt64
	var latency sql.NullInt64
	var lastErr sql.NullString
	var lastChecked, createdAt, updatedAt sql.NullString
	if err := row.Scan(&m.ID, &m.UpstreamID, &modelID, &m.Model, &m.Enabled, &m.Status, &latency,
		&lastErr, &lastChecked, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	m.ModelID = modelID.Int64
	m.LatencyMS = latency.Int64
	m.LastError = lastErr.String
	m.LastCheckedAt = ParseTime(lastChecked.String)
	m.CreatedAt = ParseTime(createdAt.String)
	m.UpdatedAt = ParseTime(updatedAt.String)
	return &m, nil
}

const modelCols = `id, name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at`

func scanModel(row interface{ Scan(...any) error }) (*Model, error) {
	var m Model
	var createdAt, updatedAt string
	if err := row.Scan(&m.ID, &m.Name, &m.Builtin, &m.Ratio, &m.Enabled, &m.Remark, &m.Sort,
		&m.Free, &m.Discount, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	m.CreatedAt = ParseTime(createdAt)
	m.UpdatedAt = ParseTime(updatedAt)
	return &m, nil
}

// ---------- 上游 ----------

// ListUpstreams 上游列表（含 Key 与模型）。
func (d *DB) ListUpstreams() ([]*Upstream, error) {
	rows, err := d.Query(`SELECT ` + upstreamCols + ` FROM ai_upstreams ORDER BY sort ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Upstream{}
	for rows.Next() {
		u, err := scanUpstream(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// FindUpstream 取一个上游。
func (d *DB) FindUpstream(id int64) (*Upstream, error) {
	row := d.QueryRow(`SELECT `+upstreamCols+` FROM ai_upstreams WHERE id = ?`, id)
	u, err := scanUpstream(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// CreateUpstream 建上游。
func (d *DB) CreateUpstream(u *Upstream) error {
	now := Now()
	res, err := d.Exec(
		`INSERT INTO ai_upstreams (name, driver, base_url, enabled, sort, remark, models_synced_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.Name, u.Driver, u.BaseURL, boolInt(u.Enabled), u.Sort, u.Remark,
		nullTime(u.ModelsSyncedAt), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("建上游失败: %w", err)
	}
	u.ID, _ = res.LastInsertId()
	u.CreatedAt, u.UpdatedAt = now, now
	return nil
}

// SaveUpstream 更新上游。
func (d *DB) SaveUpstream(u *Upstream) error {
	_, err := d.Exec(
		`UPDATE ai_upstreams SET name = ?, driver = ?, base_url = ?, enabled = ?, sort = ?, remark = ?,
		 models_synced_at = ?, updated_at = ? WHERE id = ?`,
		u.Name, u.Driver, u.BaseURL, boolInt(u.Enabled), u.Sort, u.Remark,
		nullTime(u.ModelsSyncedAt), Now().Format(time.RFC3339Nano), u.ID)
	return err
}

// DeleteUpstream 删上游（级联删 Key 与模型）。
func (d *DB) DeleteUpstream(id int64) error {
	_, err := d.Exec(`DELETE FROM ai_upstreams WHERE id = ?`, id)
	return err
}

// ---------- 上游 Key ----------

// ListKeysByUpstream 一个上游的所有 Key。
func (d *DB) ListKeysByUpstream(upstreamID int64) ([]*UpstreamKey, error) {
	rows, err := d.Query(`SELECT `+keyCols+` FROM ai_upstream_keys WHERE upstream_id = ? ORDER BY id ASC`, upstreamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*UpstreamKey{}
	for rows.Next() {
		k, err := scanKey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// FindKey 取一把 Key。
func (d *DB) FindKey(id int64) (*UpstreamKey, error) {
	row := d.QueryRow(`SELECT `+keyCols+` FROM ai_upstream_keys WHERE id = ?`, id)
	k, err := scanKey(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return k, err
}

// CreateKey 加一把 Key。
func (d *DB) CreateKey(k *UpstreamKey) error {
	now := Now()
	res, err := d.Exec(
		`INSERT INTO ai_upstream_keys (upstream_id, name, api_key, enabled, status, latency_ms, last_error, last_checked_at, last_used_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		k.UpstreamID, k.Name, k.APIKey, boolInt(k.Enabled), k.Status, nullInt(k.LatencyMS),
		nullStr(k.LastError), nullTime(k.LastCheckedAt), nullTime(k.LastUsedAt),
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("加 Key 失败: %w", err)
	}
	k.ID, _ = res.LastInsertId()
	k.CreatedAt, k.UpdatedAt = now, now
	return nil
}

// SaveKey 更新一把 Key。
func (d *DB) SaveKey(k *UpstreamKey) error {
	_, err := d.Exec(
		`UPDATE ai_upstream_keys SET name = ?, api_key = ?, enabled = ?, status = ?, latency_ms = ?,
		 last_error = ?, last_checked_at = ?, last_used_at = ?, updated_at = ? WHERE id = ?`,
		k.Name, k.APIKey, boolInt(k.Enabled), k.Status, nullInt(k.LatencyMS),
		nullStr(k.LastError), nullTime(k.LastCheckedAt), nullTime(k.LastUsedAt),
		Now().Format(time.RFC3339Nano), k.ID)
	return err
}

// DeleteKey 删一把 Key。
func (d *DB) DeleteKey(id int64) error {
	_, err := d.Exec(`DELETE FROM ai_upstream_keys WHERE id = ?`, id)
	return err
}

// MarkKeyOK 标记 Key 可用。
func (d *DB) MarkKeyOK(id int64, latencyMS int64) error {
	now := Now().Format(time.RFC3339Nano)
	_, err := d.Exec(
		`UPDATE ai_upstream_keys SET status = ?, latency_ms = ?, last_error = NULL, last_used_at = ?, updated_at = ? WHERE id = ?`,
		KeyStatusOK, latencyMS, now, now, id)
	return err
}

// MarkKeyError 标记 Key 不可用。
func (d *DB) MarkKeyError(id int64, errMsg string) error {
	now := Now().Format(time.RFC3339Nano)
	_, err := d.Exec(
		`UPDATE ai_upstream_keys SET status = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
		KeyStatusError, truncate(errMsg, 500), now, now, id)
	return err
}

// ---------- 上游模型 ----------

// ListUpstreamModels 一个上游的所有模型。
func (d *DB) ListUpstreamModels(upstreamID int64) ([]*UpstreamModel, error) {
	rows, err := d.Query(`SELECT `+upstreamModelCols+` FROM ai_upstream_models WHERE upstream_id = ? ORDER BY id ASC`, upstreamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*UpstreamModel{}
	for rows.Next() {
		m, err := scanUpstreamModel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// FindUpstreamModel 取一条上游模型。
func (d *DB) FindUpstreamModel(id int64) (*UpstreamModel, error) {
	row := d.QueryRow(`SELECT `+upstreamModelCols+` FROM ai_upstream_models WHERE id = ?`, id)
	m, err := scanUpstreamModel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// UpsertUpstreamModel 按 (upstream_id, model) 插入或更新。
// 同步上游模型时用：已存在的只刷新 updated_at，不动 enabled/status（用户可能手动改过）。
func (d *DB) UpsertUpstreamModel(upstreamID int64, name string) error {
	now := Now().Format(time.RFC3339Nano)
	_, err := d.Exec(
		`INSERT INTO ai_upstream_models (upstream_id, model_id, model, enabled, status, created_at, updated_at)
		 VALUES (?, NULL, ?, 1, ?, ?, ?)
		 ON CONFLICT DO NOTHING`,
		upstreamID, name, ModelStatusUnknown, now, now)
	// SQLite 的 ON CONFLICT 需要唯一索引；没有就退化成「先查后插」
	if err != nil && strings.Contains(err.Error(), "ON CONFLICT") {
		var n int
		_ = d.QueryRow(`SELECT COUNT(*) FROM ai_upstream_models WHERE upstream_id = ? AND model = ?`, upstreamID, name).Scan(&n)
		if n > 0 {
			return nil
		}
		_, err = d.Exec(
			`INSERT INTO ai_upstream_models (upstream_id, model_id, model, enabled, status, created_at, updated_at)
			 VALUES (?, NULL, ?, 1, ?, ?, ?)`,
			upstreamID, name, ModelStatusUnknown, now, now)
	}
	return err
}

// DeleteUpstreamModel 删一条上游模型。
func (d *DB) DeleteUpstreamModel(id int64) error {
	_, err := d.Exec(`DELETE FROM ai_upstream_models WHERE id = ?`, id)
	return err
}

// SaveUpstreamModel 更新上游模型（启用/禁用/匹配）。
func (d *DB) SaveUpstreamModel(m *UpstreamModel) error {
	_, err := d.Exec(
		`UPDATE ai_upstream_models SET model_id = ?, model = ?, enabled = ?, status = ?, latency_ms = ?,
		 last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
		nullInt(m.ModelID), m.Model, boolInt(m.Enabled), m.Status, nullInt(m.LatencyMS),
		nullStr(m.LastError), nullTime(m.LastCheckedAt), Now().Format(time.RFC3339Nano), m.ID)
	return err
}

// MarkUpstreamModelChecked 探测后更新状态。
func (d *DB) MarkUpstreamModelChecked(id int64, ok bool, latencyMS int64, errMsg string) error {
	status := ModelStatusOK
	if !ok {
		status = ModelStatusError
	}
	now := Now().Format(time.RFC3339Nano)
	_, err := d.Exec(
		`UPDATE ai_upstream_models SET status = ?, latency_ms = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
		status, latencyMS, nullStr(errMsg), now, now, id)
	return err
}

// MatchUpstreamModels 把「上游里已存在但还没匹配上」的同名模型认领到模型库。
func (d *DB) MatchUpstreamModels(modelID int64, name string) (int64, error) {
	res, err := d.Exec(
		`UPDATE ai_upstream_models SET model_id = ?, updated_at = ?
		 WHERE model_id IS NULL AND model = ?`,
		modelID, Now().Format(time.RFC3339Nano), name)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// MatchAllUpstreamModels 全量重匹配（后台「重新匹配」用）。
func (d *DB) MatchAllUpstreamModels() (int64, error) {
	res, err := d.Exec(
		`UPDATE ai_upstream_models SET model_id = (
			SELECT id FROM ai_models WHERE ai_models.name = ai_upstream_models.model LIMIT 1
		 ), updated_at = ?
		 WHERE model_id IS NULL`,
		Now().Format(time.RFC3339Nano))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ---------- 模型库 ----------

// ListModels 模型库列表（sort 倒序、id 倒序，与对外 models 接口同序）。
func (d *DB) ListModels() ([]*Model, error) {
	rows, err := d.Query(`SELECT ` + modelCols + ` FROM ai_models ORDER BY sort DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Model{}
	for rows.Next() {
		m, err := scanModel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// FindModelByName 按模型名取（要求启用）。
func (d *DB) FindModelByName(name string) (*Model, error) {
	row := d.QueryRow(`SELECT `+modelCols+` FROM ai_models WHERE name = ? AND enabled = 1`, name)
	m, err := scanModel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// FindModel 按 id 取。
func (d *DB) FindModel(id int64) (*Model, error) {
	row := d.QueryRow(`SELECT `+modelCols+` FROM ai_models WHERE id = ?`, id)
	m, err := scanModel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// CreateModel 加模型。
func (d *DB) CreateModel(m *Model) error {
	now := Now()
	res, err := d.Exec(
		`INSERT INTO ai_models (name, builtin, ratio, enabled, remark, sort, free, discount, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.Name, boolInt(m.Builtin), m.Ratio, boolInt(m.Enabled), m.Remark, m.Sort, boolInt(m.Free),
		m.Discount, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("加模型失败: %w", err)
	}
	m.ID, _ = res.LastInsertId()
	m.CreatedAt, m.UpdatedAt = now, now
	return nil
}

// SaveModel 改模型。
func (d *DB) SaveModel(m *Model) error {
	_, err := d.Exec(
		`UPDATE ai_models SET name = ?, builtin = ?, ratio = ?, enabled = ?, remark = ?, sort = ?, free = ?, discount = ?, updated_at = ?
		 WHERE id = ?`,
		m.Name, boolInt(m.Builtin), m.Ratio, boolInt(m.Enabled), m.Remark, m.Sort, boolInt(m.Free),
		m.Discount, Now().Format(time.RFC3339Nano), m.ID)
	return err
}

// DeleteModel 删模型。
func (d *DB) DeleteModel(id int64) error {
	_, err := d.Exec(`DELETE FROM ai_models WHERE id = ?`, id)
	return err
}

// AvailableUpstreamModels 真正能提供某模型的上游模型（自身启用 + 上游启用），
// 按上游 sort、id 升序。
func (d *DB) AvailableUpstreamModels(modelID int64) ([]*UpstreamModel, error) {
	rows, err := d.Query(
		`SELECT m.id, m.upstream_id, m.model_id, m.model, m.enabled, m.status, m.latency_ms, m.last_error, m.last_checked_at, m.created_at, m.updated_at
		 FROM ai_upstream_models m
		 JOIN ai_upstreams u ON u.id = m.upstream_id
		 WHERE m.model_id = ? AND m.enabled = 1 AND u.enabled = 1
		 ORDER BY u.sort ASC, u.id ASC`, modelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*UpstreamModel{}
	for rows.Next() {
		m, err := scanUpstreamModel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func nullInt(v int64) any {
	if v == 0 {
		return nil
	}
	return v
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// Truncate 截断字符串（导出给 health 包用）。
func Truncate(s string, n int) string { return truncate(s, n) }

func round4(v float64) float64 {
	return float64(int64(v*10000+0.5)) / 10000
}
