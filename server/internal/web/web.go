// Package web 提供前端静态资源。
//
// 两种来源：
//
//	· go:embed 内嵌的那份（web/dist，构建时由 Vite 产出）——发布形态，单二进制拷到哪都能跑
//	· QINGNIAO_WEB_DIR 指向的目录——开发时改完前端不想重新 go build 就用它
//
// 路由口径（与 Laravel 版的 routes/web.php 一致）：
//
//	· /            → index.html（后台 SPA 入口）
//	· /ide/login   → index.html（桌面端登录页，前端路由）
//	· /ide/device/{token} → index.html（手机端页面，前端路由）
//	· 其余非 api/up/storage 路径一律回 index.html，交给 React Router
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

// Handler 返回静态资源 handler。dir 为空用内嵌资源。
func Handler(dir string) (http.Handler, error) {
	if dir != "" {
		if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
			return nil, err
		}
		return spaHandler(http.Dir(dir)), nil
	}
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil, err
	}
	return spaHandler(http.FS(sub)), nil
}

// spaHandler SPA 兜底：找不到的文件回 index.html，让前端路由自己解析。
func spaHandler(fs http.FileSystem) http.Handler {
	fileServer := http.StripPrefix("/", http.FileServer(fs))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		// 有扩展名的按静态资源处理（.js/.css/.png…），找不到就 404
		// 不带扩展名的一律回 index.html（前端路由）
		if f, err := fs.Open(p); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		if strings.Contains(filepath.Base(p), ".") {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, fs)
	})
}

func serveIndex(w http.ResponseWriter, fs http.FileSystem) {
	f, err := fs.Open("index.html")
	if err != nil {
		http.Error(w, "前端资源未构建：请先在 server/web 下执行 npm run build", 500)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	buf := make([]byte, 32*1024)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			_, _ = w.Write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}
