package api

import "net/http"

// health GET /api/health — 存活探测。
//
// 桌面端启动时打这个：通了就说明服务端活着，直接进「已开启」状态，不必再猜。
// 返回里带 port 与 db，桌面端排查「连上了但数据不对」时一眼能看出连的是哪个实例。
func (s *Server) health(w http.ResponseWriter, r *http.Request) error {
	return writeJSON(w, 200, map[string]any{
		"ok":      true,
		"service": "qingniao-server",
		"version": s.version,
		"port":    s.cfg.Port,
		"db":      s.cfg.DBPath,
	})
}
