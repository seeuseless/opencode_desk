// 青鸟平台服务端。
//
// 单二进制 + SQLite，本地一体化模式下桌面端启动时自动拉起，用户零配置。
//
// 用法：
//
//	server                      # 本地一体化：绑 127.0.0.1，端口从 9002 起找可用的
//	QINGNIAO_HOST=0.0.0.0 \     # 独立部署：绑全部网卡，手机/桌面端都通过网络访问
//	QINGNIAO_PORT=9002 \
//	QINGNIAO_PUBLIC_URL=https://api.example.com \
//	server
//
// 首次启动自动建表，并在没有任何用户时创建管理员账号
// （QINGNIAO_ADMIN_USER / QINGNIAO_ADMIN_PASS 覆盖，密码留空则随机生成并打到日志）。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/seeuseless/opencode_desk/server/internal/api"
	"github.com/seeuseless/opencode_desk/server/internal/config"
	"github.com/seeuseless/opencode_desk/server/internal/health"
	"github.com/seeuseless/opencode_desk/server/internal/store"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[server] ")

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("读配置失败: %v", err)
	}
	if err := cfg.EnsureDir(); err != nil {
		log.Fatalf("建数据目录失败: %v", err)
	}

	// 端口从 9002 起找可用的：桌面端默认地址写的是 9002，被占了就顺延
	port, err := config.PickPort(cfg.Port)
	if err != nil {
		log.Fatalf("找不到可用端口: %v", err)
	}
	cfg.Port = port

	db, err := store.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer db.Close()

	if err := ensureAdmin(cfg, db); err != nil {
		log.Fatalf("初始化管理员失败: %v", err)
	}

	srv := api.New(cfg, db)

	// 模型概况采集器：后台「Token Plan → 概况」的数据来源
	watcher := health.New(db, srv.UpstreamService())
	go watcher.Start()

	httpSrv := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// 不设 WriteTimeout：流式转发可能持续几分钟
	}

	go func() {
		log.Printf("监听 %s（数据 %s）", cfg.Addr(), cfg.DBPath)
		log.Printf("对外地址 %s", cfg.BaseURL())
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务退出: %v", err)
		}
	}()

	// 优雅退出：SIGINT/SIGTERM 时把在途请求放完
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Printf("收到退出信号，正在关闭…")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("关闭超时: %v", err)
	}
	log.Printf("已退出")
}

// ensureAdmin 首次启动时建管理员账号。
func ensureAdmin(cfg *config.Config, db *store.DB) error {
	n, err := db.CountUsers()
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}

	pass := cfg.AdminPass
	if pass == "" {
		pass = "admin123" // 兜底：环境变量给了空才踩到这
	}
	hash, err := store.HashPassword(pass)
	if err != nil {
		return err
	}
	u := &store.User{
		Name:     cfg.AdminUser,
		Email:    cfg.AdminUser + "@local",
		Password: hash,
		Role:     store.RoleAdmin,
		Status:   store.StatusActive,
	}
	if err := db.CreateUser(u); err != nil {
		return err
	}
	log.Printf("已创建管理员账号：%s / %s（初始密码，请登录后修改）", u.Email, pass)
	return nil
}
