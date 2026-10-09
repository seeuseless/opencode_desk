package store

import (
	"database/sql"
	"time"
)

// HealthRow 模型概况的一行（一个模型在某段时间的稳定率）。
type HealthRow struct {
	ModelID   int64    `json:"model_id"`
	Model     string   `json:"model"`
	Total     int64    `json:"total"`
	OK        int64    `json:"ok"`
	Rate      float64  `json:"rate"`
	Upstreams []string `json:"upstreams"`
}

// HealthOverview 模型概况：区间内每个模型的探测汇总。
//
// 回看口径：≤ 1 天看时间轴（由 series 接口给），> 1 天看每天的稳定百分比（这里给汇总）。
func (d *DB) HealthOverview(from, to time.Time) ([]HealthRow, error) {
	rows, err := d.Query(
		`SELECT m.id, m.name,
		        COALESCE(SUM(c.total), 0) AS total,
		        COALESCE(SUM(c.ok), 0) AS ok
		 FROM ai_models m
		 LEFT JOIN ai_model_health_days c ON c.model_id = m.id AND c.day >= ? AND c.day <= ?
		 GROUP BY m.id, m.name
		 HAVING total > 0
		 ORDER BY ok * 1.0 / total ASC, m.name ASC`,
		FormatDate(from), FormatDate(to))
	if err != nil {
		return nil, err
	}
	out, err := d.scanHealthRows(rows)
	if err != nil {
		return nil, err
	}
	// 补上提供该模型的上游名（后台列表要显示）
	for i := range out {
		avail, err := d.AvailableUpstreamModels(out[i].ModelID)
		if err != nil {
			continue
		}
		names := []string{}
		seen := map[string]bool{}
		for _, sm := range avail {
			up, err := d.FindUpstream(sm.UpstreamID)
			if err != nil || up.Name == "" || seen[up.Name] {
				continue
			}
			seen[up.Name] = true
			names = append(names, up.Name)
		}
		out[i].Upstreams = names
	}
	return out, nil
}

// HealthDayPoint 某模型在某天的探测汇总。
type HealthDayPoint struct {
	Day   string  `json:"day"`
	Total int64   `json:"total"`
	OK    int64   `json:"ok"`
	Rate  float64 `json:"rate"`
}

// HealthModelSeries 概况时间序列里一个模型的完整视图：区间汇总 + 按天明细。
type HealthModelSeries struct {
	ModelID   int64            `json:"model_id"`
	Model     string           `json:"model"`
	Total     int64            `json:"total"`
	OK        int64            `json:"ok"`
	Rate      float64          `json:"rate"`
	Upstreams []string         `json:"upstreams"`
	Days      []HealthDayPoint `json:"days"`
}

// HealthSeries 概况时间序列：每个模型的区间汇总 + 按天稳定率明细。
func (d *DB) HealthSeries(from, to time.Time) ([]HealthModelSeries, error) {
	rows, err := d.Query(
		`SELECT m.id, m.name, c.day, c.total, c.ok
		 FROM ai_models m
		 JOIN ai_model_health_days c ON c.model_id = m.id AND c.day >= ? AND c.day <= ?
		 ORDER BY m.name ASC, c.day ASC`,
		FormatDate(from), FormatDate(to))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byModel := map[int64]*HealthModelSeries{}
	order := []int64{}
	for rows.Next() {
		var id int64
		var name, day string
		var total, ok int64
		if err := rows.Scan(&id, &name, &day, &total, &ok); err != nil {
			return nil, err
		}
		m, exists := byModel[id]
		if !exists {
			m = &HealthModelSeries{ModelID: id, Model: name, Days: []HealthDayPoint{}}
			byModel[id] = m
			order = append(order, id)
		}
		m.Total += total
		m.OK += ok
		m.Days = append(m.Days, HealthDayPoint{Day: day, Total: total, OK: ok, Rate: rateOf(ok, total)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := []HealthModelSeries{}
	for _, id := range order {
		m := byModel[id]
		m.Rate = rateOf(m.OK, m.Total)
		// 补上提供该模型的上游名（后台列表要显示）
		if avail, err := d.AvailableUpstreamModels(id); err == nil {
			names := []string{}
			seen := map[string]bool{}
			for _, sm := range avail {
				up, err := d.FindUpstream(sm.UpstreamID)
				if err != nil || up.Name == "" || seen[up.Name] {
					continue
				}
				seen[up.Name] = true
				names = append(names, up.Name)
			}
			m.Upstreams = names
		}
		out = append(out, *m)
	}
	return out, nil
}

func (d *DB) scanHealthRows(rows *sql.Rows) ([]HealthRow, error) {
	defer rows.Close()
	out := []HealthRow{}
	for rows.Next() {
		var r HealthRow
		if err := rows.Scan(&r.ModelID, &r.Model, &r.Total, &r.OK); err != nil {
			return nil, err
		}
		r.Rate = rateOf(r.OK, r.Total)
		out = append(out, r)
	}
	return out, nil
}

func rateOf(ok, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return float64(ok) / float64(total)
}

// RecordHealthCheck 记一次探测，并更新按天聚合。
func (d *DB) RecordHealthCheck(upstreamModelID int64, ok bool, latencyMS int64, errMsg string) error {
	sm, err := d.FindUpstreamModel(upstreamModelID)
	if err != nil {
		return err
	}
	now := Now()
	if _, err := d.Exec(
		`INSERT INTO ai_model_health_checks (upstream_model_id, ok, latency_ms, error, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		upstreamModelID, boolInt(ok), nullInt(latencyMS), nullStr(errMsg),
		now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if sm.ModelID == 0 {
		return nil // 没匹配到模型库的，不进按天聚合
	}
	day := FormatDate(now)
	_, err = d.Exec(
		`INSERT INTO ai_model_health_days (model_id, day, total, ok, created_at)
		 VALUES (?, ?, 1, ?, ?)
		 ON CONFLICT(model_id, day) DO UPDATE SET total = total + 1, ok = ok + ?`,
		sm.ModelID, day, boolInt(ok), now.Format(time.RFC3339Nano), boolInt(ok))
	return err
}

// HealthProbeTargets 待探测的上游模型（已启用 + 上游已启用 + 已匹配到模型库）。
func (d *DB) HealthProbeTargets() ([]*UpstreamModel, error) {
	rows, err := d.Query(
		`SELECT m.id, m.upstream_id, m.model_id, m.model, m.enabled, m.status, m.latency_ms, m.last_error, m.last_checked_at, m.created_at, m.updated_at
		 FROM ai_upstream_models m
		 JOIN ai_upstreams u ON u.id = m.upstream_id
		 WHERE m.enabled = 1 AND u.enabled = 1 AND m.model_id IS NOT NULL
		 ORDER BY m.id ASC`)
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

// UpstreamsForProbe 待探测的上游（按 sort、id 升序，用于「每轮每上游只探一个」的轮换）。
func (d *DB) UpstreamsForProbe() ([]*Upstream, error) {
	rows, err := d.Query(
		`SELECT ` + upstreamCols + ` FROM ai_upstreams WHERE enabled = 1 ORDER BY sort ASC, id ASC`)
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

// UsageOverview 后台用量总览。
type UsageOverview struct {
	Calls   int64 `json:"calls"`
	Tokens  int64 `json:"tokens"`
	Points  int64 `json:"points"`
	Users   int64 `json:"users"`
	Devices int64 `json:"devices"`
	Models  []Row `json:"models"`
	Days    []Row `json:"days"`
}

// UsageOverviewOf 后台用量总览。
func (d *DB) UsageOverview(from, to time.Time) (*UsageOverview, error) {
	o := &UsageOverview{Models: []Row{}, Days: []Row{}}
	fromStr := from.Format(time.RFC3339Nano)
	toStr := to.Format(time.RFC3339Nano)

	err := d.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), COALESCE(SUM(points), 0)
		 FROM ai_usages WHERE created_at >= ? AND created_at <= ?`, fromStr, toStr).
		Scan(&o.Calls, &o.Tokens, &o.Points)
	if err != nil {
		return nil, err
	}
	_ = d.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'member'`).Scan(&o.Users)
	_ = d.QueryRow(`SELECT COUNT(*) FROM ide_devices WHERE enabled = 1`).Scan(&o.Devices)

	if o.Models, err = d.groupedRows(0, fromStr, toStr, "COALESCE(SUM(points), 0)", "model", "tokens DESC", ModelsLimit); err != nil {
		return nil, err
	}
	if o.Days, err = d.groupedRows(0, fromStr, toStr, "COALESCE(SUM(points), 0)", "DATE(created_at)", "DATE(created_at) ASC", DaysLimit); err != nil {
		return nil, err
	}
	return o, nil
}

// UsageStats 后台用量统计（按模型或按天）。
func (d *DB) UsageStats(from, to time.Time, group string) ([]Row, error) {
	labelExpr := "model"
	orderBy := "tokens DESC"
	if group == "day" {
		labelExpr = "DATE(created_at)"
		orderBy = "DATE(created_at) ASC"
	}
	return d.groupedRows(0, from.Format(time.RFC3339Nano), to.Format(time.RFC3339Nano),
		"COALESCE(SUM(points), 0)", labelExpr, orderBy, DaysLimit)
}

// Dashboard 后台概览。
type Dashboard struct {
	Users       int64 `json:"users"`
	Devices     int64 `json:"devices"`
	Online      int64 `json:"online"`
	Upstreams   int64 `json:"upstreams"`
	Models      int64 `json:"models"`
	CallsToday  int64 `json:"calls_today"`
	TokensToday int64 `json:"tokens_today"`
}

// DashboardOf 后台概览。
func (d *DB) Dashboard() (*Dashboard, error) {
	dd := &Dashboard{}
	_ = d.QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'member'`).Scan(&dd.Users)
	_ = d.QueryRow(`SELECT COUNT(*) FROM ide_devices WHERE enabled = 1`).Scan(&dd.Devices)
	_ = d.QueryRow(`SELECT COUNT(*) FROM ai_upstreams WHERE enabled = 1`).Scan(&dd.Upstreams)
	_ = d.QueryRow(`SELECT COUNT(*) FROM ai_models WHERE enabled = 1`).Scan(&dd.Models)

	today := dayStart(Now()).Format(time.RFC3339Nano)
	_ = d.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(total_tokens), 0) FROM ai_usages WHERE created_at >= ?`, today).
		Scan(&dd.CallsToday, &dd.TokensToday)

	// 在线设备：90 秒内认领过
	cutoff := Now().Add(-DeviceOnlineWindowSec * time.Second).Format(time.RFC3339Nano)
	_ = d.QueryRow(
		`SELECT COUNT(*) FROM ide_devices WHERE enabled = 1 AND last_seen_at > ?`, cutoff).Scan(&dd.Online)
	return dd, nil
}
