package api

import (
	"sync"
	"time"
)

// pairStore 一次性授权码的临时存储。
//
// 用内存而不是数据库：授权码 10 分钟就作废，重启丢失完全可接受
// （用户重新点一次登录即可），省一张表和一次清理任务。
type pairStore struct {
	mu      sync.Mutex
	entries map[string]pairEntry
	expires map[string]time.Time
}

func newPairStore() *pairStore {
	p := &pairStore{entries: map[string]pairEntry{}, expires: map[string]time.Time{}}
	go p.gc()
	return p
}

// put 存一个授权码。
func (p *pairStore) put(code string, e pairEntry, ttl time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.entries[code] = e
	p.expires[code] = time.Now().Add(ttl)
}

// take 取走一个授权码（一次性，取出即作废）。
func (p *pairStore) take(code string) (pairEntry, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.entries[code]
	if !ok {
		return pairEntry{}, false
	}
	exp := p.expires[code]
	delete(p.entries, code)
	delete(p.expires, code)
	// 先取过期时间再删：删了就拿不到了
	if time.Now().After(exp) {
		return pairEntry{}, false
	}
	return e, true
}

// gc 每分钟清一次过期的。
func (p *pairStore) gc() {
	for range time.Tick(time.Minute) {
		p.mu.Lock()
		now := time.Now()
		for code, exp := range p.expires {
			if now.After(exp) {
				delete(p.entries, code)
				delete(p.expires, code)
			}
		}
		p.mu.Unlock()
	}
}
