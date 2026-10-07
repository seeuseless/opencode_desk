package store

import (
	"path/filepath"
	"testing"
)

// newTestDB 开一个临时库。
func newTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("开库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// TestScanPaths 覆盖所有 scan* 路径。
//
// 为什么单测这个：SQLite 的可空列 Scan 进 string 会报
// "converting NULL to string is unsupported"，而这个错不是 sql.ErrNoRows，
// 上层会误判成「记录不存在」。2026-10-07 联调时连着踩了三次
// （ide_devices / ai_upstream_keys / ai_upstream_models），
// 所以把「新建后立刻读回来」固化成测试。
func TestScanPaths(t *testing.T) {
	db := newTestDB(t)

	u := &User{Name: "测试", Email: "t@t", Role: RoleMember, Status: StatusActive}
	if err := db.CreateUser(u); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FindUserByID(u.ID); err != nil {
		t.Fatalf("读用户失败: %v", err)
	}

	plain, tok, err := db.CreateToken(u.ID, "ide:test", "127.0.0.1", "ua", Now().AddDate(1, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if plain == "" || tok == nil {
		t.Fatal("签发令牌返回空")
	}
	if _, err := db.FindTokenByPlain(plain); err != nil {
		t.Fatalf("读令牌失败: %v", err)
	}

	// 设备：last_seen_at / mobile_seen_at 新建时可能是 NULL
	token, _ := NewDeviceToken()
	secret, _ := NewDeviceSecret()
	dev := &Device{UserID: u.ID, Name: "青鸟", Token: token, Secret: secret, Enabled: true}
	if err := db.CreateDevice(dev); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FindDeviceByID(dev.ID); err != nil {
		t.Fatalf("读设备失败: %v", err)
	}
	if _, err := db.FindDeviceByToken(token); err != nil {
		t.Fatalf("按 token 读设备失败: %v", err)
	}

	// 上游：models_synced_at 新建时是 NULL
	up := &Upstream{Name: "上游", BaseURL: "https://x.com", Enabled: true}
	if err := db.CreateUpstream(up); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FindUpstream(up.ID); err != nil {
		t.Fatalf("读上游失败: %v", err)
	}

	// Key：last_error / last_checked_at / last_used_at / latency_ms 全是 NULL
	k := &UpstreamKey{UpstreamID: up.ID, Name: "k1", APIKey: "sk-x", Enabled: true, Status: KeyStatusUnknown}
	if err := db.CreateKey(k); err != nil {
		t.Fatal(err)
	}
	keys, err := db.ListKeysByUpstream(up.ID)
	if err != nil {
		t.Fatalf("读 Key 列表失败: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("应有 1 把 Key，实际 %d", len(keys))
	}

	// 上游模型：model_id / last_error / last_checked_at / latency_ms 全是 NULL
	if err := db.UpsertUpstreamModel(up.ID, "gpt-test"); err != nil {
		t.Fatal(err)
	}
	ums, err := db.ListUpstreamModels(up.ID)
	if err != nil {
		t.Fatalf("读上游模型失败: %v", err)
	}
	if len(ums) != 1 {
		t.Fatalf("应有 1 个上游模型，实际 %d", len(ums))
	}

	// 模型库：discount 可空
	m := &Model{Name: "gpt-test", Ratio: 1, Enabled: true}
	if err := db.CreateModel(m); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FindModel(m.ID); err != nil {
		t.Fatalf("读模型失败: %v", err)
	}
	if _, err := db.FindModelByName("gpt-test"); err != nil {
		t.Fatalf("按名读模型失败: %v", err)
	}

	// 指令：params / result / error / picked_at / finished_at 可空
	rpc := &RPC{DeviceID: dev.ID, Method: "sessions.list", Status: RPCStatusPending}
	if err := db.CreateRPC(rpc); err != nil {
		t.Fatal(err)
	}
	if _, err := db.FindRPC(dev.ID, rpc.ID); err != nil {
		t.Fatalf("读指令失败: %v", err)
	}

	// 事件：payload 可空
	if err := db.AddEvents(dev.ID, []EventInput{{Type: "message.delta", Payload: ""}}); err != nil {
		t.Fatal(err)
	}
	evs, err := db.ListEventsAfter(dev.ID, 0, 10)
	if err != nil {
		t.Fatalf("读事件失败: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("应有 1 条事件，实际 %d", len(evs))
	}
}

// TestPullAndFinish 指令状态机。
func TestPullAndFinish(t *testing.T) {
	db := newTestDB(t)
	u := &User{Name: "t", Email: "t@t", Role: RoleMember, Status: StatusActive}
	_ = db.CreateUser(u)
	token, _ := NewDeviceToken()
	secret, _ := NewDeviceSecret()
	dev := &Device{UserID: u.ID, Name: "青鸟", Token: token, Secret: secret, Enabled: true, LastSeenAt: Now()}
	_ = db.CreateDevice(dev)

	for i := 0; i < 3; i++ {
		_ = db.CreateRPC(&RPC{DeviceID: dev.ID, Method: "sessions.list", Status: RPCStatusPending})
	}

	got, err := db.PullRPCs(dev.ID, PullLimit)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("应取到 3 条，实际 %d", len(got))
	}
	// 注意：返回的行是「更新前」查出来的，status 还是 pending。
	// 真正要验证的是库里已经改成 running，所以下面重新读一次。
	for _, r := range got {
		fresh, err := db.FindRPC(dev.ID, r.ID)
		if err != nil {
			t.Fatal(err)
		}
		if fresh.Status != RPCStatusRunning {
			t.Fatalf("取走后库里应为 running，实际 %s", fresh.Status)
		}
		if fresh.PickedAt.IsZero() {
			t.Fatal("picked_at 该记上")
		}
	}

	// 再拉一次应为空（都取走了）
	again, _ := db.PullRPCs(dev.ID, PullLimit)
	if len(again) != 0 {
		t.Fatalf("已取走的不该再返回，实际 %d", len(again))
	}

	if err := db.FinishRPC(dev.ID, got[0].ID, true, `{"ok":1}`, ""); err != nil {
		t.Fatal(err)
	}
	done, _ := db.FindRPC(dev.ID, got[0].ID)
	if done.Status != RPCStatusDone {
		t.Fatalf("回填后应为 done，实际 %s", done.Status)
	}
	if done.Result != `{"ok":1}` {
		t.Fatalf("结果没存对: %q", done.Result)
	}
}

// TestPointsCost 积分扣减口径。
func TestPointsCost(t *testing.T) {
	cases := []struct {
		ratio  float64
		tokens int64
		want   int64
	}{
		{1, 500, 1},    // 向上取整，1 token 也不白送
		{1, 1000, 1},   //
		{1, 1001, 2},   //
		{0, 5000, 0},   // 限免
		{2.5, 1000, 3}, // 2.5 倍
		{-1, 5000, 0},  // 负倍率当 0
		{1, 0, 0},      // 0 token
	}
	for _, c := range cases {
		if got := Cost(c.ratio, c.tokens); got != c.want {
			t.Errorf("Cost(%v, %d) = %d, want %d", c.ratio, c.tokens, got, c.want)
		}
	}
}

// TestConsumeUsage 扣分入账 + 余额不足不扣成负数。
func TestConsumeUsage(t *testing.T) {
	db := newTestDB(t)
	u := &User{Name: "t", Email: "t@t", Role: RoleMember, Status: StatusActive, Points: 3}
	_ = db.CreateUser(u)

	// 余额 3，该扣 5 → 只扣 3，不出负数
	usage, err := db.ConsumeUsage(u, 0, "m", 1, 4000, 1000, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if usage.Points != 3 {
		t.Errorf("应扣 3（余额上限），实际 %d", usage.Points)
	}
	if u.Points != 0 {
		t.Errorf("余额应归零，实际 %d", u.Points)
	}

	// 管理员不扣
	admin := &User{Name: "a", Email: "a@a", Role: RoleAdmin, Status: StatusActive, Points: 0}
	_ = db.CreateUser(admin)
	au, _ := db.ConsumeUsage(admin, 0, "m", 1, 100, 100, 200)
	if au.Points != 0 {
		t.Errorf("管理员不该扣分，实际 %d", au.Points)
	}

	// 流水应有两条（一条消耗）
	logs, _ := db.ListPointLogs(u.ID, "consume", 1, 20)
	if logs.Total != 1 {
		t.Errorf("应有 1 条消耗流水，实际 %d", logs.Total)
	}
}

// TestEffectiveRatio 实际计费倍率口径。
func TestEffectiveRatio(t *testing.T) {
	m := &Model{Ratio: 2}
	if got := m.EffectiveRatio(); got != 2 {
		t.Errorf("无折扣应为 2，实际 %v", got)
	}
	m.Discount.Float64, m.Discount.Valid = 0.5, true
	if got := m.EffectiveRatio(); got != 1 {
		t.Errorf("打折后应为 1，实际 %v", got)
	}
	m.Free = true
	if got := m.EffectiveRatio(); got != 0 {
		t.Errorf("限免应为 0，实际 %v", got)
	}
	if m.DiscountLabel() != "0.5x" {
		t.Errorf("折扣标签应为 0.5x，实际 %q", m.DiscountLabel())
	}
}

// TestUsageSummaryEmpty 空数据时汇总不能炸。
//
// 为什么单测这个：SUM() 在无数据行时返回 NULL，Scan 进 int64 会报
// "converting NULL to int64 is unsupported"。2026-10-07 联调时新注册会员
// 一进「使用量」页就 500，根因就是漏了 COALESCE。
func TestUsageSummaryEmpty(t *testing.T) {
	db := newTestDB(t)
	u := &User{Name: "空", Email: "e@e", Role: RoleMember, Status: StatusActive}
	_ = db.CreateUser(u)

	from, to := UsageRange("", "")
	sum, err := db.UsageSummaryOf(u.ID, false, from, to)
	if err != nil {
		t.Fatalf("空数据汇总应成功，实际 %v", err)
	}
	if sum.Range.Calls != 0 || sum.Range.Tokens != 0 || sum.Range.Points != 0 {
		t.Errorf("空数据应全为 0，实际 %+v", sum.Range)
	}
	if len(sum.Series.Dates) == 0 {
		t.Error("series.dates 该有值（缺数据的天补 0，折线才连续）")
	}
	if len(sum.Series.Models) != 0 {
		t.Error("空数据不该有模型线")
	}

	// 后台总览同样不能炸
	o, err := db.UsageOverview(from, to)
	if err != nil {
		t.Fatalf("后台总览应成功，实际 %v", err)
	}
	if o.Calls != 0 {
		t.Errorf("空数据 calls 应为 0，实际 %d", o.Calls)
	}

	// 模型概况同样不能炸
	rows, err := db.HealthOverview(from, to)
	if err != nil {
		t.Fatalf("模型概况应成功，实际 %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("空数据不该有概况行，实际 %d", len(rows))
	}

	// 分页信封
	logs, err := db.ListPointLogs(u.ID, "", 1, 20)
	if err != nil {
		t.Fatalf("空流水应成功，实际 %v", err)
	}
	if logs.Total != 0 || logs.Pages != 0 {
		t.Errorf("空流水 total/pages 应为 0，实际 %d/%d", logs.Total, logs.Pages)
	}
}

// TestPasswordHash 密码哈希与校验。
func TestPasswordHash(t *testing.T) {
	h, err := HashPassword("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword("s3cret", h) {
		t.Error("同一密码应通过")
	}
	if CheckPassword("wrong", h) {
		t.Error("错误密码不该通过")
	}
	if CheckPassword("s3cret", "garbage") {
		t.Error("畸形哈希不该通过")
	}
	if CheckPassword("s3cret", "") {
		t.Error("空哈希不该通过")
	}
}
