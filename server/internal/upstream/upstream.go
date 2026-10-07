// Package upstream 管上游的模型同步与探测。
//
// 所有对上游的 HTTP 调用都走这里，超时、代理、证书校验只维护一份
// （与 gateway 包共用 config，但那边要流式、这边都是短请求，所以各有一个 client）。
package upstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/config"
	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// Service 上游服务。
type Service struct {
	db   *store.DB
	cfg  *config.Config
	http *http.Client
}

// New 建服务。
func New(db *store.DB, cfg *config.Config) *Service {
	tr := &http.Transport{MaxIdleConns: 16, IdleConnTimeout: 60 * time.Second}
	if cfg.UpstreamProxy != "" {
		if p, err := url.Parse(cfg.UpstreamProxy); err == nil {
			tr.Proxy = http.ProxyURL(p)
		}
	}
	return &Service{
		db:  db,
		cfg: cfg,
		http: &http.Client{
			Transport: tr,
			Timeout:   time.Duration(cfg.UpstreamTimeoutSec) * time.Second,
		},
	}
}

// TestResult 一次探测/测试的结果。
type TestResult struct {
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latency_ms"`
	Message   string `json:"message"`
	Models    int    `json:"models,omitempty"`
}

// TestKey 测一把 Key：拉一次模型清单。
func (s *Service) TestKey(up *store.Upstream, key *store.UpstreamKey) TestResult {
	started := time.Now()
	models, err := s.fetchModels(up, key.APIKey)
	latency := time.Since(started).Milliseconds()
	if err != nil {
		_ = s.db.MarkKeyError(key.ID, err.Error())
		return TestResult{OK: false, LatencyMS: latency, Message: err.Error()}
	}
	_ = s.db.MarkKeyOK(key.ID, latency)
	return TestResult{OK: true, LatencyMS: latency, Message: "连接成功", Models: len(models)}
}

// TestUpstream 测整个上游：用第一把启用的 Key。
func (s *Service) TestUpstream(up *store.Upstream) TestResult {
	keys, err := s.db.ListKeysByUpstream(up.ID)
	if err != nil {
		return TestResult{Message: err.Error()}
	}
	for _, k := range keys {
		if !k.Enabled {
			continue
		}
		return s.TestKey(up, k)
	}
	return TestResult{Message: "还没有可用的 API Key"}
}

// TestModel 测模型：沿网关候选顺序试到第一个能用的。
func (s *Service) TestModel(m *store.Model) TestResult {
	cands, err := s.candidates(m)
	if err != nil {
		return TestResult{Message: err.Error()}
	}
	if len(cands) == 0 {
		return TestResult{Message: "该模型还没有可用上游"}
	}
	var lastErr string
	for _, c := range cands {
		started := time.Now()
		body := map[string]any{
			"model":      c.scoped.Model,
			"messages":   []map[string]string{{"role": "user", "content": "hi"}},
			"max_tokens": 1,
		}
		status, raw, err := s.post(c.up, c.key.APIKey, "chat/completions", body)
		latency := time.Since(started).Milliseconds()
		if err != nil {
			lastErr = err.Error()
			_ = s.db.MarkKeyError(c.key.ID, lastErr)
			continue
		}
		if status >= 400 {
			lastErr = errorOf(status, raw)
			_ = s.db.MarkKeyError(c.key.ID, lastErr)
			continue
		}
		_ = s.db.MarkKeyOK(c.key.ID, latency)
		_ = s.db.MarkUpstreamModelChecked(c.scoped.ID, true, latency, "")
		return TestResult{OK: true, LatencyMS: latency, Message: "调用成功"}
	}
	return TestResult{Message: "所有上游与 Key 均失败：" + lastErr}
}

// ProbeKey 探测一把 Key 下各模型的可用性（并发，逐个标记）。
func (s *Service) ProbeKey(up *store.Upstream, key *store.UpstreamKey) TestResult {
	models, err := s.db.ListUpstreamModels(up.ID)
	if err != nil {
		return TestResult{Message: err.Error()}
	}
	enabled := []*store.UpstreamModel{}
	for _, m := range models {
		if m.Enabled {
			enabled = append(enabled, m)
		}
	}
	if len(enabled) == 0 {
		return TestResult{Message: "还没有上游模型，请先「自动获取模型」"}
	}

	var wg sync.WaitGroup
	var mu sync.Mutex
	okCount := 0
	sem := make(chan struct{}, 4) // 别把上游打爆

	for _, m := range enabled {
		wg.Add(1)
		go func(m *store.UpstreamModel) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			started := time.Now()
			body := map[string]any{
				"model":      m.Model,
				"messages":   []map[string]string{{"role": "user", "content": "hi"}},
				"max_tokens": 1,
			}
			status, raw, err := s.post(up, key.APIKey, "chat/completions", body)
			latency := time.Since(started).Milliseconds()
			if err != nil {
				_ = s.db.MarkUpstreamModelChecked(m.ID, false, latency, err.Error())
				return
			}
			if status >= 400 {
				_ = s.db.MarkUpstreamModelChecked(m.ID, false, latency, errorOf(status, raw))
				return
			}
			_ = s.db.MarkUpstreamModelChecked(m.ID, true, latency, "")
			mu.Lock()
			okCount++
			mu.Unlock()
		}(m)
	}
	wg.Wait()

	_ = s.db.MarkKeyOK(key.ID, 0)
	return TestResult{OK: okCount > 0, Message: fmt.Sprintf("探测完成：%d/%d 可用", okCount, len(enabled))}
}

// SyncModels 自动获取上游模型清单并落库。
func (s *Service) SyncModels(up *store.Upstream) (int, error) {
	keys, err := s.db.ListKeysByUpstream(up.ID)
	if err != nil {
		return 0, err
	}
	var names []string
	var lastErr error
	for _, k := range keys {
		if !k.Enabled {
			continue
		}
		names, lastErr = s.fetchModels(up, k.APIKey)
		if lastErr == nil {
			break
		}
	}
	if lastErr != nil && len(names) == 0 {
		return 0, fail(lastErr.Error())
	}

	added := 0
	for _, n := range names {
		before := s.countUpstreamModels(up.ID, n)
		if err := s.db.UpsertUpstreamModel(up.ID, n); err != nil {
			return added, err
		}
		if before == 0 {
			added++
		}
	}
	up.ModelsSyncedAt = store.Now()
	if err := s.db.SaveUpstream(up); err != nil {
		return added, err
	}
	return added, nil
}

func (s *Service) countUpstreamModels(upstreamID int64, name string) int {
	var n int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM ai_upstream_models WHERE upstream_id = ? AND model = ?`, upstreamID, name).Scan(&n)
	return n
}

// ImportToCatalog 把上游模型导入模型库。
//
// names 为空表示导入该上游下全部已启用模型。
func (s *Service) ImportToCatalog(up *store.Upstream, names []string, builtin bool, ratio float64) (int, error) {
	if ratio <= 0 {
		ratio = 1
	}
	models, err := s.db.ListUpstreamModels(up.ID)
	if err != nil {
		return 0, err
	}
	want := map[string]bool{}
	for _, n := range names {
		want[strings.TrimSpace(n)] = true
	}

	imported := 0
	for _, m := range models {
		if !m.Enabled {
			continue
		}
		if len(want) > 0 && !want[m.Model] {
			continue
		}
		if _, err := s.db.FindModelByName(m.Model); err == nil {
			continue // 模型库里已有，跳过
		}
		nm := &store.Model{
			Name: m.Model, Builtin: builtin, Ratio: ratio, Enabled: true, Sort: 0,
		}
		if err := s.db.CreateModel(nm); err != nil {
			return imported, err
		}
		_, _ = s.db.MatchUpstreamModels(nm.ID, nm.Name)
		imported++
	}
	return imported, nil
}

// ---------- 内部 ----------

type candidate struct {
	up     *store.Upstream
	key    *store.UpstreamKey
	scoped *store.UpstreamModel
}

// candidates 与 gateway.Candidates 同序：上游 sort/id 升序 × Key 状态优先。
func (s *Service) candidates(m *store.Model) ([]candidate, error) {
	scoped, err := s.db.AvailableUpstreamModels(m.ID)
	if err != nil {
		return nil, err
	}
	out := []candidate{}
	for _, sm := range scoped {
		up, err := s.db.FindUpstream(sm.UpstreamID)
		if err != nil {
			continue
		}
		keys, err := s.db.ListKeysByUpstream(sm.UpstreamID)
		if err != nil {
			continue
		}
		for _, k := range keys {
			if !k.Enabled {
				continue
			}
			out = append(out, candidate{up: up, key: k, scoped: sm})
		}
	}
	return out, nil
}

// fetchModels 拉上游模型清单（OpenAI 兼容 GET /models）。
func (s *Service) fetchModels(up *store.Upstream, apiKey string) ([]string, error) {
	req, err := http.NewRequest("GET", up.Endpoint("models"), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	res, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接上游失败: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("%s", errorOf(res.StatusCode, raw))
	}

	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("上游返回的不是合法模型清单")
	}
	out := []string{}
	seen := map[string]bool{}
	for _, d := range parsed.Data {
		id := strings.TrimSpace(d.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}

// post 向上游发一个 JSON POST，返回状态码与响应体。
func (s *Service) post(up *store.Upstream, apiKey, path string, body any) (int, []byte, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequest("POST", up.Endpoint(path), bytes.NewReader(buf))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	res, err := s.http.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("连接上游失败: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return res.StatusCode, raw, nil
}

// ProbeChat 探一次对话（模型概况采集器用）。返回是否成功与响应摘要。
func (s *Service) ProbeChat(up *store.Upstream, apiKey, model string) (bool, []byte, error) {
	body := map[string]any{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "hi"}},
		"max_tokens": 1,
	}
	status, raw, err := s.post(up, apiKey, "chat/completions", body)
	if err != nil {
		return false, nil, err
	}
	if status >= 400 {
		return false, raw, fmt.Errorf("%s", errorOf(status, raw))
	}
	return true, raw, nil
}

// errorOf 把上游错误响应转成可读文本。
func errorOf(status int, body []byte) string {
	var parsed map[string]any
	if json.Unmarshal(body, &parsed) == nil {
		if e, ok := parsed["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok && m != "" {
				return fmt.Sprintf("HTTP %d %s", status, m)
			}
		}
		if m, ok := parsed["message"].(string); ok && m != "" {
			return fmt.Sprintf("HTTP %d %s", status, m)
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

func fail(msg string) error { return fmt.Errorf("%s", msg) }
