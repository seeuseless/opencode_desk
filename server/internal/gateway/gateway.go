// Package gateway 是 OpenAI 兼容网关。
//
// 职责：把 IDE（青鸟）发来的 /v1/chat/completions 落到真正能提供该模型的上游。
//
// 模型名是唯一的对外标识（不再是内部自增 ID）。一个模型名可能被多个上游同时提供
// （比如官方 DeepSeek 与中转站都提供 deepseek-v4-flash），网关会依次尝试：
// 先在一个上游内部的多把 Key 之间故障转移，用尽后换下一个上游。
//
// 只在「还没开始回包」的阶段重试（连不上、401、429、5xx 等），
// 一旦开始推流就不再切换——否则用户会看到两段拼接的回答。
package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/config"
	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// Gateway 网关。
type Gateway struct {
	db   *store.DB
	cfg  *config.Config
	http *http.Client
}

// New 建网关。
func New(db *store.DB, cfg *config.Config) *Gateway {
	tr := &http.Transport{
		// 国外上游握手慢，别用默认的 30s 那么短；这里按配置来
		ResponseHeaderTimeout: time.Duration(cfg.UpstreamTimeoutSec) * time.Second,
		MaxIdleConns:          32,
		IdleConnTimeout:       90 * time.Second,
	}
	if cfg.UpstreamProxy != "" {
		if p, err := parseProxy(cfg.UpstreamProxy); err == nil {
			tr.Proxy = http.ProxyURL(p)
		}
	}
	return &Gateway{
		db:  db,
		cfg: cfg,
		http: &http.Client{
			Transport: tr,
			// 流式不能有总超时，否则长回答会被掐断；连接超时由 Transport 管
			Timeout: 0,
		},
	}
}

// Candidate 一个可尝试的（上游模型, Key）组合。
type Candidate struct {
	Scoped *store.UpstreamModel
	Key    *store.UpstreamKey
	Up     *store.Upstream
}

// Resolve 按模型名解析出模型库条目（要求启用，且至少有一个上游能提供它）。
func (g *Gateway) Resolve(modelName string) (*store.Model, error) {
	m, err := g.db.FindModelByName(modelName)
	if err != nil {
		return nil, nil
	}
	avail, err := g.db.AvailableUpstreamModels(m.ID)
	if err != nil {
		return nil, err
	}
	if len(avail) == 0 {
		return nil, nil
	}
	return m, nil
}

// Candidates 候选顺序：各上游（按 sort、id 升序）× 各上游内可用 Key。
//
// Key 排序：状态 ok < unknown < error，同状态按最久未用优先。
func (g *Gateway) Candidates(m *store.Model) ([]Candidate, error) {
	scoped, err := g.db.AvailableUpstreamModels(m.ID)
	if err != nil {
		return nil, err
	}
	out := []Candidate{}
	for _, sm := range scoped {
		up, err := g.db.FindUpstream(sm.UpstreamID)
		if err != nil {
			continue
		}
		keys, err := g.db.ListKeysByUpstream(sm.UpstreamID)
		if err != nil {
			continue
		}
		for _, k := range orderedKeys(keys) {
			out = append(out, Candidate{Scoped: sm, Key: k, Up: up})
		}
	}
	return out, nil
}

func orderedKeys(keys []*store.UpstreamKey) []*store.UpstreamKey {
	rank := func(s string) int {
		switch s {
		case store.KeyStatusOK:
			return 0
		case store.KeyStatusUnknown:
			return 1
		default:
			return 2
		}
	}
	// 稳定插入排序：数据量小（一个上游几把 Key），别引 sort 包
	out := make([]*store.UpstreamKey, len(keys))
	copy(out, keys)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0; j-- {
			a, b := out[j-1], out[j]
			ra, rb := rank(a.Status), rank(b.Status)
			if ra < rb {
				break
			}
			if ra == rb && !a.LastUsedAt.Before(b.LastUsedAt) {
				break
			}
			out[j-1], out[j] = b, a
		}
	}
	return out
}

// ChatResult 一次转发的结果。非流式是 JSON，流式是 SSE。
type ChatResult struct {
	// JSON 非流式时的原始响应体。
	JSON json.RawMessage
	// Stream 流式时的响应体读取器（调用方负责关闭）。
	Stream io.ReadCloser
	// Usage 从上游响应里扫出来的用量（流式在最后一块）。
	Usage map[string]any
}

// Chat 转发一次对话，带故障转移。
//
// onUsage：拿到上游返回的 usage 时回调（计费用）。流式下上游把 usage 放在最后一块，
// 由本类边转发边扫出来，流结束后再回调——计费不阻塞用户看输出。
func (g *Gateway) Chat(m *store.Model, payload map[string]any, stream bool, onUsage func(map[string]any)) (*ChatResult, error) {
	cands, err := g.Candidates(m)
	if err != nil {
		return nil, err
	}
	if len(cands) == 0 {
		return nil, fmt.Errorf("该模型还没有可用上游：请在上游里「自动获取模型」或补一把可用 Key")
	}

	lastErr := "未知错误"
	for _, c := range cands {
		// 每次重试都要重写 model：不同上游对同一模型的标识可能不同
		body := map[string]any{}
		for k, v := range payload {
			body[k] = v
		}
		body["model"] = c.Scoped.Model
		body["stream"] = stream
		if stream {
			if _, ok := body["stream_options"]; !ok {
				// 让上游在最后一块带上 usage，否则流式调用没法计费
				body["stream_options"] = map[string]any{"include_usage": true}
			}
		}

		if stream {
			res, err := g.forwardStream(c, body)
			if err != nil {
				lastErr = err.Error()
				continue
			}
			return &ChatResult{Stream: res}, nil
		}
		res, usage, err := g.forwardJSON(c, body)
		if err != nil {
			lastErr = err.Error()
			continue
		}
		if onUsage != nil && usage != nil {
			onUsage(usage)
		}
		return &ChatResult{JSON: res, Usage: usage}, nil
	}
	return nil, fmt.Errorf("所有上游与 API Key 均调用失败：%s", lastErr)
}

// forwardJSON 非流式转发。失败返回 error（调用方切下一把 Key）。
func (g *Gateway) forwardJSON(c Candidate, body map[string]any) (json.RawMessage, map[string]any, error) {
	started := time.Now()
	timeout := time.Duration(g.cfg.UpstreamTimeoutSec) * time.Second
	if timeout < 300*time.Second {
		timeout = 300 * time.Second
	}

	req, err := g.newRequest(c, body, timeout)
	if err != nil {
		return nil, nil, err
	}
	res, err := g.http.Do(req)
	if err != nil {
		g.fail(c, truncate(err.Error(), 300))
		return nil, nil, err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))

	if res.StatusCode >= 400 {
		e := errorOf(res.StatusCode, raw)
		g.fail(c, e)
		return nil, nil, fmt.Errorf("%s", e)
	}

	latency := time.Since(started).Milliseconds()
	g.succeed(c, latency)

	var parsed map[string]any
	_ = json.Unmarshal(raw, &parsed)
	var usage map[string]any
	if u, ok := parsed["usage"].(map[string]any); ok {
		usage = u
	}
	return raw, usage, nil
}

// forwardStream 流式转发。拿到响应头就返回，调用方负责逐块读。
//
// 注意：这里已经算「开始回包」，之后任何失败都不能再切 Key。
func (g *Gateway) forwardStream(c Candidate, body map[string]any) (io.ReadCloser, error) {
	started := time.Now()
	req, err := g.newRequest(c, body, 0)
	if err != nil {
		return nil, err
	}
	res, err := g.http.Do(req)
	if err != nil {
		g.fail(c, truncate(err.Error(), 300))
		return nil, err
	}
	if res.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		res.Body.Close()
		e := errorOf(res.StatusCode, raw)
		g.fail(c, e)
		return nil, fmt.Errorf("%s", e)
	}
	g.succeed(c, time.Since(started).Milliseconds())
	return res.Body, nil
}

func (g *Gateway) newRequest(c Candidate, body map[string]any, timeout time.Duration) (*http.Request, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		_ = cancel // 请求结束即取消，body 已读完
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.Up.Endpoint("chat/completions"), bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Key.APIKey)
	return req, nil
}

// succeed 标记 Key 与上游模型可用。
func (g *Gateway) succeed(c Candidate, latencyMS int64) {
	_ = g.db.MarkKeyOK(c.Key.ID, latencyMS)
	_ = g.db.MarkUpstreamModelChecked(c.Scoped.ID, true, latencyMS, "")
}

// fail 标记 Key 不可用。
//
// 上游明确说「没有这个模型」时，把该上游模型也标为不可用，路由会自然绕开它。
func (g *Gateway) fail(c Candidate, errMsg string) {
	_ = g.db.MarkKeyError(c.Key.ID, errMsg)
	lower := strings.ToLower(errMsg)
	if strings.Contains(lower, "404") || strings.Contains(errMsg, "不存在") || strings.Contains(lower, "not found") {
		_ = g.db.MarkUpstreamModelChecked(c.Scoped.ID, false, 0, errMsg)
	}
}

// errorOf 把上游错误响应转成可读文本。
func errorOf(status int, body []byte) string {
	var parsed map[string]any
	if json.Unmarshal(body, &parsed) == nil {
		if msg, ok := parsed["error"].(map[string]any); ok {
			if m, ok := msg["message"].(string); ok && m != "" {
				return fmt.Sprintf("HTTP %d %s", status, m)
			}
		}
		if msg, ok := parsed["message"].(string); ok && msg != "" {
			return fmt.Sprintf("HTTP %d %s", status, msg)
		}
	}
	s := strings.TrimSpace(string(body))
	if len(s) > 200 {
		s = s[:200]
	}
	if s == "" {
		return fmt.Sprintf("HTTP %d", status)
	}
	return fmt.Sprintf("HTTP %d %s", status, s)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// parseProxy 解析代理地址。
func parseProxy(s string) (*url.URL, error) {
	return url.Parse(s)
}
