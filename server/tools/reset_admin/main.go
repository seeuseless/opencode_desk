// 一次性工具：把 admin@local 的密码重置为给定值（默认 admin123）。
// 复用项目自己的 store 包，保证哈希格式与登录校验同源。
//
// 用法：
//
//	go run ./tools/reset_admin            # 重置为 admin123
//	go run ./tools/reset_admin newpass    # 重置为 newpass
package main

import (
	"fmt"
	"os"

	"github.com/seeuseless/opencode_desk/server/internal/config"
	"github.com/seeuseless/opencode_desk/server/internal/store"
)

func main() {
	pw := "admin123"
	if len(os.Args) > 1 {
		pw = os.Args[1]
	}

	cfg, err := config.Load()
	if err != nil {
		fatalf("加载配置失败: %v", err)
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		fatalf("打开数据库失败（%s）: %v", cfg.DBPath, err)
	}
	defer db.Close()

	email := cfg.AdminUser + "@local" // 默认 admin@local
	u, err := db.FindUserByEmail(email)
	if err != nil {
		// 查不到就看看库里到底有谁，方便人工判断
		var rows []string
		_ = listAll(db, &rows)
		fatalf("未找到 %s 账号。库内用户：\n%s", email, joinLines(rows))
	}

	hash, err := store.HashPassword(pw)
	if err != nil {
		fatalf("生成密码哈希失败: %v", err)
	}

	res, err := db.Exec(
		`UPDATE users SET password = ? WHERE id = ?`,
		hash, u.ID,
	)
	if err != nil {
		fatalf("更新密码失败: %v", err)
	}
	n, _ := res.RowsAffected()
	fmt.Printf("已将 %s（user id=%d）密码重置为 %q，影响 %d 行。\n", email, u.ID, pw, n)
}

func listAll(db *store.DB, rows *[]string) error {
	var ids, emails, roles []int64
	q := `SELECT id, email, role FROM users ORDER BY id`
	// 简单查，复用 store.DB 暴露的 *sql.DB
	ids = nil
	type t struct {
		ids    []int64
		emails []string
		roles  []string
	}
	var got t
	if rerr := (func() error {
		rows2, err := db.Query(q)
		if err != nil {
			return err
		}
		defer rows2.Close()
		for rows2.Next() {
			var id int64
			var em, ro string
			if err := rows2.Scan(&id, &em, &ro); err != nil {
				return err
			}
			got.ids = append(got.ids, id)
			got.emails = append(got.emails, em)
			got.roles = append(got.roles, ro)
		}
		*rows = make([]string, len(got.ids))
		for i := range got.ids {
			*rows = append(*rows, fmt.Sprintf("  id=%d  %s  [%s]", got.ids[i], got.emails[i], got.roles[i]))
		}
		return nil
	})(); rerr != nil {
		return rerr
	}
	_ = ids
	_ = emails
	_ = roles
	return nil
}

func joinLines(s []string) string {
	out := ""
	for i, x := range s {
		if i > 0 {
			out += "\n"
		}
		out += x
	}
	if out == "" {
		out = "  （空库，尚无用户）"
	}
	return out
}

func fatalf(format string, a ...any) {
	fmt.Printf(format+"\n", a...)
	os.Exit(1)
}
