// Package config 读取服务端运行配置。
//
// 本地一体化模式（桌面端随包分发）下所有项都有合理默认值，用户零配置：
//
//	· 端口从 9002 起找可用的（与桌面端 DEFAULT_PLATFORM_URL 对齐）
//	· SQLite 单文件落在 ~/.qingniaoai/server.db，与内核数据隔离
//	· 管理员账号首次启动时自动创建（admin / 随机密码打到日志）
//
// 独立部署模式通过环境变量覆盖，见 FromEnv。
package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
)

// Config 服务端运行配置。
type Config struct {
	// Host 监听地址。本地一体化模式必须绑 127.0.0.1（手机通过桌面端中转，不直连）；
	// 独立部署才绑 0.0.0.0。
	Host string
	// Port 监听端口。
	Port int
	// DataDir 数据目录，SQLite 与日志都在这里。
	DataDir string
	// DBPath SQLite 文件路径。
	DBPath string
	// PublicBaseURL 对外基地址（拼二维码 URL、gateway 字段用）。
	// 空则按请求的 Host 头推断。
	PublicBaseURL string
	// AdminUser 首次启动自动创建的管理员账号名。
	AdminUser string
	// AdminPass 管理员初始密码。空则随机生成并打到日志。
	AdminPass string
	// UpstreamProxy 访问国外上游用的本机代理，如 http://127.0.0.1:7890。
	UpstreamProxy string
	// UpstreamConnectTimeoutSec 上游连接超时（秒）。
	UpstreamConnectTimeoutSec int
	// UpstreamTimeoutSec 上游读超时（秒）。
	UpstreamTimeoutSec int
	// UpstreamVerifySSL 是否校验上游证书。
	UpstreamVerifySSL bool
	// WebDir 前端静态资源目录。空则用 go:embed 内嵌的那份。
	WebDir string
}

// DefaultPort 桌面端默认平台地址用的端口（electron/main/types.ts 的 DEFAULT_PLATFORM_URL）。
const DefaultPort = 9002

// DefaultDataDirName 桌面端数据目录名（与内核共处 ~/.qingniaoai）。
const DefaultDataDirName = ".qingniaoai"

// Load 取配置：环境变量优先，其余给默认值。
func Load() (*Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("取用户目录失败: %w", err)
	}
	dataDir := envOr("QINGNIAO_DATA_DIR", filepath.Join(home, DefaultDataDirName))

	c := &Config{
		Host:          envOr("QINGNIAO_HOST", "127.0.0.1"),
		Port:          DefaultPort,
		DataDir:       dataDir,
		DBPath:        envOr("QINGNIAO_DB", filepath.Join(dataDir, "server.db")),
		PublicBaseURL: os.Getenv("QINGNIAO_PUBLIC_URL"),
		AdminUser:     envOr("QINGNIAO_ADMIN_USER", "admin"),
		// 默认管理员密码固定为 admin123（本地一体化模式下平台跟着桌面端走，这是给本机用户的初始凭据）。
		// 想换用 QINGNIAO_ADMIN_PASS 覆盖。
		AdminPass:                 envOr("QINGNIAO_ADMIN_PASS", "admin123"),
		UpstreamProxy:             os.Getenv("QINGNIAO_UPSTREAM_PROXY"),
		UpstreamConnectTimeoutSec: 20,
		UpstreamTimeoutSec:        60,
		UpstreamVerifySSL:         true,
		WebDir:                    os.Getenv("QINGNIAO_WEB_DIR"),
	}

	if v := os.Getenv("QINGNIAO_PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			return nil, fmt.Errorf("QINGNIAO_PORT 不是合法端口: %q", v)
		}
		c.Port = p
	}
	if v := os.Getenv("QINGNIAO_UPSTREAM_CONNECT_TIMEOUT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.UpstreamConnectTimeoutSec = n
		}
	}
	if v := os.Getenv("QINGNIAO_UPSTREAM_TIMEOUT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			c.UpstreamTimeoutSec = n
		}
	}
	if v := os.Getenv("QINGNIAO_UPSTREAM_VERIFY_SSL"); v == "false" || v == "0" {
		c.UpstreamVerifySSL = false
	}

	return c, nil
}

// PickPort 从 prefer 起找一个能绑上的端口。
// 桌面端拉起服务时传它探测到的端口；独立部署时 prefer 就是配置里的端口。
func PickPort(prefer int) (int, error) {
	if portFree(prefer) {
		return prefer, nil
	}
	for p := prefer + 1; p < prefer+100; p++ {
		if portFree(p) {
			return p, nil
		}
	}
	return 0, fmt.Errorf("端口 %d 起连续 100 个都被占用", prefer)
}

func portFree(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

// EnsureDir 保证数据目录存在。
func (c *Config) EnsureDir() error {
	if err := os.MkdirAll(filepath.Dir(c.DBPath), 0o755); err != nil {
		return fmt.Errorf("建数据目录失败: %w", err)
	}
	return nil
}

// Addr 监听地址。
func (c *Config) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

// BaseURL 对外基地址。没配 PublicBaseURL 时按监听地址推（本地一体化模式够用）。
func (c *Config) BaseURL() string {
	if c.PublicBaseURL != "" {
		return trimSlash(c.PublicBaseURL)
	}
	host := c.Host
	if host == "0.0.0.0" || host == "" {
		host = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%d", host, c.Port)
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
