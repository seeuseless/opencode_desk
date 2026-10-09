// Package api 是 HTTP 层：路由、中间件、统一响应。
//
// 路由口径与 docs/服务端API契约.md 逐条对应，改这里必须同步改契约。
package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"runtime/debug"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/seeuseless/opencode_desk/server/internal/config"
	"github.com/seeuseless/opencode_desk/server/internal/gateway"
	"github.com/seeuseless/opencode_desk/server/internal/store"
	"github.com/seeuseless/opencode_desk/server/internal/upstream"
	"github.com/seeuseless/opencode_desk/server/internal/web"
)

// chiRouter chi 路由器的别名（少打一串包名）。
type chiRouter = chi.Router

// Server 持有所有依赖。
type Server struct {
	cfg     *config.Config
	db      *store.DB
	mux     *chi.Mux
	pairs   *pairStore
	gw      *gateway.Gateway
	up      *upstream.Service
	version string
	// events 按设备唤醒手机端的等待者，把「1.2 秒轮一次」变成「有变化立刻到」
	events *eventNotifier
}

// New 建服务。
func New(cfg *config.Config, db *store.DB) *Server {
	s := &Server{
		cfg:     cfg,
		db:      db,
		mux:     chi.NewRouter(),
		pairs:   newPairStore(),
		gw:      gateway.New(db, cfg),
		up:      upstream.New(db, cfg),
		version: "1.0.0",
		events:  newEventNotifier(),
	}
	s.routes()
	return s
}

// Handler 实现 http.Handler。
func (s *Server) Handler() http.Handler { return s.mux }

func (s *Server) routes() {
	r := s.mux
	r.Use(middleware.Recoverer)
	r.Use(s.logger)

	r.Get("/up", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]any{"ok": true}) })

	// 桌面端启动时探测这个：通了就说明服务端活着，直接进入「已开启」状态。
	// 刻意放在 /api 下而不是 /up：桌面端只认 /api/* 是服务端的，别的路径可能是前端路由。
	r.Get("/api/health", s.handle(s.health))

	r.Route("/api", func(r chi.Router) {
		// 鉴权
		r.With(s.auth).Post("/ide/pair", s.handle(s.pair))
		r.Post("/ide/token", s.handle(s.token))
		r.With(s.auth).Post("/ide/logout", s.handle(s.logout))
		r.With(s.auth).Get("/ide/me", s.handle(s.me))

		// 网关（OpenAI 兼容）
		r.With(s.auth).Get("/ide/v1/models", s.handle(s.models))
		r.With(s.auth).Post("/ide/v1/chat/completions", s.handle(s.chatCompletions))

		// 中转通道 · 桌面端
		r.With(s.auth).Post("/ide/desk/register", s.handle(s.register))
		r.With(s.auth).Get("/ide/desk/devices", s.handle(s.devices))
		r.With(s.auth).Delete("/ide/desk/devices/{device}", s.handle(s.revokeDevice))
		r.With(s.auth).Post("/ide/desk/pull", s.handle(s.pull))
		r.With(s.auth).Post("/ide/desk/result", s.handle(s.result))
		r.With(s.auth).Post("/ide/desk/events", s.handle(s.deskEvents))

		// 中转通道 · 手机端（不需要登录，token 就是凭证）
		r.Get("/ide/device/{token}", s.handle(s.deviceShow))
		r.Post("/ide/device/{token}/rpc", s.handle(s.deviceRPC))
		r.Get("/ide/device/{token}/rpc/{rpc}", s.handle(s.deviceRPCResult))
		r.Get("/ide/device/{token}/events", s.handle(s.deviceEvents))

		// 用量与积分
		r.With(s.auth).Get("/ide/usage/summary", s.handle(s.usageSummary))
		r.With(s.auth).Get("/ide/usage/logs", s.handle(s.usageLogs))
		r.With(s.auth).Get("/ide/usage/records", s.handle(s.usageRecords))

		// 后台管理
		r.Get("/settings", s.handle(s.publicSettings))
		r.Post("/auth/login", s.handle(s.adminLogin))
		r.With(s.auth).Get("/auth/me", s.handle(s.authMe))
		s.mountAdmin(r)
	})

	// 前端静态资源（后台 + 手机端页面）
	s.mountWeb(r)
}

// mountWeb 挂前端静态资源。SPA 兜底：非 api/up/storage 路径都回 index.html。
func (s *Server) mountWeb(r chi.Router) {
	h, err := web.Handler(s.cfg.WebDir)
	if err != nil {
		// 前端没构建不阻塞 API：桌面端与手机端的接口照样能用
		log.Printf("[warn] 前端资源不可用: %v", err)
		return
	}
	r.Handle("/*", h)
	r.Handle("/", h)
}

// handle 把 (w, r) 形式的 handler 包成 chi 要的形式，统一处理 panic 与错误。
func (s *Server) handle(fn func(w http.ResponseWriter, r *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[panic] %v\n%s", rec, debug.Stack())
				writeErr(w, 500, "服务端内部错误")
			}
		}()
		if err := fn(w, r); err != nil {
			writeHTTPErr(w, err)
		}
	}
}

// ---------- 响应工具 ----------

// writeJSON 写 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return nil
	}
	return json.NewEncoder(w).Encode(v)
}

// writeErr 写错误。message 是给用户看的中文可读原因。
func writeErr(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"message": message})
}

// httpErr 带状态码的错误。
type httpErr struct {
	status int
	msg    string
}

func (e *httpErr) Error() string { return e.msg }

// fail 构造一个带状态码的错误。
//
// 刻意不用 fmt.Errorf 的格式语义：这里的 message 都是给用户看的中文可读原因，
// 拼接比占位符直观，也不会有人误把用户输入当格式串传进来。
func fail(status int, message string) error {
	return &httpErr{status: status, msg: message}
}

// writeHTTPErr 把错误转成响应。
func writeHTTPErr(w http.ResponseWriter, err error) {
	var he *httpErr
	if errors.As(err, &he) {
		writeErr(w, he.status, he.msg)
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, 404, "记录不存在")
		return
	}
	log.Printf("[error] %v", err)
	writeErr(w, 500, "服务端内部错误")
}

// ---------- 请求解析 ----------

// decodeJSON 解析请求体。空体当空对象，别让可选字段全必填的接口炸掉。
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return fail(422, "请求体不是合法 JSON")
	}
	return nil
}

// query 取查询参数。
func query(r *http.Request, key string) string { return r.URL.Query().Get(key) }

// queryInt 取整数查询参数；非法或缺失返回 def。
func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n := 0
	for _, c := range v {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if n <= 0 {
		return def
	}
	return n
}

// urlParamInt 取路径里的整数参数。
func urlParamInt(r *http.Request, key string) (int64, error) {
	v := paramOf(r, key)
	if v == "" {
		return 0, fail(404, "缺少参数 "+key)
	}
	var n int64
	for _, c := range v {
		if c < '0' || c > '9' {
			return 0, fail(404, "参数 "+key+" 不是数字")
		}
		n = n*10 + int64(c-'0')
	}
	return n, nil
}

// paramOf 取路径参数。
func paramOf(r *http.Request, key string) string { return chi.URLParam(r, key) }

// bearerToken 从 Authorization 头取 token。
func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):])
	}
	return ""
}

// clientIP 取请求 IP。
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i > 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if i := strings.LastIndex(r.RemoteAddr, ":"); i > 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

// logErr 记一条不该打断主流程的错误（计费失败、日志写入失败之类）。
func logErr(err error) {
	log.Printf("[warn] %v", err)
}

func (s *Server) logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}
