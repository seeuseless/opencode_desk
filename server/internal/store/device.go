package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// 设备在线判定窗口（秒）。桌面端每 1.2 秒认领一次，90 秒足够宽容。
const DeviceOnlineWindowSec = 90

// 手机在线判定窗口（秒）。手机每 1.2 秒拉一次事件，20 秒内来过就算。
const MobileOnlineWindowSec = 20

// 一次最多取几条指令。
const PullLimit = 5

// 事件保留时长（分钟）。
const EventTTLMinutes = 5

// 指令超时（秒）：电脑没在这时间内执行完就判失败。
const RPCTimeoutSec = 120

// 取走但没回结果的重派阈值（秒）。
const RPCRequeueSec = 90

// Device 一台青鸟桌面端。
type Device struct {
	ID           int64
	UserID       int64
	Name         string
	Platform     string
	Token        string
	Secret       string
	LanURL       string
	Enabled      bool
	LastSeenAt   time.Time
	MobileSeenAt time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Online 桌面端通道在不在跑。
func (d *Device) Online() bool {
	return d.Enabled && !d.LastSeenAt.IsZero() &&
		d.LastSeenAt.After(Now().Add(-DeviceOnlineWindowSec*time.Second))
}

// MobileOnline 有没有手机正连着（与 Online 是两件事）。
func (d *Device) MobileOnline() bool {
	return !d.MobileSeenAt.IsZero() &&
		d.MobileSeenAt.After(Now().Add(-MobileOnlineWindowSec*time.Second))
}

// Path 二维码里的页面路径。
func (d *Device) Path() string { return "/ide/device/" + d.Token }

// RPC 一条手机下发、桌面端执行的指令。
type RPC struct {
	ID         int64
	DeviceID   int64
	Method     string
	Params     string
	Status     string
	Result     string
	Error      string
	PickedAt   time.Time
	FinishedAt time.Time
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// RPC 状态机。
const (
	RPCStatusPending = "pending"
	RPCStatusRunning = "running"
	RPCStatusDone    = "done"
	RPCStatusFailed  = "failed"
)

// Event 一条桌面端推上来的内核事件。
type Event struct {
	ID        int64
	DeviceID  int64
	Type      string
	Payload   string
	CreatedAt time.Time
}

const deviceCols = `id, user_id, name, platform, token, secret, lan_url, enabled, last_seen_at, mobile_seen_at, created_at, updated_at`

func scanDevice(row interface{ Scan(...any) error }) (*Device, error) {
	var d Device
	var lastSeen, mobileSeen, createdAt, updatedAt sql.NullString
	if err := row.Scan(&d.ID, &d.UserID, &d.Name, &d.Platform, &d.Token, &d.Secret, &d.LanURL,
		&d.Enabled, &lastSeen, &mobileSeen, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	d.LastSeenAt = ParseTime(lastSeen.String)
	d.MobileSeenAt = ParseTime(mobileSeen.String)
	d.CreatedAt = ParseTime(createdAt.String)
	d.UpdatedAt = ParseTime(updatedAt.String)
	return &d, nil
}

func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.Format(time.RFC3339Nano)
}

// FindDeviceByID 按 id 取设备。
func (d *DB) FindDeviceByID(id int64) (*Device, error) {
	row := d.QueryRow(`SELECT `+deviceCols+` FROM ide_devices WHERE id = ?`, id)
	dev, err := scanDevice(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return dev, err
}

// FindDeviceByToken 按二维码 token 取设备（只取启用的）。
func (d *DB) FindDeviceByToken(token string) (*Device, error) {
	row := d.QueryRow(`SELECT `+deviceCols+` FROM ide_devices WHERE token = ? AND enabled = 1`, token)
	dev, err := scanDevice(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return dev, err
}

// FindDeviceByName 同一账号下同名设备（注册时复用）。
func (d *DB) FindDeviceByName(userID int64, name string) (*Device, error) {
	row := d.QueryRow(`SELECT `+deviceCols+` FROM ide_devices WHERE user_id = ? AND name = ?`, userID, name)
	dev, err := scanDevice(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return dev, err
}

// ListDevicesByUser 我账号下的所有桌面端，按 id 倒序。
func (d *DB) ListDevicesByUser(userID int64) ([]*Device, error) {
	rows, err := d.Query(`SELECT `+deviceCols+` FROM ide_devices WHERE user_id = ? ORDER BY id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Device{}
	for rows.Next() {
		dev, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, dev)
	}
	return out, rows.Err()
}

// CreateDevice 注册一台新设备。
func (d *DB) CreateDevice(dev *Device) error {
	now := Now()
	res, err := d.Exec(
		`INSERT INTO ide_devices (user_id, name, platform, token, secret, lan_url, enabled, last_seen_at, mobile_seen_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		dev.UserID, dev.Name, dev.Platform, dev.Token, dev.Secret, dev.LanURL, boolInt(dev.Enabled),
		nullTime(dev.LastSeenAt), nullTime(dev.MobileSeenAt),
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("注册设备失败: %w", err)
	}
	dev.ID, _ = res.LastInsertId()
	dev.CreatedAt, dev.UpdatedAt = now, now
	return nil
}

// SaveDevice 整行更新（注册复用 / 换码 / 点亮在线都走它）。
func (d *DB) SaveDevice(dev *Device) error {
	_, err := d.Exec(
		`UPDATE ide_devices SET name = ?, platform = ?, token = ?, secret = ?, lan_url = ?, enabled = ?,
		 last_seen_at = ?, mobile_seen_at = ?, updated_at = ? WHERE id = ?`,
		dev.Name, dev.Platform, dev.Token, dev.Secret, dev.LanURL, boolInt(dev.Enabled),
		nullTime(dev.LastSeenAt), nullTime(dev.MobileSeenAt),
		Now().Format(time.RFC3339Nano), dev.ID)
	return err
}

// DeleteDevice 吊销一台桌面端。
func (d *DB) DeleteDevice(id int64) error {
	_, err := d.Exec(`DELETE FROM ide_devices WHERE id = ?`, id)
	return err
}

// TouchDeviceSeen 只更新 last_seen_at（认领循环每轮都调，别整行写）。
func (d *DB) TouchDeviceSeen(id int64) error {
	_, err := d.Exec(`UPDATE ide_devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`,
		Now().Format(time.RFC3339Nano), Now().Format(time.RFC3339Nano), id)
	return err
}

// TouchDeviceMobile 记「有手机在看」。5 秒内记过就跳过（判定窗口 20 秒，跳过也一直落在窗口内）。
func (d *DB) TouchDeviceMobile(id int64) error {
	now := Now()
	res, err := d.Exec(
		`UPDATE ide_devices SET mobile_seen_at = ?, updated_at = ?
		 WHERE id = ? AND (mobile_seen_at IS NULL OR mobile_seen_at < ?)`,
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), id,
		now.Add(-5*time.Second).Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	_, _ = res.RowsAffected()
	return nil
}

// NewDeviceToken 生成 64 位随机设备 token（二维码里那串）。
func NewDeviceToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// NewDeviceSecret 生成 64 位随机 secret（只发给桌面端自己）。
func NewDeviceSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// RequeueStaleRPCs 把「取走但超时没回结果」的指令放回 pending。
// 进程被杀 / 内核重启时上一轮取走的指令会永远挂在 running，手机一直转圈。
func (d *DB) RequeueStaleRPCs(deviceID int64) error {
	_, err := d.Exec(
		`UPDATE ide_rpcs SET status = ?, picked_at = NULL, updated_at = ?
		 WHERE device_id = ? AND status = ? AND picked_at < ?`,
		RPCStatusPending, Now().Format(time.RFC3339Nano), deviceID, RPCStatusRunning,
		Now().Add(-RPCRequeueSec*time.Second).Format(time.RFC3339Nano))
	return err
}

// PullRPCs 取待执行指令（按 id 升序，最多 limit 条）并置为 running。
func (d *DB) PullRPCs(deviceID int64, limit int) ([]*RPC, error) {
	tx, err := d.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.Query(
		`SELECT id, device_id, method, params, status, result, error, picked_at, finished_at, created_at, updated_at
		 FROM ide_rpcs WHERE device_id = ? AND status = ? ORDER BY id ASC LIMIT ?`,
		deviceID, RPCStatusPending, limit)
	if err != nil {
		return nil, err
	}
	out := []*RPC{}
	ids := []int64{}
	for rows.Next() {
		r, err := scanRPC(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, r)
		ids = append(ids, r.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(ids) > 0 {
		now := Now().Format(time.RFC3339Nano)
		q := `UPDATE ide_rpcs SET status = ?, picked_at = ?, updated_at = ? WHERE id IN (` +
			placeholders(len(ids)) + `)`
		args := []any{RPCStatusRunning, now, now}
		for _, id := range ids {
			args = append(args, id)
		}
		if _, err := tx.Exec(q, args...); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit()
}

// FinishRPC 回填指令结果。
func (d *DB) FinishRPC(deviceID, rpcID int64, ok bool, result, errMsg string) error {
	status := RPCStatusDone
	if !ok {
		status = RPCStatusFailed
	}
	now := Now().Format(time.RFC3339Nano)
	_, err := d.Exec(
		`UPDATE ide_rpcs SET status = ?, result = ?, error = ?, finished_at = ?, updated_at = ?
		 WHERE device_id = ? AND id = ?`,
		status, nullStr(result), nullStr(errMsg), now, now, deviceID, rpcID)
	return err
}

// FindRPC 取一条指令（校验归属）。
func (d *DB) FindRPC(deviceID, rpcID int64) (*RPC, error) {
	row := d.QueryRow(
		`SELECT id, device_id, method, params, status, result, error, picked_at, finished_at, created_at, updated_at
		 FROM ide_rpcs WHERE device_id = ? AND id = ?`, deviceID, rpcID)
	r, err := scanRPC(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

// FailTimedOutRPCs 把超时的 pending/running 指令就地对账成 failed。
func (d *DB) FailTimedOutRPCs(deviceID int64) error {
	now := Now()
	_, err := d.Exec(
		`UPDATE ide_rpcs SET status = ?, error = ?, finished_at = ?, updated_at = ?
		 WHERE device_id = ? AND status IN (?, ?) AND created_at < ?`,
		RPCStatusFailed, "电脑长时间没有响应", now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano),
		deviceID, RPCStatusPending, RPCStatusRunning,
		now.Add(-RPCTimeoutSec*time.Second).Format(time.RFC3339Nano))
	return err
}

// CreateRPC 手机下发一条指令。
func (d *DB) CreateRPC(r *RPC) error {
	now := Now()
	res, err := d.Exec(
		`INSERT INTO ide_rpcs (device_id, method, params, status, result, error, picked_at, finished_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.DeviceID, r.Method, nullStr(r.Params), r.Status, nullStr(r.Result), nullStr(r.Error),
		nullTime(r.PickedAt), nullTime(r.FinishedAt),
		now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("下发指令失败: %w", err)
	}
	r.ID, _ = res.LastInsertId()
	r.CreatedAt, r.UpdatedAt = now, now
	return nil
}

func scanRPC(row interface{ Scan(...any) error }) (*RPC, error) {
	var r RPC
	var params, result, errMsg, pickedAt, finishedAt, createdAt, updatedAt sql.NullString
	if err := row.Scan(&r.ID, &r.DeviceID, &r.Method, &params, &r.Status, &result, &errMsg,
		&pickedAt, &finishedAt, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	r.Params = params.String
	r.Result = result.String
	r.Error = errMsg.String
	r.PickedAt = ParseTime(pickedAt.String)
	r.FinishedAt = ParseTime(finishedAt.String)
	r.CreatedAt = ParseTime(createdAt.String)
	r.UpdatedAt = ParseTime(updatedAt.String)
	return &r, nil
}

// AddEvents 批量上报内核事件。
func (d *DB) AddEvents(deviceID int64, events []EventInput) error {
	if len(events) == 0 {
		return nil
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	now := Now().Format(time.RFC3339Nano)
	for _, e := range events {
		if _, err := tx.Exec(
			`INSERT INTO ide_events (device_id, type, payload, created_at) VALUES (?, ?, ?, ?)`,
			deviceID, e.Type, nullStr(e.Payload), now); err != nil {
			return err
		}
	}
	// 事件只是给手机追进度用的，留最近几分钟即可
	if _, err := tx.Exec(
		`DELETE FROM ide_events WHERE device_id = ? AND created_at < ?`,
		deviceID, Now().Add(-EventTTLMinutes*time.Minute).Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return tx.Commit()
}

// EventInput 一条待入库事件。
type EventInput struct {
	Type    string
	Payload string
}

// ListEventsAfter 增量拉事件（cursor 之后，最多 limit 条，升序）。
func (d *DB) ListEventsAfter(deviceID, cursor int64, limit int) ([]*Event, error) {
	rows, err := d.Query(
		`SELECT id, device_id, type, payload, created_at FROM ide_events
		 WHERE device_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
		deviceID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Event{}
	for rows.Next() {
		var e Event
		var payload, createdAt sql.NullString
		if err := rows.Scan(&e.ID, &e.DeviceID, &e.Type, &payload, &createdAt); err != nil {
			return nil, err
		}
		e.Payload = payload.String
		e.CreatedAt = ParseTime(createdAt.String)
		out = append(out, &e)
	}
	return out, rows.Err()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
