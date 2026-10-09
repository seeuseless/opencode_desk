package api

import (
	"sync"
	"time"
)

// eventWaitMax 单次长轮询最多挂多久。
//
// 必须有上界：手机断网时请求不会立刻失败（TCP 半开），只靠「客户端断开」
// 唤醒的话这条 goroutine 会一直挂着。25 秒足够长（跨过绝大多数网络抖动），
// 又短到能被中间设备的空闲超时自然回收。
const eventWaitMax = 25 * time.Second

// eventNotifier 按设备唤醒「正在等事件」的手机。
//
// 为什么需要它：/ide/device/{token}/events 原本是「拉完就睡 1.2 秒再拉」，
// 于是电脑上做的任何改动，最坏要等一整个轮询周期才出现在手机上——
// 用户看到的就是「任务列表/内容要过一会儿才对」。把接口改成短长轮询
// （挂着等，有事件立刻返回、超时才返回空），这条 1.2 秒的尾巴就没了。
//
// 为什么不用 WebSocket / SSE：这个通道本来就是「电脑 1.2 秒一轮领指令」的
// 拉模型，手机侧再挂一条长连接并不改变信息流形状；长轮询在现有 HTTP 契约上
// 就能实现，桌面端与服务端都不用引入新的传输层。
type eventNotifier struct {
	mu   sync.Mutex
	next int64
	// 每个设备一条通道；有等待者时才有值（没人等就不建，省内存）
	waiters map[int64]chan struct{}
}

func newEventNotifier() *eventNotifier {
	return &eventNotifier{waiters: map[int64]chan struct{}{}}
}

// deviceWaiter 某个设备上的一次「等事件」。
type deviceWaiter struct {
	n  *eventNotifier
	id int64
	ch chan struct{}
}

func (e *eventNotifier) forDevice(id int64) *deviceWaiter {
	return &deviceWaiter{n: e, id: id, ch: make(chan struct{}, 1)}
}

// wait 等到「有新事件」、客户端断开，或超过 eventWaitMax。
//
// 用带缓冲的 channel + 非阻塞发送：唤醒是「惊一下」而不是「喊话」，
// 惊过了就丢掉——醒来的人第一件事是去数据库重读，早到的通知没有意义。
// 三个出口缺一不可：只等事件会让事件迟迟不来时占满连接；
// 只等超时会让断网的手机把位置一直占着。
func (w *deviceWaiter) wait(done <-chan struct{}) {
	w.n.mu.Lock()
	w.n.waiters[w.id] = w.ch
	w.n.mu.Unlock()

	timer := time.NewTimer(eventWaitMax)
	defer timer.Stop()

	select {
	case <-w.ch:
	case <-done:
	case <-timer.C:
	}

	w.n.mu.Lock()
	// 只有还挂着自己那条才摘掉：期间可能已经被别人（同一设备的另一个标签页）唤醒重挂过
	if w.n.waiters[w.id] == w.ch {
		delete(w.n.waiters, w.id)
	}
	w.n.mu.Unlock()
}

// release 提前摘掉通道，避免请求已被取消却还占着位置。
func (w *deviceWaiter) release() {
	w.n.mu.Lock()
	if w.n.waiters[w.id] == w.ch {
		delete(w.n.waiters, w.id)
	}
	w.n.mu.Unlock()
}

// wake 叫醒该设备上的等待者（桌面端刚推完事件时调）。
func (e *eventNotifier) wake(id int64) {
	e.mu.Lock()
	ch, ok := e.waiters[id]
	e.mu.Unlock()
	if !ok {
		return
	}
	select {
	case ch <- struct{}{}:
	default: // 已有一次未消费的唤醒，够用了
	}
}
