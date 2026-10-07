package store

import (
	"database/sql"
	"fmt"
	"math"
	"time"
)

// 用量汇总口径。
const (
	// SeriesModels 折线图最多画几条线。
	SeriesModels = 8
	// SeriesDays 折线图横轴上限（天）。
	SeriesDays = 366
	// DaysLimit 按天汇总的上限。
	DaysLimit = 400
	// ModelsLimit 按模型汇总的上限。
	ModelsLimit = 100
	// DefaultRangeDays 默认区间（天）。
	DefaultRangeDays = 30
)

// Bucket 三个数字凑一组：调用次数 / token 量 / 扣掉多少积分。
type Bucket struct {
	Calls  int64 `json:"calls"`
	Tokens int64 `json:"tokens"`
	Points int64 `json:"points"`
}

// Row 一行聚合结果（按天或按模型）。
type Row struct {
	Label  string `json:"label"`
	Calls  int64  `json:"calls"`
	Tokens int64  `json:"tokens"`
	Points int64  `json:"points"`
}

// SeriesModel 折线图里的一条线。
type SeriesModel struct {
	Label  string  `json:"label"`
	Tokens int64   `json:"tokens"`
	Points []int64 `json:"points"`
}

// Series 折线图数据。
type Series struct {
	Dates  []string       `json:"dates"`
	Models []*SeriesModel `json:"models"`
}

// UsageSummary 一次请求喂满整个使用量页面。
type UsageSummary struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Points    int64  `json:"points"`
	Exempt    bool   `json:"exempt"`
	Range     Bucket `json:"range"`
	Today     Bucket `json:"today"`
	Yesterday Bucket `json:"yesterday"`
	All       Bucket `json:"all"`
	Days      []Row  `json:"days"`
	Models    []Row  `json:"models"`
	Series    Series `json:"series"`
}

// Cost 按倍率折算应扣积分：每千 token × 倍率，向上取整（1 token 也不白送）。
func Cost(ratio float64, totalTokens int64) int64 {
	if totalTokens <= 0 || ratio <= 0 {
		return 0
	}
	return int64(math.Ceil(float64(totalTokens) / 1000 * ratio))
}

// ConsumeUsage 记一次调用用量并按规则扣分。
//
// 规则（全平台只此一处）：
//
//	· 消耗积分 = ceil(总 token ÷ 1000 × 实际倍率)
//	· 余额不足时把能扣的扣完、不出现负数，实际扣除额记进 ai_usages.points
//	· 未登录平台（拿不到用户）时只记用量、不扣分，便于排查网关问题
//	· 管理员同样只记用量：平台是自己的，不参与积分计费，余额为 0 也不影响调用
func (d *DB) ConsumeUsage(user *User, deviceID int64, model string, ratio float64, prompt, completion, total int64) (*Usage, error) {
	if total <= 0 {
		total = prompt + completion
	}
	cost := Cost(ratio, total)
	charged := int64(0)

	if user != nil && !user.IsAdmin() && cost > 0 {
		charged = min(cost, max(0, user.Points))
		if charged > 0 {
			if err := d.UpdateUserPoints(user.ID, user.Points-charged); err != nil {
				return nil, err
			}
			user.Points -= charged
			now := Now()
			if _, err := d.Exec(
				`INSERT INTO point_logs (user_id, change, after, type, remark, operator_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'consume', ?, NULL, ?, ?)`,
				user.ID, -charged, user.Points,
				fmt.Sprintf("%s · %d token", model, total),
				now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
				return nil, err
			}
		}
	}

	now := Now()
	u := &Usage{
		UserID: userIDOrZero(user), DeviceID: deviceID, Model: model, Ratio: ratio,
		PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total,
		Points: charged, Source: "ide",
	}
	res, err := d.Exec(
		`INSERT INTO ai_usages (user_id, device_id, model, ratio, prompt_tokens, completion_tokens, total_tokens, points, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		nullUserID(user), nullInt(deviceID), model, ratio, prompt, completion, total, charged, "ide",
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("记用量失败: %w", err)
	}
	u.ID, _ = res.LastInsertId()
	u.CreatedAt, u.UpdatedAt = now, now
	return u, nil
}

func userIDOrZero(u *User) int64 {
	if u == nil {
		return 0
	}
	return u.ID
}

func nullUserID(u *User) any {
	if u == nil {
		return nil
	}
	return u.ID
}

// UsageRange 解析查询区间。to 补到当天 23:59:59，不传默认最近 30 天；from > to 时交换。
func UsageRange(fromStr, toStr string) (from, to time.Time) {
	now := Now()
	if fromStr == "" {
		from = now.AddDate(0, 0, -(DefaultRangeDays - 1))
	} else {
		from = parseDayStart(fromStr, now.AddDate(0, 0, -(DefaultRangeDays-1)))
	}
	if toStr == "" {
		to = now
	} else {
		to = parseDayEnd(toStr, now)
	}
	if from.After(to) {
		from, to = dayStart(to), dayEnd(from)
	}
	return from, to
}

func parseDayStart(s string, def time.Time) time.Time {
	if t, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		return t.UTC()
	}
	return def
}

func parseDayEnd(s string, def time.Time) time.Time {
	if t, err := time.ParseInLocation("2006-01-02", s, time.Local); err == nil {
		return t.AddDate(0, 0, 1).Add(-time.Nanosecond).UTC()
	}
	return def
}

func dayStart(t time.Time) time.Time {
	l := t.Local()
	return time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, time.Local).UTC()
}

func dayEnd(t time.Time) time.Time {
	l := t.Local()
	return time.Date(l.Year(), l.Month(), l.Day(), 23, 59, 59, 0, time.Local).UTC()
}

// UsageSummaryOf 汇总一个用户的用量。
//
// exempt（管理员）时所有 points 字段恒为 0——历史行里可能留有扣分，按口径一律当 0。
func (d *DB) UsageSummaryOf(userID int64, exempt bool, from, to time.Time) (*UsageSummary, error) {
	fromStr := from.Format(time.RFC3339Nano)
	toStr := to.Format(time.RFC3339Nano)
	now := Now()
	todayStart := dayStart(now)
	yesterdayStart := todayStart.AddDate(0, 0, -1)

	pointsExpr := "COALESCE(SUM(points), 0)"
	if exempt {
		pointsExpr = "0"
	}

	s := &UsageSummary{
		From:   FormatDate(from),
		To:     FormatDate(to),
		Exempt: exempt,
		Series: Series{Dates: []string{}, Models: []*SeriesModel{}},
		Days:   []Row{},
		Models: []Row{},
	}

	var err error
	if s.Range, err = d.bucket(userID, fromStr, toStr, pointsExpr); err != nil {
		return nil, err
	}
	if s.Today, err = d.bucket(userID, todayStart.Format(time.RFC3339Nano), "", pointsExpr); err != nil {
		return nil, err
	}
	if s.Yesterday, err = d.bucketBetween(userID, yesterdayStart.Format(time.RFC3339Nano), todayStart.Format(time.RFC3339Nano), pointsExpr); err != nil {
		return nil, err
	}
	if s.All, err = d.bucket(userID, "", "", pointsExpr); err != nil {
		return nil, err
	}
	if s.Days, err = d.groupedRows(userID, fromStr, toStr, pointsExpr,
		"DATE(created_at)", "DATE(created_at) ASC", DaysLimit); err != nil {
		return nil, err
	}
	if s.Models, err = d.groupedRows(userID, fromStr, toStr, pointsExpr,
		"model", "tokens DESC", ModelsLimit); err != nil {
		return nil, err
	}
	if s.Series, err = d.seriesOf(userID, from, to); err != nil {
		return nil, err
	}
	return s, nil
}

// bucket 单区间汇总（to 为空表示到现在）。
func (d *DB) bucket(userID int64, from, to, pointsExpr string) (Bucket, error) {
	q := `SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), ` + pointsExpr + ` FROM ai_usages WHERE user_id = ?`
	args := []any{userID}
	if from != "" {
		q += ` AND created_at >= ?`
		args = append(args, from)
	}
	if to != "" {
		q += ` AND created_at <= ?`
		args = append(args, to)
	}
	var b Bucket
	err := d.QueryRow(q, args...).Scan(&b.Calls, &b.Tokens, &b.Points)
	return b, err
}

func (d *DB) bucketBetween(userID int64, from, to, pointsExpr string) (Bucket, error) {
	var b Bucket
	err := d.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(total_tokens), 0), `+pointsExpr+`
		 FROM ai_usages WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
		userID, from, to).Scan(&b.Calls, &b.Tokens, &b.Points)
	return b, err
}

// groupedRows 按天或按模型分组汇总。
//
// userID 为 0 表示不限用户（后台统计用）。
func (d *DB) groupedRows(userID int64, from, to, pointsExpr, labelExpr, orderBy string, limit int) ([]Row, error) {
	q := `SELECT ` + labelExpr + ` AS label, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens, ` +
		pointsExpr + ` AS points FROM ai_usages WHERE created_at >= ? AND created_at <= ?`
	args := []any{from, to}
	if userID > 0 {
		q += ` AND user_id = ?`
		args = append(args, userID)
	}
	q += ` GROUP BY ` + labelExpr + ` ORDER BY ` + orderBy + ` LIMIT ?`
	args = append(args, limit)
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.Label, &r.Calls, &r.Tokens, &r.Points); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// seriesOf 趋势折线图：区间内「每天 × 每个模型」的 token 量。
//
// days 那份只给每天总量，画不出「哪个模型在哪天吃掉了多少」；这里把两个维度交叉出来，
// 一条线就是一个模型。每条线的 points 与 dates 一一对应，缺数据的天补 0——
// 折线才连续，不会把断点连成斜线。
func (d *DB) seriesOf(userID int64, from, to time.Time) (Series, error) {
	dates := []string{}
	for d := dayStart(from); !d.After(to) && len(dates) < SeriesDays; d = d.AddDate(0, 0, 1) {
		dates = append(dates, FormatDate(d))
	}

	rows, err := d.Query(
		`SELECT model, DATE(created_at) AS day, SUM(total_tokens)
		 FROM ai_usages WHERE user_id = ? AND created_at >= ? AND created_at <= ?
		 GROUP BY model, DATE(created_at)`,
		userID, from.Format(time.RFC3339Nano), to.Format(time.RFC3339Nano))
	if err != nil {
		return Series{}, err
	}
	defer rows.Close()

	byModel := map[string]map[string]int64{}
	for rows.Next() {
		var model, day string
		var tokens int64
		if err := rows.Scan(&model, &day, &tokens); err != nil {
			return Series{}, err
		}
		if byModel[model] == nil {
			byModel[model] = map[string]int64{}
		}
		byModel[model][day] = tokens
	}
	if err := rows.Err(); err != nil {
		return Series{}, err
	}

	models := []*SeriesModel{}
	for label, m := range byModel {
		points := make([]int64, len(dates))
		var total int64
		for i, day := range dates {
			points[i] = m[day]
			total += points[i]
		}
		models = append(models, &SeriesModel{Label: label, Tokens: total, Points: points})
	}
	// 量大的排前面：图例顺序与「各模型用量」一致，颜色也对得上
	sortSeriesModels(models)
	if len(models) > SeriesModels {
		models = models[:SeriesModels]
	}
	return Series{Dates: dates, Models: models}, nil
}

func sortSeriesModels(ms []*SeriesModel) {
	for i := 1; i < len(ms); i++ {
		for j := i; j > 0 && ms[j].Tokens > ms[j-1].Tokens; j-- {
			ms[j], ms[j-1] = ms[j-1], ms[j]
		}
	}
}

// PointLogPage 一页积分流水。
type PointLogPage struct {
	Items   []*PointLog `json:"items"`
	Total   int         `json:"total"`
	Page    int         `json:"page"`
	PerPage int         `json:"per_page"`
	Pages   int         `json:"pages"`
}

// ListPointLogs 积分流水（分页，可按类型过滤）。
func (d *DB) ListPointLogs(userID int64, typ string, page, per int) (*PointLogPage, error) {
	where := `user_id = ?`
	args := []any{userID}
	if typ != "" {
		where += ` AND type = ?`
		args = append(args, typ)
	}
	var total int
	if err := d.QueryRow(`SELECT COUNT(*) FROM point_logs WHERE `+where, args...).Scan(&total); err != nil {
		return nil, err
	}
	args = append(args, per, (page-1)*per)
	rows, err := d.Query(
		`SELECT id, user_id, change, after, type, remark, operator_id, created_at, updated_at
		 FROM point_logs WHERE `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*PointLog{}
	for rows.Next() {
		var p PointLog
		var op sql.NullInt64
		var createdAt, updatedAt string
		if err := rows.Scan(&p.ID, &p.UserID, &p.Change, &p.After, &p.Type, &p.Remark, &op, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		p.OperatorID = op.Int64
		p.CreatedAt = ParseTime(createdAt)
		p.UpdatedAt = ParseTime(updatedAt)
		items = append(items, &p)
	}
	pages := 0
	if per > 0 {
		pages = int(math.Ceil(float64(total) / float64(per)))
	}
	return &PointLogPage{Items: items, Total: total, Page: page, PerPage: per, Pages: pages}, rows.Err()
}

// UsagePage 一页用量明细。
type UsagePage struct {
	Items   []*Usage `json:"items"`
	Total   int      `json:"total"`
	Page    int      `json:"page"`
	PerPage int      `json:"per_page"`
	Pages   int      `json:"pages"`
}

// ListUsages 每次消耗明细（分页）。
func (d *DB) ListUsages(userID int64, page, per int) (*UsagePage, error) {
	var total int
	if err := d.QueryRow(`SELECT COUNT(*) FROM ai_usages WHERE user_id = ?`, userID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := d.Query(
		`SELECT id, user_id, device_id, model, ratio, prompt_tokens, completion_tokens, total_tokens, points, source, created_at, updated_at
		 FROM ai_usages WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, userID, per, (page-1)*per)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*Usage{}
	for rows.Next() {
		var u Usage
		var uid, devID sql.NullInt64
		var createdAt, updatedAt string
		if err := rows.Scan(&u.ID, &uid, &devID, &u.Model, &u.Ratio, &u.PromptTokens, &u.CompletionTokens,
			&u.TotalTokens, &u.Points, &u.Source, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		u.UserID = uid.Int64
		u.DeviceID = devID.Int64
		u.CreatedAt = ParseTime(createdAt)
		u.UpdatedAt = ParseTime(updatedAt)
		items = append(items, &u)
	}
	pages := 0
	if per > 0 {
		pages = int(math.Ceil(float64(total) / float64(per)))
	}
	return &UsagePage{Items: items, Total: total, Page: page, PerPage: per, Pages: pages}, rows.Err()
}

// AdjustPoints 后台人工调整会员积分。amount 为正=发放，负=扣减；扣减不会扣成负数。
func (d *DB) AdjustPoints(user *User, amount int64, remark string, operatorID int64) error {
	if amount == 0 {
		return nil
	}
	if amount > 0 {
		amount = min(amount, 100_000_000)
	} else {
		amount = -min(-amount, max(0, user.Points))
		if amount == 0 {
			return nil
		}
	}
	newPoints := user.Points + amount
	if err := d.UpdateUserPoints(user.ID, newPoints); err != nil {
		return err
	}
	user.Points = newPoints
	typ := "adjust"
	if amount > 0 {
		typ = "grant"
	}
	now := Now()
	_, err := d.Exec(
		`INSERT INTO point_logs (user_id, change, after, type, remark, operator_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		user.ID, amount, newPoints, typ, remark, operatorID,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return err
}
