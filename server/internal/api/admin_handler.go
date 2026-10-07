package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/store"
	"github.com/seeuseless/opencode_desk/server/internal/upstream"
)

// UpstreamService 暴露上游服务（健康采集器用）。
func (s *Server) UpstreamService() *upstream.Service { return s.up }
func (s *Server) mountAdmin(r chiRouter) {
	r.Route("/admin", func(r chiRouter) {
		r.Use(s.auth)
		r.Use(s.admin)

		// 上游
		r.Get("/ai-upstreams", s.handle(s.listUpstreams))
		r.Post("/ai-upstreams", s.handle(s.createUpstream))
		r.Get("/ai-upstreams/{id}", s.handle(s.showUpstream))
		r.Put("/ai-upstreams/{id}", s.handle(s.updateUpstream))
		r.Delete("/ai-upstreams/{id}", s.handle(s.deleteUpstream))
		r.Post("/ai-upstreams/{id}/keys", s.handle(s.createKey))
		r.Put("/ai-upstreams/keys/{key}", s.handle(s.updateKey))
		r.Delete("/ai-upstreams/keys/{key}", s.handle(s.deleteKey))
		r.Post("/ai-upstreams/keys/{key}/test", s.handle(s.testKey))
		r.Post("/ai-upstreams/keys/{key}/probe", s.handle(s.probeKey))
		r.Post("/ai-upstreams/{id}/sync", s.handle(s.syncUpstreamModels))
		r.Post("/ai-upstreams/{id}/import-models", s.handle(s.importModels))
		r.Post("/ai-upstreams/{id}/test", s.handle(s.testUpstream))
		r.Put("/ai-upstreams/models/{model}", s.handle(s.updateUpstreamModel))
		r.Delete("/ai-upstreams/models/{model}", s.handle(s.deleteUpstreamModel))

		// 模型库
		r.Get("/ai-models/models", s.handle(s.listModels))
		r.Post("/ai-models/models", s.handle(s.createModel))
		r.Put("/ai-models/models/{model}", s.handle(s.updateModel))
		r.Delete("/ai-models/models/{model}", s.handle(s.deleteModel))
		r.Post("/ai-models/models/{model}/test", s.handle(s.testModel))
		r.Post("/ai-models/re-match", s.handle(s.reMatchModels))

		// 模型概况
		r.Get("/ai-models/health", s.handle(s.healthOverview))
		r.Get("/ai-models/health/series", s.handle(s.healthSeries))

		// 用量与会员
		r.Get("/usage/overview", s.handle(s.usageOverview))
		r.Get("/usage/stats", s.handle(s.usageStats))
		r.Get("/members", s.handle(s.listMembers))
		r.Get("/members/{id}", s.handle(s.showMember))
		r.Put("/members/{id}", s.handle(s.updateMember))
		r.Get("/members/{id}/logs", s.handle(s.memberLogs))
		r.Get("/members/{id}/usages", s.handle(s.memberUsages))

		r.Get("/dashboard", s.handle(s.dashboard))
	})
}

// ---------- 上游 ----------

type upstreamReq struct {
	Name    string `json:"name"`
	Driver  string `json:"driver"`
	BaseURL string `json:"base_url"`
	Enabled *bool  `json:"enabled"`
	Sort    int64  `json:"sort"`
	Remark  string `json:"remark"`
}

func (u upstreamReq) validate() error {
	if strings.TrimSpace(u.Name) == "" {
		return fail(422, "请填写上游名称")
	}
	if strings.TrimSpace(u.BaseURL) == "" {
		return fail(422, "请填写 Base URL")
	}
	return nil
}

// listUpstreams 上游列表（含 Key 与模型）。
func (s *Server) listUpstreams(w http.ResponseWriter, r *http.Request) error {
	list, err := s.db.ListUpstreams()
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, u := range list {
		out = append(out, s.upstreamPayload(u))
	}
	writeJSON(w, 200, out)
	return nil
}

// showUpstream 上游详情。
func (s *Server) showUpstream(w http.ResponseWriter, r *http.Request) error {
	u, err := s.upstreamByID(r)
	if err != nil {
		return err
	}
	writeJSON(w, 200, s.upstreamPayload(u))
	return nil
}

// createUpstream 新增上游。
func (s *Server) createUpstream(w http.ResponseWriter, r *http.Request) error {
	var req upstreamReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if err := req.validate(); err != nil {
		return err
	}
	driver := strings.TrimSpace(req.Driver)
	if driver == "" {
		driver = "openai"
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	u := &store.Upstream{
		Name: strings.TrimSpace(req.Name), Driver: driver,
		BaseURL: strings.TrimSpace(req.BaseURL), Enabled: enabled,
		Sort: req.Sort, Remark: strings.TrimSpace(req.Remark),
	}
	if err := s.db.CreateUpstream(u); err != nil {
		return err
	}
	writeJSON(w, 200, s.upstreamPayload(u))
	return nil
}

// updateUpstream 改上游。
func (s *Server) updateUpstream(w http.ResponseWriter, r *http.Request) error {
	u, err := s.upstreamByID(r)
	if err != nil {
		return err
	}
	var req upstreamReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if err := req.validate(); err != nil {
		return err
	}
	u.Name = strings.TrimSpace(req.Name)
	u.BaseURL = strings.TrimSpace(req.BaseURL)
	u.Sort = req.Sort
	u.Remark = strings.TrimSpace(req.Remark)
	if req.Driver != "" {
		u.Driver = strings.TrimSpace(req.Driver)
	}
	if req.Enabled != nil {
		u.Enabled = *req.Enabled
	}
	if err := s.db.SaveUpstream(u); err != nil {
		return err
	}
	writeJSON(w, 200, s.upstreamPayload(u))
	return nil
}

// deleteUpstream 删上游（级联删 Key 与模型）。
func (s *Server) deleteUpstream(w http.ResponseWriter, r *http.Request) error {
	u, err := s.upstreamByID(r)
	if err != nil {
		return err
	}
	if err := s.db.DeleteUpstream(u.ID); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "已删除"})
	return nil
}

func (s *Server) upstreamByID(r *http.Request) (*store.Upstream, error) {
	id, err := urlParamInt(r, "id")
	if err != nil {
		return nil, err
	}
	u, err := s.db.FindUpstream(id)
	if err != nil {
		return nil, fail(404, "上游不存在")
	}
	return u, nil
}

func (s *Server) upstreamPayload(u *store.Upstream) map[string]any {
	keys, _ := s.db.ListKeysByUpstream(u.ID)
	models, _ := s.db.ListUpstreamModels(u.ID)
	keyOut := []map[string]any{}
	for _, k := range keys {
		keyOut = append(keyOut, map[string]any{
			"id":   k.ID,
			"name": k.Name,
			// api_key 密文存储，任何接口都不回传明文
			"masked":          maskKey(k.APIKey),
			"enabled":         k.Enabled,
			"status":          k.Status,
			"latency_ms":      k.LatencyMS,
			"last_error":      nullIfEmpty(k.LastError),
			"last_checked_at": fmtTime(k.LastCheckedAt),
			"last_used_at":    fmtTime(k.LastUsedAt),
		})
	}
	modelOut := []map[string]any{}
	for _, m := range models {
		modelOut = append(modelOut, map[string]any{
			"id":              m.ID,
			"model":           m.Model,
			"model_id":        m.ModelID,
			"enabled":         m.Enabled,
			"status":          m.Status,
			"latency_ms":      m.LatencyMS,
			"last_error":      nullIfEmpty(m.LastError),
			"last_checked_at": fmtTime(m.LastCheckedAt),
		})
	}
	return map[string]any{
		"id":               u.ID,
		"name":             u.Name,
		"driver":           u.Driver,
		"base_url":         u.BaseURL,
		"enabled":          u.Enabled,
		"sort":             u.Sort,
		"remark":           u.Remark,
		"models_synced_at": fmtTime(u.ModelsSyncedAt),
		"keys":             keyOut,
		"models":           modelOut,
	}
}

// maskKey 脱敏显示：只留前后各几位。
func maskKey(k string) string {
	if k == "" {
		return ""
	}
	if len(k) <= 10 {
		return strings.Repeat("*", len(k))
	}
	return k[:4] + strings.Repeat("*", len(k)-8) + k[len(k)-4:]
}

// ---------- 上游 Key ----------

type keyReq struct {
	Name    string `json:"name"`
	APIKey  string `json:"api_key"`
	Enabled *bool  `json:"enabled"`
}

// createKey 加一把 Key。
func (s *Server) createKey(w http.ResponseWriter, r *http.Request) error {
	u, err := s.upstreamByID(r)
	if err != nil {
		return err
	}
	var req keyReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if strings.TrimSpace(req.APIKey) == "" {
		return fail(422, "请填写 API Key")
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	k := &store.UpstreamKey{
		UpstreamID: u.ID, Name: strings.TrimSpace(req.Name),
		APIKey: strings.TrimSpace(req.APIKey), Enabled: enabled, Status: store.KeyStatusUnknown,
	}
	if err := s.db.CreateKey(k); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"id": k.ID, "message": "已添加"})
	return nil
}

// updateKey 改 Key。
func (s *Server) updateKey(w http.ResponseWriter, r *http.Request) error {
	k, err := s.keyByID(r)
	if err != nil {
		return err
	}
	var req keyReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if strings.TrimSpace(req.APIKey) != "" {
		k.APIKey = strings.TrimSpace(req.APIKey)
	}
	k.Name = strings.TrimSpace(req.Name)
	if req.Enabled != nil {
		k.Enabled = *req.Enabled
	}
	if err := s.db.SaveKey(k); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "已保存"})
	return nil
}

// deleteKey 删 Key。
func (s *Server) deleteKey(w http.ResponseWriter, r *http.Request) error {
	k, err := s.keyByID(r)
	if err != nil {
		return err
	}
	if err := s.db.DeleteKey(k.ID); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "已删除"})
	return nil
}

func (s *Server) keyByID(r *http.Request) (*store.UpstreamKey, error) {
	id, err := urlParamInt(r, "key")
	if err != nil {
		return nil, err
	}
	k, err := s.db.FindKey(id)
	if err != nil {
		return nil, fail(404, "Key 不存在")
	}
	return k, nil
}

// testKey 测一把 Key（拉一次模型清单）。
func (s *Server) testKey(w http.ResponseWriter, r *http.Request) error {
	k, err := s.keyByID(r)
	if err != nil {
		return err
	}
	u, err := s.db.FindUpstream(k.UpstreamID)
	if err != nil {
		return fail(404, "上游不存在")
	}
	res := s.up.TestKey(u, k)
	writeJSON(w, 200, res)
	return nil
}

// probeKey 探测一把 Key 下各模型的可用性。
func (s *Server) probeKey(w http.ResponseWriter, r *http.Request) error {
	k, err := s.keyByID(r)
	if err != nil {
		return err
	}
	u, err := s.db.FindUpstream(k.UpstreamID)
	if err != nil {
		return fail(404, "上游不存在")
	}
	res := s.up.ProbeKey(u, k)
	writeJSON(w, 200, res)
	return nil
}

// testUpstream 测整个上游（用第一把可用的 Key）。
func (s *Server) testUpstream(w http.ResponseWriter, r *http.Request) error {
	u, err := s.upstreamByID(r)
	if err != nil {
		return err
	}
	res := s.up.TestUpstream(u)
	writeJSON(w, 200, res)
	return nil
}

// syncUpstreamModels 自动获取模型。
func (s *Server) syncUpstreamModels(w http.ResponseWriter, r *http.Request) error {
	u, err := s.upstreamByID(r)
	if err != nil {
		return err
	}
	n, err := s.up.SyncModels(u)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"message": "已同步", "count": n})
	return nil
}

// importModels 把上游模型导入模型库。
func (s *Server) importModels(w http.ResponseWriter, r *http.Request) error {
	u, err := s.upstreamByID(r)
	if err != nil {
		return err
	}
	var req struct {
		Models  []string `json:"models"`
		Builtin bool     `json:"builtin"`
		Ratio   float64  `json:"ratio"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	n, err := s.up.ImportToCatalog(u, req.Models, req.Builtin, req.Ratio)
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"message": "已导入", "count": n})
	return nil
}

// updateUpstreamModel 改上游模型（启用/禁用）。
func (s *Server) updateUpstreamModel(w http.ResponseWriter, r *http.Request) error {
	id, err := urlParamInt(r, "model")
	if err != nil {
		return err
	}
	m, err := s.db.FindUpstreamModel(id)
	if err != nil {
		return fail(404, "上游模型不存在")
	}
	var req struct {
		Enabled *bool  `json:"enabled"`
		Model   string `json:"model"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if req.Enabled != nil {
		m.Enabled = *req.Enabled
	}
	if strings.TrimSpace(req.Model) != "" {
		m.Model = strings.TrimSpace(req.Model)
	}
	if err := s.db.SaveUpstreamModel(m); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "已保存"})
	return nil
}

// deleteUpstreamModel 删上游模型。
func (s *Server) deleteUpstreamModel(w http.ResponseWriter, r *http.Request) error {
	id, err := urlParamInt(r, "model")
	if err != nil {
		return err
	}
	if err := s.db.DeleteUpstreamModel(id); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "已删除"})
	return nil
}

// ---------- 模型库 ----------

type modelReq struct {
	Name     string   `json:"name"`
	Builtin  bool     `json:"builtin"`
	Ratio    float64  `json:"ratio"`
	Enabled  *bool    `json:"enabled"`
	Remark   string   `json:"remark"`
	Sort     int64    `json:"sort"`
	Free     bool     `json:"free"`
	Discount *float64 `json:"discount"`
}

// listModels 模型库列表。
func (s *Server) listModels(w http.ResponseWriter, r *http.Request) error {
	list, err := s.db.ListModels()
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, m := range list {
		out = append(out, s.modelAdminPayload(m))
	}
	writeJSON(w, 200, out)
	return nil
}

// createModel 加模型。
func (s *Server) createModel(w http.ResponseWriter, r *http.Request) error {
	var req modelReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 150 {
		return fail(422, "请填写模型名（不超过 150 字）")
	}
	if req.Ratio <= 0 {
		req.Ratio = 1
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	m := &store.Model{
		Name: name, Builtin: req.Builtin, Ratio: req.Ratio, Enabled: enabled,
		Remark: strings.TrimSpace(req.Remark), Sort: req.Sort, Free: req.Free,
	}
	if req.Discount != nil {
		m.Discount.Float64 = *req.Discount
		m.Discount.Valid = true
	}
	if err := s.db.CreateModel(m); err != nil {
		return err
	}
	// 新增/改名模型后顺手认领同名上游模型，省掉让用户再点一次同步
	_, _ = s.db.MatchUpstreamModels(m.ID, m.Name)
	writeJSON(w, 200, s.modelAdminPayload(m))
	return nil
}

// updateModel 改模型。
func (s *Server) updateModel(w http.ResponseWriter, r *http.Request) error {
	id, err := urlParamInt(r, "model")
	if err != nil {
		return err
	}
	m, err := s.db.FindModel(id)
	if err != nil {
		return fail(404, "模型不存在")
	}
	var req modelReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		m.Name = name
	}
	m.Builtin = req.Builtin
	m.Free = req.Free
	if req.Ratio > 0 {
		m.Ratio = req.Ratio
	}
	if req.Enabled != nil {
		m.Enabled = *req.Enabled
	}
	m.Remark = strings.TrimSpace(req.Remark)
	m.Sort = req.Sort
	if req.Discount == nil {
		m.Discount.Valid = false
	} else {
		m.Discount.Float64 = *req.Discount
		m.Discount.Valid = true
	}
	if err := s.db.SaveModel(m); err != nil {
		return err
	}
	_, _ = s.db.MatchUpstreamModels(m.ID, m.Name)
	writeJSON(w, 200, s.modelAdminPayload(m))
	return nil
}

// deleteModel 删模型。
func (s *Server) deleteModel(w http.ResponseWriter, r *http.Request) error {
	id, err := urlParamInt(r, "model")
	if err != nil {
		return err
	}
	if err := s.db.DeleteModel(id); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "已删除"})
	return nil
}

// testModel 测模型（沿网关候选顺序试到第一个能用的）。
func (s *Server) testModel(w http.ResponseWriter, r *http.Request) error {
	id, err := urlParamInt(r, "model")
	if err != nil {
		return err
	}
	m, err := s.db.FindModel(id)
	if err != nil {
		return fail(404, "模型不存在")
	}
	res := s.up.TestModel(m)
	writeJSON(w, 200, res)
	return nil
}

// reMatchModels 重新匹配上游模型。
func (s *Server) reMatchModels(w http.ResponseWriter, r *http.Request) error {
	n, err := s.db.MatchAllUpstreamModels()
	if err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"message": "已重新匹配", "count": n})
	return nil
}

func (s *Server) modelAdminPayload(m *store.Model) map[string]any {
	avail, _ := s.db.AvailableUpstreamModels(m.ID)
	upstreams := []map[string]any{}
	for _, sm := range avail {
		up, err := s.db.FindUpstream(sm.UpstreamID)
		if err != nil {
			continue
		}
		upstreams = append(upstreams, map[string]any{
			"name":   up.Name,
			"model":  sm.Model,
			"status": sm.Status,
		})
	}
	var discount any
	if m.Discount.Valid {
		discount = m.Discount.Float64
	}
	return map[string]any{
		"id":              m.ID,
		"name":            m.Name,
		"builtin":         m.Builtin,
		"ratio":           m.Ratio,
		"enabled":         m.Enabled,
		"remark":          m.Remark,
		"sort":            m.Sort,
		"free":            m.Free,
		"discount":        discount,
		"discount_label":  m.DiscountLabel(),
		"effective_ratio": m.EffectiveRatio(),
		"health":          healthOf(avail),
		"upstreams":       upstreams,
	}
}

// healthOf 列表里展示的状态：未匹配（没上游提供）/ 可用 / 失败 / 未检测。
func healthOf(avail []*store.UpstreamModel) string {
	if len(avail) == 0 {
		return "unmatched"
	}
	hasOK, hasUnknown := false, false
	for _, m := range avail {
		switch m.Status {
		case store.ModelStatusOK:
			hasOK = true
		case store.ModelStatusUnknown:
			hasUnknown = true
		}
	}
	if hasOK {
		return "ok"
	}
	if hasUnknown {
		return "unknown"
	}
	return "error"
}

// ---------- 模型概况 ----------

// healthOverview 模型概况（按时间段回看）。
func (s *Server) healthOverview(w http.ResponseWriter, r *http.Request) error {
	from, to := store.UsageRange(query(r, "from"), query(r, "to"))
	rows, err := s.db.HealthOverview(from, to)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{
		"from": store.FormatDate(from),
		"to":   store.FormatDate(to),
		"rows": rows,
	})
}

// healthSeries 概况时间序列。
func (s *Server) healthSeries(w http.ResponseWriter, r *http.Request) error {
	from, to := store.UsageRange(query(r, "from"), query(r, "to"))
	rows, err := s.db.HealthSeries(from, to)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{
		"from":  store.FormatDate(from),
		"to":    store.FormatDate(to),
		"dates": healthDates(from, to),
		"rows":  rows,
	})
}

func healthDates(from, to time.Time) []string {
	out := []string{}
	for d := from; !d.After(to) && len(out) < 400; d = d.AddDate(0, 0, 1) {
		out = append(out, store.FormatDate(d))
	}
	return out
}

// ---------- 用量与会员 ----------

// usageOverview 用量总览。
func (s *Server) usageOverview(w http.ResponseWriter, r *http.Request) error {
	from, to := store.UsageRange(query(r, "from"), query(r, "to"))
	o, err := s.db.UsageOverview(from, to)
	if err != nil {
		return err
	}
	writeJSON(w, 200, o)
	return nil
}

// usageStats 用量统计（按模型 / 按天分组）。
func (s *Server) usageStats(w http.ResponseWriter, r *http.Request) error {
	from, to := store.UsageRange(query(r, "from"), query(r, "to"))
	group := query(r, "group")
	if group == "" {
		group = "model"
	}
	rows, err := s.db.UsageStats(from, to, group)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{
		"from": store.FormatDate(from),
		"to":   store.FormatDate(to),
		"rows": rows,
	})
}

// listMembers 会员列表。
func (s *Server) listMembers(w http.ResponseWriter, r *http.Request) error {
	page := queryInt(r, "page", 1)
	per := clampPerPage(queryInt(r, "per_page", 20))
	users, total, err := s.db.ListUsers(query(r, "q"), page, per)
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for _, u := range users {
		items = append(items, map[string]any{
			"id":         u.ID,
			"name":       u.Name,
			"email":      u.Email,
			"role":       u.Role,
			"points":     u.Points,
			"status":     u.Status,
			"created_at": store.FormatTime(u.CreatedAt),
		})
	}
	writeJSON(w, 200, pageEnvelope(items, total, page, per))
	return nil
}

// showMember 会员详情。
func (s *Server) showMember(w http.ResponseWriter, r *http.Request) error {
	u, err := s.memberByID(r)
	if err != nil {
		return err
	}
	return writeJSON(w, 200, map[string]any{
		"id":         u.ID,
		"name":       u.Name,
		"email":      u.Email,
		"role":       u.Role,
		"points":     u.Points,
		"status":     u.Status,
		"created_at": store.FormatTime(u.CreatedAt),
	})
}

// updateMember 改会员（含调积分）。
func (s *Server) updateMember(w http.ResponseWriter, r *http.Request) error {
	u, err := s.memberByID(r)
	if err != nil {
		return err
	}
	var req struct {
		Name   string `json:"name"`
		Status string `json:"status"`
		Points int64  `json:"points"`
		Remark string `json:"remark"`
	}
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		if err := s.db.UpdateUserName(u.ID, name); err != nil {
			return err
		}
	}
	if req.Status == store.StatusActive || req.Status == store.StatusDisabled {
		if _, err := s.db.Exec(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`,
			req.Status, store.Now().Format(time.RFC3339Nano), u.ID); err != nil {
			return err
		}
	}
	if req.Points != 0 {
		remark := strings.TrimSpace(req.Remark)
		if remark == "" {
			remark = "后台调整"
		}
		if err := s.db.AdjustPoints(u, req.Points, remark, userOf(r).ID); err != nil {
			return err
		}
	}
	writeJSON(w, 200, map[string]string{"message": "已保存"})
	return nil
}

// memberLogs 会员积分流水。
func (s *Server) memberLogs(w http.ResponseWriter, r *http.Request) error {
	u, err := s.memberByID(r)
	if err != nil {
		return err
	}
	page := queryInt(r, "page", 1)
	per := clampPerPage(queryInt(r, "per_page", 20))
	p, err := s.db.ListPointLogs(u.ID, query(r, "type"), page, per)
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for _, l := range p.Items {
		items = append(items, map[string]any{
			"id":         l.ID,
			"change":     l.Change,
			"after":      l.After,
			"type":       l.Type,
			"type_label": l.TypeLabel(),
			"remark":     l.Remark,
			"created_at": store.FormatMinute(l.CreatedAt),
		})
	}
	writeJSON(w, 200, pageEnvelope(items, p.Total, p.Page, p.PerPage))
	return nil
}

// memberUsages 会员用量。
func (s *Server) memberUsages(w http.ResponseWriter, r *http.Request) error {
	u, err := s.memberByID(r)
	if err != nil {
		return err
	}
	page := queryInt(r, "page", 1)
	per := clampPerPage(queryInt(r, "per_page", 20))
	p, err := s.db.ListUsages(u.ID, page, per)
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for _, x := range p.Items {
		items = append(items, map[string]any{
			"id":           x.ID,
			"model":        x.Model,
			"total_tokens": x.TotalTokens,
			"points":       x.Points,
			"created_at":   store.FormatMinute(x.CreatedAt),
		})
	}
	writeJSON(w, 200, pageEnvelope(items, p.Total, p.Page, p.PerPage))
	return nil
}

func (s *Server) memberByID(r *http.Request) (*store.User, error) {
	id, err := urlParamInt(r, "id")
	if err != nil {
		return nil, err
	}
	u, err := s.db.FindUserByID(id)
	if err != nil {
		return nil, fail(404, "会员不存在")
	}
	return u, nil
}

// dashboard 概览。
func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) error {
	d, err := s.db.Dashboard()
	if err != nil {
		return err
	}
	writeJSON(w, 200, d)
	return nil
}
