package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// pairTTL 一次性授权码有效期。
const pairTTL = 10 * time.Minute

// tokenYears 长期 token 有效期。
const tokenYears = 10

// pairReq 生成授权码请求。
type pairReq struct {
	Device string `json:"device"`
}

// pair 网页端已登录后生成一次性授权码（桌面端登录链路第 2 步）。
func (s *Server) pair(w http.ResponseWriter, r *http.Request) error {
	u := userOf(r)
	if u == nil {
		return fail(401, "未登录或授权已失效")
	}
	if !u.Active() {
		return fail(403, "账号已被禁用")
	}
	var req pairReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	code, err := randomHex(24)
	if err != nil {
		return err
	}
	s.pairs.put(code, pairEntry{userID: u.ID, device: trimLen(req.Device, 100)}, pairTTL)

	return writeJSON(w, 200, map[string]any{
		"code":       code,
		"expires_in": int(pairTTL.Seconds()),
		"app_url":    "qingniao://auth?code=" + code,
		"user":       userPayload(u),
	})
}

// tokenReq 授权码换 token 请求。
type tokenReq struct {
	Code   string `json:"code"`
	Device string `json:"device"`
}

// token 授权码换长期 token（公开接口，靠一次性码鉴权）。
func (s *Server) token(w http.ResponseWriter, r *http.Request) error {
	var req tokenReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	entry, ok := s.pairs.take(req.Code)
	if !ok {
		return fail(422, "授权码无效或已过期，请重新登录")
	}
	u, err := s.db.FindUserByID(entry.userID)
	if err != nil || !u.Active() {
		return fail(403, "账号不存在或已被禁用")
	}

	device := strings.TrimSpace(req.Device)
	if device == "" {
		device = strings.TrimSpace(entry.device)
	}
	if device == "" {
		device = "青鸟"
	}
	device = trimLen(device, 80)

	plain, tok, err := s.db.CreateToken(u.ID, "ide:"+device, clientIP(r), r.UserAgent(), time.Now().AddDate(tokenYears, 0, 0))
	if err != nil {
		return err
	}
	_ = s.db.AddLoginLog(&store.LoginLog{
		UserID: u.ID, IP: clientIP(r), Device: "青鸟 · " + device, UA: trimLen(r.UserAgent(), 500),
	})

	return writeJSON(w, 200, map[string]any{
		"token":      plain,
		"expires_at": store.FormatISO(tok.ExpiresAt),
		"user":       userPayload(u),
		"gateway":    s.cfg.BaseURL() + "/api/ide/v1",
	})
}

// logout 吊销当前 token。
func (s *Server) logout(w http.ResponseWriter, r *http.Request) error {
	if t := tokenOf(r); t != nil {
		_ = s.db.DeleteToken(t.ID)
	}
	writeJSON(w, 200, map[string]string{"message": "已退出登录"})
	return nil
}

// me 桌面端自检：token 还能用吗 + 是谁。
func (s *Server) me(w http.ResponseWriter, r *http.Request) error {
	u := userOf(r)
	t := tokenOf(r)
	return writeJSON(w, 200, map[string]any{
		"user":    userPayload(u),
		"token":   tokenPayload(t),
		"gateway": s.cfg.BaseURL() + "/api/ide/v1",
	})
}

// ---------- 后台登录 ----------

type adminLoginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// adminLogin 后台账号密码登录。
func (s *Server) adminLogin(w http.ResponseWriter, r *http.Request) error {
	var req adminLoginReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	email := strings.TrimSpace(req.Email)
	if email == "" || req.Password == "" {
		return fail(422, "请输入邮箱与密码")
	}
	u, err := s.db.FindUserByEmail(email)
	if err != nil || !store.CheckPassword(req.Password, u.Password) {
		return fail(422, "邮箱或密码不正确")
	}
	if !u.Active() {
		return fail(403, "账号已被禁用")
	}
	plain, _, err := s.db.CreateToken(u.ID, "web", clientIP(r), r.UserAgent(), time.Now().AddDate(1, 0, 0))
	if err != nil {
		return err
	}
	_ = s.db.AddLoginLog(&store.LoginLog{
		UserID: u.ID, IP: clientIP(r), Device: "后台", UA: trimLen(r.UserAgent(), 500),
	})
	writeJSON(w, 200, map[string]any{"token": plain, "user": userPayload(u)})
	return nil
}

// signUpReq 注册请求（名字避开 desk_handler.go 里那个设备注册的 registerReq）。
type signUpReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	Code     string `json:"code"`
}

// fixedRegisterCode 固定的邮箱验证码。
//
// 为什么写死：本地一体化模式下平台跟着桌面端走，没有可投递的邮箱，
// 真发验证码只会让人卡在「等一封永远不会来的邮件」上。
// 界面上直接把提示码写出来，用户照填即可——它拦的是**手滑打错**，
// 不是安全边界（真要防机器人得接短信/Turnstile，那不在精简范围内）。
const fixedRegisterCode = "000000"

// signUp 注册一个新账号（公开接口）。名字不叫 register：desk_handler.go 里那个
// register 是「桌面端注册本机设备」，两个概念撞名容易看错。
//
// 建出来的都是 member：管理员只有一个，且只在首次启动时由 ensureAdmin 自动创建，
// 注册入口绝不能给「自助变管理员」留口子——否则谁都能进后台。
// 注册成功直接发一个长期 token，省得再跳回登录页输一遍。
func (s *Server) signUp(w http.ResponseWriter, r *http.Request) error {
	var req signUpReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	name := strings.TrimSpace(req.Name)
	pass := req.Password

	// 邮箱只做最基础的形状校验：必须像邮箱、大小写归一后长度合理。
	// 不验证「这个邮箱存不存在」——那是发验证码邮件的前提，这里没有邮件可发。
	at := strings.Index(email, "@")
	if at <= 0 || at == len(email)-1 || !strings.Contains(email[at:], ".") ||
		strings.ContainsAny(email, " \t\r\n") || len(email) > 120 {
		return fail(422, "邮箱格式不正确")
	}
	if len(pass) < 6 || len(pass) > 72 {
		return fail(422, "密码长度需在 6~72 位之间")
	}
	if strings.TrimSpace(req.Code) != fixedRegisterCode {
		return fail(422, "验证码不正确")
	}

	// 没填账号名就用邮箱 @ 前那段，省得注册页多一个必填项
	if name == "" {
		name = email[:at]
	}
	name = trimLen(name, 60)
	if name == "" {
		return fail(422, "请填写账号名")
	}

	// 邮箱已被占用要说人话：直接透传建表时的 UNIQUE 报错会露出 SQL
	if _, err := s.db.FindUserByEmail(email); err == nil {
		return fail(409, "该邮箱已注册，请直接登录")
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}

	hash, err := store.HashPassword(pass)
	if err != nil {
		return err
	}
	u := &store.User{
		Name:     name,
		Email:    email,
		Password: hash,
		Role:     store.RoleMember,
		Status:   store.StatusActive,
	}
	if err := s.db.CreateUser(u); err != nil {
		// 并发注册时后一个会撞 UNIQUE，同样按「已注册」回
		if _, lookupErr := s.db.FindUserByEmail(email); lookupErr == nil {
			return fail(409, "该邮箱已注册，请直接登录")
		}
		return err
	}

	// 注册即登录：省掉「注册完还要再登录一次」这一步
	plain, _, err := s.db.CreateToken(u.ID, "web", clientIP(r), r.UserAgent(), time.Now().AddDate(1, 0, 0))
	if err != nil {
		return err
	}
	_ = s.db.AddLoginLog(&store.LoginLog{
		UserID: u.ID, IP: clientIP(r), Device: "注册", UA: trimLen(r.UserAgent(), 500),
	})

	log.Printf("[register] 新账号：%s（%s）", u.Email, u.Name)
	return writeJSON(w, 200, map[string]any{"token": plain, "user": userPayload(u)})
}

// authMe 后台当前登录者。
func (s *Server) authMe(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, 200, map[string]any{"user": userPayload(userOf(r))})
	return nil
}

// publicSettings GET /api/settings ——后台界面要用的公开设置。
//
// 只回站点名：权限组、小程序装修、应用市场、邮件那套配置都在精简范围外，
// 前端 AdminLayout 拿 mall_name 显示标题就够了。管理员额外信息走 /api/auth/me。
func (s *Server) publicSettings(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, 200, map[string]any{
		"mall_name": s.settingOf("mall_name", "青鸟平台"),
		"logo_url":  s.settingOf("logo_url", ""),
	})
	return nil
}

// settingOf 读一个系统设置；没有则给默认值。
func (s *Server) settingOf(key, def string) string {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if err != nil || v == "" {
		return def
	}
	return v
}

// ---------- 内部 ----------

type pairEntry struct {
	userID int64
	device string
}

func userPayload(u *store.User) map[string]any {
	return map[string]any{
		"id":    u.ID,
		"name":  u.Name,
		"email": u.Email,
		// role 必须有：前端登录/进入后台都要拿它判断「仅平台管理员」。
		"role": u.Role,
	}
}

func tokenPayload(t *store.Token) map[string]any {
	if t == nil {
		return nil
	}
	return map[string]any{
		"id":         t.ID,
		"name":       t.Name,
		"expires_at": store.FormatISO(t.ExpiresAt),
	}
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
