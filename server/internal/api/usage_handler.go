package api

import (
	"net/http"

	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// usageSummary GET /api/ide/usage/summary — 一次请求喂满整个使用量页面。
//
// 区间默认最近 30 天，用来画「各模型用量」与趋势图；
// 今日 / 昨日 / 累计是固定口径，不随区间变化。
func (s *Server) usageSummary(w http.ResponseWriter, r *http.Request) error {
	u := userOf(r)
	from, to := store.UsageRange(query(r, "from"), query(r, "to"))
	sum, err := s.db.UsageSummaryOf(u.ID, u.IsAdmin(), from, to)
	if err != nil {
		return err
	}
	sum.Points = u.Points
	writeJSON(w, 200, sum)
	return nil
}

// usageLogs GET /api/ide/usage/logs — 积分流水（分页）。
func (s *Server) usageLogs(w http.ResponseWriter, r *http.Request) error {
	u := userOf(r)
	typ := query(r, "type")
	if typ != "" && typ != "consume" && typ != "grant" && typ != "adjust" {
		return fail(422, "type 只能是 consume / grant / adjust")
	}
	page := queryInt(r, "page", 1)
	per := clampPerPage(queryInt(r, "per_page", 20))
	p, err := s.db.ListPointLogs(u.ID, typ, page, per)
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

// usageRecords GET /api/ide/usage/records — 每次消耗明细（分页）。
func (s *Server) usageRecords(w http.ResponseWriter, r *http.Request) error {
	u := userOf(r)
	page := queryInt(r, "page", 1)
	per := clampPerPage(queryInt(r, "per_page", 20))
	p, err := s.db.ListUsages(u.ID, page, per)
	if err != nil {
		return err
	}
	items := []map[string]any{}
	for _, x := range p.Items {
		items = append(items, map[string]any{
			"id":                x.ID,
			"model":             x.Model,
			"ratio":             x.Ratio,
			"prompt_tokens":     x.PromptTokens,
			"completion_tokens": x.CompletionTokens,
			"total_tokens":      x.TotalTokens,
			"points":            x.Points,
			"created_at":        store.FormatMinute(x.CreatedAt),
		})
	}
	writeJSON(w, 200, pageEnvelope(items, p.Total, p.Page, p.PerPage))
	return nil
}

// clampPerPage 每页条数：默认 20，最大 100。
func clampPerPage(n int) int {
	if n <= 0 {
		return 20
	}
	if n > 100 {
		return 100
	}
	return n
}

// pageEnvelope 分页信封：客户端要页码、总数、总页数三样才能画翻页条。
// total 是「符合条件的全部条数」，不是当前页条数——上限要靠它判断。
func pageEnvelope(items []map[string]any, total, page, per int) map[string]any {
	pages := 0
	if per > 0 {
		pages = (total + per - 1) / per
	}
	return map[string]any{
		"items":    items,
		"total":    total,
		"page":     page,
		"per_page": per,
		"pages":    pages,
	}
}
