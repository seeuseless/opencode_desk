// Package health 是模型概况采集器（后台「Token Plan → 概况」的数据来源）。
//
// 守护模式：进程自己守 10 秒节拍，不用 cron。
// 每轮每个上游只探一个模型（同上游多模型轮换），所以节拍是「上游」的，不是每个模型的——
// 一次探完全部模型会把上游打爆，也容易触发并发限流。
package health

import (
	"log"
	"sync"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/store"
	"github.com/seeuseless/opencode_desk/server/internal/upstream"
)

// TickInterval 采集节拍。
const TickInterval = 10 * time.Second

// Watcher 采集器。
type Watcher struct {
	db *store.DB
	up *upstream.Service
	mu sync.Mutex
	// 每个上游下一次该探第几个模型（轮换游标）
	cursor map[int64]int
}

// New 建采集器。
func New(db *store.DB, up *upstream.Service) *Watcher {
	return &Watcher{db: db, up: up, cursor: map[int64]int{}}
}

// Start 启动守护循环（阻塞，放 goroutine 里跑）。
func (w *Watcher) Start() {
	log.Printf("[health] 模型概况采集器启动，节拍 %s", TickInterval)
	for {
		w.tick()
		time.Sleep(TickInterval)
	}
}

// tick 跑一轮：每个上游只探一个模型。
func (w *Watcher) tick() {
	w.mu.Lock()
	defer w.mu.Unlock()

	ups, err := w.db.UpstreamsForProbe()
	if err != nil {
		log.Printf("[health] 取上游列表失败: %v", err)
		return
	}
	for _, up := range ups {
		models, err := w.db.ListUpstreamModels(up.ID)
		if err != nil {
			continue
		}
		// 只探「已启用 + 已匹配到模型库」的：没匹配上的进了概况也没有模型名可显示
		targets := []*store.UpstreamModel{}
		for _, m := range models {
			if m.Enabled && m.ModelID != 0 {
				targets = append(targets, m)
			}
		}
		if len(targets) == 0 {
			continue
		}
		idx := w.cursor[up.ID] % len(targets)
		w.cursor[up.ID] = idx + 1
		target := targets[idx]

		keys, err := w.db.ListKeysByUpstream(up.ID)
		if err != nil {
			continue
		}
		var apiKey string
		for _, k := range keys {
			if k.Enabled {
				apiKey = k.APIKey
				break
			}
		}
		if apiKey == "" {
			continue
		}

		started := time.Now()
		_, raw, err := w.up.ProbeChat(up, apiKey, target.Model)
		latency := time.Since(started).Milliseconds()
		ok := err == nil
		errMsg := ""
		if err != nil {
			errMsg = err.Error()
		} else {
			errMsg = store.Truncate(string(raw), 200)
		}
		if err := w.db.RecordHealthCheck(target.ID, ok, latency, errMsg); err != nil {
			log.Printf("[health] 记探测结果失败: %v", err)
		}
	}
}
