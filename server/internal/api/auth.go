package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/store"
)

type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxToken
)

// auth Bearer 鉴权中间件。
//
// 401 一律回 JSON（桌面端与手机端都不是浏览器，跳登录页只会让它们更难排查）：
//
//	{"message": "未登录或授权已失效"}
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		plain := bearerToken(r)
		if plain == "" {
			writeErr(w, 401, "未登录或授权已失效")
			return
		}
		tok, err := s.db.FindTokenByPlain(plain)
		if err != nil {
			writeErr(w, 401, "未登录或授权已失效")
			return
		}
		user, err := s.db.FindUserByID(tok.UserID)
		if err != nil || !user.Active() {
			writeErr(w, 401, "未登录或授权已失效")
			return
		}
		ctx := context.WithValue(r.Context(), ctxUser, user)
		ctx = context.WithValue(ctx, ctxToken, tok)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// admin 要求管理员角色。
func (s *Server) admin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := userOf(r)
		if u == nil || !u.IsAdmin() {
			writeErr(w, 403, "需要管理员权限")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// userOf 取当前登录用户。
func userOf(r *http.Request) *store.User {
	u, _ := r.Context().Value(ctxUser).(*store.User)
	return u
}

// tokenOf 取当前令牌。
func tokenOf(r *http.Request) *store.Token {
	t, _ := r.Context().Value(ctxToken).(*store.Token)
	return t
}

// ---------- 限流 ----------

// limiter 简单的内存限流器（按 key 计数，窗口滑动）。
//
// 本地一体化模式下并发极低，不需要 Redis；独立部署单机也够。
// 真要扛分布式再换实现。
type limiter struct {
	hits map[string][]time.Time
	max  int
	win  time.Duration
}

func newLimiter(max int, win time.Duration) *limiter {
	return &limiter{hits: map[string][]time.Time{}, max: max, win: win}
}

// allow 记一次并判断是否放行。
func (l *limiter) allow(key string) bool {
	now := time.Now()
	cutoff := now.Add(-l.win)
	arr := l.hits[key]
	kept := arr[:0]
	for _, t := range arr {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	l.hits[key] = kept
	return len(kept) <= l.max
}

// throttle 按 IP 限流中间件。
func (s *Server) throttle(max int, win time.Duration) func(http.Handler) http.Handler {
	l := newLimiter(max, win)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !l.allow(clientIP(r)) {
				writeErr(w, 429, "请求过于频繁，请稍后再试")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// trimLen 截断字符串（按字节，够用于设备名/UA 这类短字段）。
func trimLen(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.TrimSpace(s[:n])
}
