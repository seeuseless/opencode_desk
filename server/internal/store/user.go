package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

// ErrNotFound 记录不存在。
var ErrNotFound = errors.New("记录不存在")

// RoleAdmin / RoleMember 用户角色。
const (
	RoleAdmin  = "admin"
	RoleMember = "member"
)

// StatusActive / StatusDisabled 账号状态。
const (
	StatusActive   = "active"
	StatusDisabled = "disabled"
)

// User 一行用户。
type User struct {
	ID        int64
	Name      string
	Email     string
	Password  string
	Role      string
	Points    int64
	Status    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// IsAdmin 管理员不参与积分计费。
func (u *User) IsAdmin() bool { return u.Role == RoleAdmin }

// Active 账号可用。
func (u *User) Active() bool { return u.Status == StatusActive }

// Token 一个个人访问令牌。
type Token struct {
	ID        int64
	UserID    int64
	Name      string
	TokenHash string
	IP        string
	UA        string
	ExpiresAt time.Time
	CreatedAt time.Time
}

// LoginLog 一条登录记录。
type LoginLog struct {
	ID      int64
	UserID  int64
	IP      string
	Device  string
	UA      string
	LoginAt time.Time
}

const userCols = `id, name, email, password, role, points, status, created_at, updated_at`

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	var createdAt, updatedAt string
	if err := row.Scan(&u.ID, &u.Name, &u.Email, &u.Password, &u.Role, &u.Points, &u.Status, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	u.CreatedAt = ParseTime(createdAt)
	u.UpdatedAt = ParseTime(updatedAt)
	return &u, nil
}

// FindUserByID 按 id 取用户。
func (d *DB) FindUserByID(id int64) (*User, error) {
	row := d.QueryRow(`SELECT `+userCols+` FROM users WHERE id = ?`, id)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// FindUserByEmail 按邮箱取用户。
func (d *DB) FindUserByEmail(email string) (*User, error) {
	row := d.QueryRow(`SELECT `+userCols+` FROM users WHERE email = ?`, email)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// CountUsers 用户总数（判断是否需要初始化管理员）。
func (d *DB) CountUsers() (int, error) {
	var n int
	err := d.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// CreateUser 建用户。
func (d *DB) CreateUser(u *User) error {
	now := Now()
	res, err := d.Exec(
		`INSERT INTO users (name, email, password, role, points, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		u.Name, u.Email, u.Password, u.Role, u.Points, u.Status,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return fmt.Errorf("建用户失败: %w", err)
	}
	u.ID, _ = res.LastInsertId()
	u.CreatedAt, u.UpdatedAt = now, now
	return nil
}

// UpdateUserPoints 改积分余额（直接覆写，调用方负责算好）。
func (d *DB) UpdateUserPoints(id, points int64) error {
	_, err := d.Exec(`UPDATE users SET points = ?, updated_at = ? WHERE id = ?`,
		points, Now().Format(time.RFC3339Nano), id)
	return err
}

// UpdateUserName 改账号名。
func (d *DB) UpdateUserName(id int64, name string) error {
	_, err := d.Exec(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`,
		name, Now().Format(time.RFC3339Nano), id)
	return err
}

// UpdateUserPassword 改密码（调用方负责传哈希值）。
func (d *DB) UpdateUserPassword(id int64, hash string) error {
	_, err := d.Exec(`UPDATE users SET password = ?, updated_at = ? WHERE id = ?`,
		hash, Now().Format(time.RFC3339Nano), id)
	return err
}

// ListUsers 会员列表（分页 + 关键字）。
func (d *DB) ListUsers(keyword string, page, per int) ([]*User, int, error) {
	where := "1 = 1"
	args := []any{}
	if keyword != "" {
		where = `(name LIKE ? OR email LIKE ?)`
		like := "%" + keyword + "%"
		args = append(args, like, like)
	}
	var total int
	if err := d.QueryRow(`SELECT COUNT(*) FROM users WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, per, (page-1)*per)
	rows, err := d.Query(`SELECT `+userCols+` FROM users WHERE `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []*User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, u)
	}
	return out, total, rows.Err()
}

// CreateToken 建令牌，返回明文（只此一次）。
//
// 明文格式 {id}|{random}，与 Sanctum 的 plainTextToken 形状一致；
// 库里只存 SHA-256，泄露库也还原不出可用令牌。
func (d *DB) CreateToken(userID int64, name, ip, ua string, expiresAt time.Time) (plain string, tok *Token, err error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", nil, err
	}
	now := Now()
	res, err := d.Exec(
		`INSERT INTO personal_access_tokens (user_id, name, token_hash, ip_address, user_agent, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		userID, name, "", ip, ua, FormatISO(expiresAt), now.Format(time.RFC3339Nano),
	)
	if err != nil {
		return "", nil, fmt.Errorf("建令牌失败: %w", err)
	}
	id, _ := res.LastInsertId()
	plain = fmt.Sprintf("%d|%s", id, hex.EncodeToString(secret))
	hash := HashToken(plain)
	if _, err := d.Exec(`UPDATE personal_access_tokens SET token_hash = ? WHERE id = ?`, hash, id); err != nil {
		return "", nil, err
	}
	return plain, &Token{
		ID: id, UserID: userID, Name: name, TokenHash: hash,
		IP: ip, UA: ua, ExpiresAt: expiresAt, CreatedAt: now,
	}, nil
}

// FindTokenByPlain 用明文令牌找记录；过期返回 ErrNotFound。
func (d *DB) FindTokenByPlain(plain string) (*Token, error) {
	row := d.QueryRow(
		`SELECT id, user_id, name, token_hash, ip_address, user_agent, expires_at, created_at
		 FROM personal_access_tokens WHERE token_hash = ?`, HashToken(plain))
	var t Token
	var exp, createdAt sql.NullString
	if err := row.Scan(&t.ID, &t.UserID, &t.Name, &t.TokenHash, &t.IP, &t.UA, &exp, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	t.ExpiresAt = ParseTime(exp.String)
	t.CreatedAt = ParseTime(createdAt.String)
	if !t.ExpiresAt.IsZero() && t.ExpiresAt.Before(Now()) {
		return nil, ErrNotFound
	}
	return &t, nil
}

// DeleteToken 吊销一个令牌。
func (d *DB) DeleteToken(id int64) error {
	_, err := d.Exec(`DELETE FROM personal_access_tokens WHERE id = ?`, id)
	return err
}

// AddLoginLog 记一条登录日志。
func (d *DB) AddLoginLog(l *LoginLog) error {
	now := Now()
	_, err := d.Exec(
		`INSERT INTO login_logs (user_id, ip_address, device, user_agent, login_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		l.UserID, l.IP, l.Device, l.UA, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return err
}
