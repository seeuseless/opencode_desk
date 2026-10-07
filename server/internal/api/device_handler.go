package api

import (
	"net/http"
	"strings"

	"github.com/seeuseless/opencode_desk/server/internal/store"
)

// 允许手机下发的指令（桌面端 relay.ts 的 run() 有同名实现，改动要两边一起）。
var rpcMethods = map[string]bool{
	"projects.list":    true,
	"models.list":      true,
	"sessions.list":    true,
	"session.create":   true,
	"session.messages": true,
	"session.send":     true,
	"session.stop":     true,
}

// deviceShow GET /api/ide/device/{token} — 落地信息。
//
// 不需要登录：二维码里的 token 就是凭证，扫码的人本来就已经在电脑主人身边。
// token 每台电脑唯一，泄露了在电脑上「换一张二维码」即可作废，比裸 IP 地址安全得多。
func (s *Server) deviceShow(w http.ResponseWriter, r *http.Request) error {
	dev, err := s.deviceByToken(r)
	if err != nil {
		return err
	}
	_ = s.db.TouchDeviceMobile(dev.ID)

	u, _ := s.db.FindUserByID(dev.UserID)
	var userName, userEmail string
	if u != nil {
		userName, userEmail = u.Name, u.Email
	}
	return writeJSON(w, 200, map[string]any{
		"device": map[string]any{
			"id":           dev.ID,
			"name":         dev.Name,
			"platform":     dev.Platform,
			"online":       dev.Online(),
			"last_seen_at": fmtTime(dev.LastSeenAt),
		},
		"user": map[string]any{"name": userName, "email": userEmail},
	})
}

// deviceRPCReq 下发指令请求。
type deviceRPCReq struct {
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// deviceRPC POST /api/ide/device/{token}/rpc — 下发一条指令。
func (s *Server) deviceRPC(w http.ResponseWriter, r *http.Request) error {
	dev, err := s.deviceByToken(r)
	if err != nil {
		return err
	}
	_ = s.db.TouchDeviceMobile(dev.ID)
	if !dev.Online() {
		return fail(409, "电脑不在线：请确认青鸟已打开、账号已登录、且「移动端连接」已开启")
	}

	var req deviceRPCReq
	if err := decodeJSON(r, &req); err != nil {
		return err
	}
	if !rpcMethods[req.Method] {
		return fail(422, "不支持的指令："+req.Method)
	}
	params := ""
	if req.Params != nil {
		if b, err := marshalJSON(req.Params); err == nil {
			params = string(b)
		}
	}
	rpc := &store.RPC{DeviceID: dev.ID, Method: req.Method, Params: params, Status: store.RPCStatusPending}
	if err := s.db.CreateRPC(rpc); err != nil {
		return err
	}
	writeJSON(w, 200, map[string]any{"id": rpc.ID, "status": store.RPCStatusPending})
	return nil
}

// deviceRPCResult GET /api/ide/device/{token}/rpc/{rpc} — 取指令结果（手机每 500ms 轮询）。
func (s *Server) deviceRPCResult(w http.ResponseWriter, r *http.Request) error {
	dev, err := s.deviceByToken(r)
	if err != nil {
		return err
	}
	_ = s.db.TouchDeviceMobile(dev.ID)
	id, err := urlParamInt(r, "rpc")
	if err != nil {
		return err
	}
	rpc, err := s.db.FindRPC(dev.ID, id)
	if err != nil {
		return fail(404, "指令不存在")
	}
	// 电脑中途下线/被杀，指令会一直挂在 running；超时就地对账成失败
	if rpc.Status == store.RPCStatusPending || rpc.Status == store.RPCStatusRunning {
		_ = s.db.FailTimedOutRPCs(dev.ID)
		if fresh, err := s.db.FindRPC(dev.ID, id); err == nil {
			rpc = fresh
		}
	}
	return writeJSON(w, 200, map[string]any{
		"id":     rpc.ID,
		"status": rpc.Status,
		"result": decodePayload(rpc.Result),
		"error":  nullIfEmpty(rpc.Error),
	})
}

// deviceEvents GET /api/ide/device/{token}/events — 增量拉事件。
func (s *Server) deviceEvents(w http.ResponseWriter, r *http.Request) error {
	dev, err := s.deviceByToken(r)
	if err != nil {
		return err
	}
	_ = s.db.TouchDeviceMobile(dev.ID)
	cursor := queryInt(r, "cursor", 0)

	rows, err := s.db.ListEventsAfter(dev.ID, int64(cursor), 300)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	newCursor := int64(cursor)
	for _, e := range rows {
		out = append(out, map[string]any{
			"id":      e.ID,
			"type":    e.Type,
			"payload": decodePayload(e.Payload),
		})
		if e.ID > newCursor {
			newCursor = e.ID
		}
	}
	return writeJSON(w, 200, map[string]any{
		"cursor": newCursor,
		"online": dev.Online(),
		"events": out,
	})
}

// deviceByToken 按二维码 token 取设备。
//
// token 必须是 64 位随机串，顺手挡掉扫描器乱试。
func (s *Server) deviceByToken(r *http.Request) (*store.Device, error) {
	token := strings.TrimSpace(paramOf(r, "token"))
	if len(token) != 64 {
		return nil, fail(404, "链接无效")
	}
	dev, err := s.db.FindDeviceByToken(token)
	if err != nil {
		return nil, fail(404, "链接已失效：请在电脑上换一张二维码")
	}
	return dev, nil
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
