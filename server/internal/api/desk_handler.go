package api

import (
	"net/http"
	"strings"

	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// registerReq 注册设备请求。
type registerReq struct {
	Name     string `json:"name"`
	Platform string `json:"platform"`
	Rotate   bool   `json:"rotate"`
}

// register POST /api/ide/desk/register — 注册/复用本机设备。
//
// 同一账号下同名设备重复注册会复用原来那台（重装应用不换二维码），想换码传 rotate=true。
// 注册本身就是「桌面端此刻活着」的证据：顺手点亮在线状态，
// 否则手机刚扫完码会先看到一句「电脑不在线」，要等下一个认领周期才恢复。
func (s *Server) register(w http.ResponseWriter, r *http.Request) error {
	var req registerReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 100 {
		return fail(422, "name 必填且不超过 100 字")
	}
	u := userOf(r)

	dev, err := s.db.FindDeviceByName(u.ID, name)
	if err != nil {
		// 新设备
		token, err := store.NewDeviceToken()
		if err != nil {
			return err
		}
		secret, err := store.NewDeviceSecret()
		if err != nil {
			return err
		}
		dev = &store.Device{
			UserID: u.ID, Name: name, Platform: trimLen(req.Platform, 60),
			Token: token, Secret: secret, Enabled: true, LastSeenAt: store.Now(),
		}
		if err := s.db.CreateDevice(dev); err != nil {
			return err
		}
		_ = writeJSON(w, 200, s.devicePayload(dev, true))
		return nil
	}

	// 复用：换码只换二维码那串，secret 不动，正在跑的通道不断
	dev.Platform = trimLen(req.Platform, 60)
	if req.Rotate {
		token, err := store.NewDeviceToken()
		if err != nil {
			return err
		}
		dev.Token = token
	}
	dev.Enabled = true
	dev.LastSeenAt = store.Now()
	if err := s.db.SaveDevice(dev); err != nil {
		return err
	}
	writeJSON(w, 200, s.devicePayload(dev, true))
	return nil
}

// devices GET /api/ide/desk/devices — 我账号下的所有桌面端。
func (s *Server) devices(w http.ResponseWriter, r *http.Request) error {
	list, err := s.db.ListDevicesByUser(userOf(r).ID)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, d := range list {
		out = append(out, s.devicePayload(d, false))
	}
	writeJSON(w, 200, out)
	return nil
}

// revokeDevice DELETE /api/ide/desk/devices/{device} — 吊销一台桌面端（二维码立即作废）。
func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) error {
	id, err := urlParamInt(r, "device")
	if err != nil {
		return err
	}
	dev, err := s.db.FindDeviceByID(id)
	if err != nil || dev.UserID != userOf(r).ID {
		return fail(404, "该客户端不存在")
	}
	if err := s.db.DeleteDevice(id); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "该客户端授权已吊销"})
	return nil
}

// identityReq 双因子请求体。
type identityReq struct {
	DeviceID int64  `json:"device_id"`
	Secret   string `json:"secret"`
}

// approved Bearer 身份 + device_id/secret 双因子校验，拿到这台设备。
//
// 二维码泄露的人只知道 token，冒充不了桌面端拉指令——secret 只发给桌面端自己。
func (s *Server) approved(r *http.Request, req identityReq) (*store.Device, error) {
	if req.DeviceID <= 0 || req.Secret == "" {
		return nil, fail(403, "设备身份校验失败，请重新登录青鸟")
	}
	dev, err := s.db.FindDeviceByID(req.DeviceID)
	if err != nil || dev.UserID != userOf(r).ID || !dev.Enabled {
		return nil, fail(403, "设备身份校验失败，请重新登录青鸟")
	}
	if dev.Secret != req.Secret {
		return nil, fail(403, "设备身份校验失败，请重新登录青鸟")
	}
	return dev, nil
}

// pullReq 认领请求。
type pullReq struct {
	identityReq
}

// pull POST /api/ide/desk/pull — 认领指令（桌面端每 1.2 秒一次）。
func (s *Server) pull(w http.ResponseWriter, r *http.Request) error {
	var req pullReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	dev, err := s.approved(r, req.identityReq)
	if err != nil {
		return err
	}
	_ = s.db.TouchDeviceSeen(dev.ID)

	// 上一轮取走却没回结果的（进程被杀/内核重启）放回去重试，否则手机会一直转圈
	_ = s.db.RequeueStaleRPCs(dev.ID)

	rpcs, err := s.db.PullRPCs(dev.ID, store.PullLimit)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for _, x := range rpcs {
		out = append(out, map[string]any{
			"id":     x.ID,
			"method": x.Method,
			"params": decodeParams(x.Params),
		})
	}
	return writeJSON(w, 200, map[string]any{
		"rpcs":   out,
		"mobile": dev.MobileOnline(),
	})
}

// resultReq 回填结果请求。
type resultReq struct {
	identityReq
	ID     int64  `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result"`
	Error  string `json:"error"`
}

// result POST /api/ide/desk/result — 回填指令结果。
func (s *Server) result(w http.ResponseWriter, r *http.Request) error {
	var req resultReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	dev, err := s.approved(r, req.identityReq)
	if err != nil {
		return err
	}
	if req.ID <= 0 {
		return fail(422, "id 必填")
	}
	if _, err := s.db.FindRPC(dev.ID, req.ID); err != nil {
		return fail(404, "指令不存在")
	}
	resultJSON := ""
	if req.OK && req.Result != nil {
		if b, err := marshalJSON(req.Result); err == nil {
			resultJSON = string(b)
		}
	}
	errMsg := ""
	if !req.OK {
		errMsg = trimLen(req.Error, 2000)
		if errMsg == "" {
			errMsg = "执行失败"
		}
	}
	if err := s.db.FinishRPC(dev.ID, req.ID, req.OK, resultJSON, errMsg); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "ok"})
	return nil
}

// deskEventsReq 批量上报事件请求。
type deskEventsReq struct {
	identityReq
	Events []eventItem `json:"events"`
}

type eventItem struct {
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

// deskEvents POST /api/ide/desk/events — 批量上报内核事件。
func (s *Server) deskEvents(w http.ResponseWriter, r *http.Request) error {
	var req deskEventsReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	dev, err := s.approved(r, req.identityReq)
	if err != nil {
		return err
	}
	if len(req.Events) > 200 {
		return fail(422, "events 一次最多 200 条")
	}
	items := []store.EventInput{}
	for _, e := range req.Events {
		t := strings.TrimSpace(e.Type)
		if t == "" || len(t) > 80 {
			return fail(422, "events.*.type 必填且不超过 80 字")
		}
		payload := ""
		if e.Payload != nil {
			if b, err := marshalJSON(e.Payload); err == nil {
				payload = string(b)
			}
		}
		items = append(items, store.EventInput{Type: t, Payload: payload})
	}
	if err := s.db.AddEvents(dev.ID, items); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]string{"message": "ok"})
	return nil
}

// devicePayload 设备对外表示。secret 只在注册时下发一次。
func (s *Server) devicePayload(d *store.Device, withSecret bool) map[string]any {
	out := map[string]any{
		"id":             d.ID,
		"name":           d.Name,
		"platform":       d.Platform,
		"token":          d.Token,
		"path":           d.Path(),
		"url":            s.cfg.BaseURL() + d.Path(),
		"enabled":        d.Enabled,
		"online":         d.Online(),
		"mobile_online":  d.MobileOnline(),
		"last_seen_at":   fmtTime(d.LastSeenAt),
		"mobile_seen_at": fmtTime(d.MobileSeenAt),
		"created_at":     fmtTime(d.CreatedAt),
	}
	if withSecret {
		out["secret"] = d.Secret
	}
	return out
}
