package api

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// models GET /api/ide/v1/models — 可用模型清单。
//
// 只列「有上游能提供」的模型：模型名匹配到至少一个已启用上游才对外可见。
// 排序口径与后台列表一致（sort 倒序、id 倒序）。
func (s *Server) models(w http.ResponseWriter, r *http.Request) error {
	list, err := s.db.ListModels()
	if err != nil {
		return err
	}
	data := []map[string]any{}
	for _, m := range list {
		avail, err := s.db.AvailableUpstreamModels(m.ID)
		if err != nil {
			return err
		}
		if len(avail) == 0 {
			continue // 没有上游提供，不对外暴露
		}
		data = append(data, s.modelPayload(m, avail))
	}
	writeJSON(w, 200, map[string]any{"object": "list", "data": data})
	return nil
}

// modelPayload 模型对外表示。
//
// 扩展字段（name/builtin/ratio/free/discount/discount_label/effective_ratio/upstreams）
// 严格 OpenAI 客户端会忽略，但青鸟要用，必须给。
func (s *Server) modelPayload(m *store.Model, avail []*store.UpstreamModel) map[string]any {
	upstreams := []map[string]any{}
	names := []string{}
	seen := map[string]bool{}
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
		if up.Name != "" && !seen[up.Name] {
			seen[up.Name] = true
			names = append(names, up.Name)
		}
	}
	ownedBy := strings.Join(names, " / ")
	if ownedBy == "" {
		ownedBy = "platform"
	}
	// discount 是 sql.NullFloat64：没配时给 null，前端显示占位符
	var discount any
	if m.Discount.Valid {
		discount = m.Discount.Float64
	}
	return map[string]any{
		"id":              m.Name,
		"object":          "model",
		"created":         m.CreatedAt.Unix(),
		"owned_by":        ownedBy,
		"name":            m.Name,
		"builtin":         m.Builtin,
		"ratio":           m.Ratio,
		"free":            m.Free,
		"discount":        discount,
		"discount_label":  m.DiscountLabel(),
		"effective_ratio": m.EffectiveRatio(),
		"upstreams":       upstreams,
	}
}

// chatReq 对话请求。只校验必填项，其余字段原样转发。
type chatReq struct {
	Model    string         `json:"model"`
	Messages []any          `json:"messages"`
	Stream   bool           `json:"stream"`
	Rest     map[string]any `json:"-"`
}

// chatCompletions POST /api/ide/v1/chat/completions — 对话转发。
func (s *Server) chatCompletions(w http.ResponseWriter, r *http.Request) error {
	var raw map[string]any
	if err := decodeJSON(r, &raw); err != nil {
		return err
	}
	model, _ := raw["model"].(string)
	if model == "" || len(model) > 190 {
		return fail(422, "model 必填且不超过 190 字")
	}
	msgs, ok := raw["messages"].([]any)
	if !ok || len(msgs) == 0 {
		return fail(422, "messages 必填且为非空数组")
	}
	stream, _ := raw["stream"].(bool)

	m, err := s.gw.Resolve(model)
	if err != nil {
		return err
	}
	if m == nil {
		return fail(404, "模型不存在或没有可用上游："+model)
	}

	// 除 model 外的所有字段原样转发（temperature / tools / response_format 等一律带上）
	payload := map[string]any{}
	for k, v := range raw {
		if k == "model" {
			continue
		}
		payload[k] = v
	}

	// 计费按「实际倍率」：限免为 0、打折已乘折扣。调用当时的值同时写进 ai_usages
	ratio := m.EffectiveRatio()
	u := userOf(r)
	deviceID := s.deviceIDOf(r, u)

	res, err := s.gw.Chat(m, payload, stream, func(usage map[string]any) {
		pt, ct, tt := usageTokens(usage)
		if _, err := s.db.ConsumeUsage(u, deviceID, m.Name, ratio, pt, ct, tt); err != nil {
			logErr(err)
		}
	})
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "还没有可用上游") {
			return fail(503, msg)
		}
		return fail(502, msg)
	}

	if !stream {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(200)
		_, _ = w.Write(res.JSON)
		return nil
	}

	// 流式：逐块透传，边转发边扫用量
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(200)

	flusher, _ := w.(http.Flusher)
	usage := scanSSEUsage(res.Stream, func(chunk []byte) {
		_, _ = w.Write(chunk)
		if flusher != nil {
			flusher.Flush()
		}
	})
	if usage != nil {
		pt, ct, tt := usageTokens(usage)
		if _, err := s.db.ConsumeUsage(u, deviceID, m.Name, ratio, pt, ct, tt); err != nil {
			logErr(err)
		}
	}
	return nil
}

// scanSSEUsage 逐块读上游流：每块交给 emit 转发，同时扫出最后一块里的 usage。
//
// 上游把 usage 放在最后一个 `data:` 行里，所以必须读到流结束才知道总量——
// 这也是计费刻意放在流结束后做的原因：不阻塞用户看输出。
func scanSSEUsage(r io.Reader, emit func([]byte)) map[string]any {
	br := bufio.NewReader(r)
	var usage map[string]any
	buf := make([]byte, 0, 8192)
	for {
		// 按块读，读多少转发多少（别按行等，否则长行会卡）
		n, err := br.Read(buf[:cap(buf)])
		if n > 0 {
			chunk := buf[:n]
			emit(chunk)
			if u := usageFromChunk(chunk); u != nil {
				usage = u
			}
		}
		if err != nil {
			break
		}
	}
	return usage
}

// usageFromChunk 从一块数据里找带 usage 的 data: 行。
func usageFromChunk(chunk []byte) map[string]any {
	var found map[string]any
	for _, line := range strings.Split(string(chunk), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		body := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if body == "" || body == "[DONE]" {
			continue
		}
		var parsed map[string]any
		if json.Unmarshal([]byte(body), &parsed) != nil {
			continue
		}
		if u, ok := parsed["usage"].(map[string]any); ok && len(u) > 0 {
			found = u
		}
	}
	return found
}

// usageTokens 从 usage 对象里取三个 token 数。
func usageTokens(u map[string]any) (prompt, completion, total int64) {
	prompt = toInt64(u["prompt_tokens"])
	completion = toInt64(u["completion_tokens"])
	total = toInt64(u["total_tokens"])
	if total <= 0 {
		total = prompt + completion
	}
	return
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	}
	return 0
}

// deviceIDOf 用量归属到哪台电脑：客户端在请求头带上自己的设备 id（X-Qingniao-Device）。
// 拿不到就记 0——用量仍然入账，只是后台看不出是哪台机器。
func (s *Server) deviceIDOf(r *http.Request, u *store.User) int64 {
	if u == nil {
		return 0
	}
	id := toInt64(r.Header.Get("X-Qingniao-Device"))
	if id <= 0 {
		return 0
	}
	dev, err := s.db.FindDeviceByID(id)
	if err != nil || dev.UserID != u.ID {
		return 0
	}
	return id
}
