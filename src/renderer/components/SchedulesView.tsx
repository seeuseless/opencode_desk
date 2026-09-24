import { useEffect, useState } from 'react'
import { Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { Modal } from './Modal'
import { Switch } from './Switch'
import { Menu } from './Menu'
import type { ScheduleSpec, ScheduleTask } from '../../../electron/main/types'

/** 时刻摘要：每天 09:00 / 每周一 08:30 / 每隔 4 小时 */
const pad = (n: number) => String(n).padStart(2, '0')
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function specLabel(s: ScheduleSpec): string {
  if (s.kind === 'hourly') return s.everyHours === 1 ? '每隔 1 小时' : `每隔 ${s.everyHours} 小时`
  const tm = `${pad(s.hour)}:${pad(s.minute)}`
  return s.kind === 'daily' ? `每天 ${tm}` : `每周${WEEK[s.day - 1]} ${tm}`
}

/** 上次执行时间：本地时区的「月-日 时:分」；没跑过显示「尚未执行」 */
function ranLabel(t: number | undefined): string {
  if (!t) return '尚未执行'
  const d = new Date(t)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface Props {
  /** 自增计数：主进程推「有任务到点执行」时 +1，列表跟着重读一次 */
  refreshSignal?: number
  /** 「立即执行」成功后跳到该次执行产出的会话（父 App 激活内置「任务」目录打开） */
  onOpenSession: (sid: string) => void
  /** 保存 / 执行 / 删除失败时弹全局提示 */
  onNotice: (msg: string) => void
  /** 关闭列表页回对话 */
  onClose: () => void
}

/**
 * 计划任务列表页（内容区整页，非弹层）。
 *
 * 数据与到点触发都在主进程（~/.qingniaoai/schedules.json + 30 秒 tick），
 * 这里只管展示与增删改——每次操作后以主进程返回的清单为准，本地不留第二份事实。
 */
export function SchedulesView(p: Props) {
  const [tasks, setTasks] = useState<ScheduleTask[]>([])
  /** null = 弹窗关着；'new' = 新建；ScheduleTask = 编辑这条 */
  const [editing, setEditing] = useState<ScheduleTask | 'new' | null>(null)
  /** 「立即执行」进行中的任务 id（按钮置灰防连点） */
  const [running, setRunning] = useState('')

  useEffect(() => {
    void window.qingniao.scheduleList().then(setTasks).catch(() => undefined)
  }, [p.refreshSignal])

  async function remove(t: ScheduleTask): Promise<void> {
    try {
      setTasks(await window.qingniao.scheduleRemove(t.id))
    } catch (e) {
      p.onNotice('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async function runNow(t: ScheduleTask): Promise<void> {
    setRunning(t.id)
    try {
      const r = await window.qingniao.scheduleRunNow(t.id)
      if (r.ok && r.sessionId) p.onOpenSession(r.sessionId)
      else if (r.error) p.onNotice(r.error)
      try {
        setTasks(await window.qingniao.scheduleList())
      } catch { /* 刷新失败不影响执行结果 */ }
    } catch (e) {
      p.onNotice('执行失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setRunning('')
    }
  }

  const initial = editing === 'new' ? null : editing

  return (
    <>
      <div className="spage">
        <div className="spage-head">
          <h3>计划任务</h3>
          <button className="primary" onClick={() => setEditing('new')}>
            <Plus size={14} />
            新建计划任务
          </button>
          <button className="icon-btn" title="关闭" onClick={p.onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="spage-body">
          {tasks.length === 0 ? (
            <div className="spage-empty">还没有计划任务。点右上角「新建计划任务」，让它每天、每周或每隔几小时自动执行。</div>
          ) : (
            tasks.map((t) => (
              <div key={t.id} className={'scard' + (t.enabled ? '' : ' off')}>
                <div className="scard-main" onClick={() => setEditing(t)}>
                  <div className="scard-name">
                    <span className="scard-title">{t.name}</span>
                    {t.lastError && <span className="scard-err">上次执行失败：{t.lastError}</span>}
                  </div>
                  <div className="scard-sub">
                    {specLabel(t.spec)} · 上次执行 {ranLabel(t.lastRun)}
                    {t.enabled ? '' : ' · 已停用'}
                  </div>
                </div>
                <div className="scard-acts">
                  <button
                    className="icon-btn"
                    title="立即执行"
                    disabled={!!running}
                    onClick={() => void runNow(t)}
                  >
                    <Play size={14} />
                  </button>
                  <button className="icon-btn" title="编辑" onClick={() => setEditing(t)}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title="删除计划任务（已产出的会话保留）"
                    onClick={() => void remove(t)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {editing !== null && (
        <ScheduleModal
          initial={initial}
          onSaved={() => {
            setEditing(null)
            // 保存成功后以主进程清单为准（nextRun 由它计算）
            void window.qingniao.scheduleList().then(setTasks).catch(() => undefined)
          }}
          onClose={() => setEditing(null)}
          onNotice={p.onNotice}
        />
      )}
    </>
  )
}

/** 新建 / 编辑共用一份表单；新建时主进程补 createdAt / nextRun，这里填占位值即可 */
function ScheduleModal({
  initial,
  onSaved,
  onClose,
  onNotice
}: {
  initial: ScheduleTask | null
  onSaved: () => void
  onClose: () => void
  onNotice: (msg: string) => void
}) {
  const spec = initial?.spec
  const [name, setName] = useState(initial?.name ?? '')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [mode, setMode] = useState<ScheduleSpec['kind']>(spec?.kind ?? 'daily')
  /** daily/weekly 共用的时刻，拆成时分两个下拉（原生 time 控件不跟主题） */
  const [hour, setHour] = useState(spec && spec.kind !== 'hourly' ? spec.hour : 9)
  const [minute, setMinute] = useState(spec && spec.kind !== 'hourly' ? spec.minute : 0)
  const [day, setDay] = useState(spec?.kind === 'weekly' ? spec.day : 1)
  const [hours, setHours] = useState(spec?.kind === 'hourly' ? String(spec.everyHours) : '1')
  const [enabled, setEnabled] = useState(initial?.enabled ?? true)
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    const sp: ScheduleSpec =
      mode === 'daily'
        ? { kind: 'daily', hour, minute }
        : mode === 'weekly'
          ? { kind: 'weekly', day, hour, minute }
          : { kind: 'hourly', everyHours: Number(hours) }
    const t: ScheduleTask = {
      id: initial?.id ?? 'st' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      prompt: prompt.trim(),
      spec: sp,
      enabled,
      createdAt: initial?.createdAt ?? Date.now(),
      nextRun: initial?.nextRun ?? Date.now()
    }
    setSaving(true)
    try {
      await window.qingniao.scheduleSave(t)
      onSaved()
    } catch (e) {
      onNotice('保存失败：' + (e instanceof Error ? e.message : String(e)))
      setSaving(false)
    }
  }

  return (
    <Modal title={initial ? '计划任务' : '新建计划任务'} onClose={onClose} wide>
      <div className="sched-form">
        <label>
          任务名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：每日晨报" maxLength={40} autoFocus />
        </label>
        <label>
          任务内容
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="定时要执行的内容，会以新会话发给 AI"
            rows={3}
          />
        </label>
        <label>
          执行时间
          {/* 面板一律向上弹：这行在弹窗里位置偏下，向下展开会被弹窗底边裁掉 */}
          <div className="sched-pick">
            <Menu
              value={mode}
              options={[
                { key: 'daily', label: '每天' },
                { key: 'weekly', label: '每周' },
                { key: 'hourly', label: '每隔 N 小时' }
              ]}
              onChange={(k) => setMode(k as ScheduleSpec['kind'])}
              placeholder="选择周期"
              up
            />
            {mode === 'weekly' && (
              <Menu
                value={String(day)}
                options={WEEK.map((w, i) => ({ key: String(i + 1), label: w }))}
                onChange={(k) => setDay(Number(k))}
                placeholder="选择星期"
                up
              />
            )}
            {mode === 'hourly' ? (
              <Menu
                value={hours}
                options={Array.from({ length: 24 }, (_, i) => ({
                  key: String(i + 1),
                  label: `每隔 ${i + 1} 小时`
                }))}
                onChange={setHours}
                placeholder="选择间隔"
                up
              />
            ) : (
              <>
                <Menu
                  value={pad(hour)}
                  options={Array.from({ length: 24 }, (_, i) => ({ key: pad(i), label: pad(i) + ' 时' }))}
                  onChange={(k) => setHour(Number(k))}
                  placeholder="时"
                  up
                />
                <Menu
                  value={pad(minute)}
                  options={Array.from({ length: 60 }, (_, i) => ({ key: pad(i), label: pad(i) + ' 分' }))}
                  onChange={(k) => setMinute(Number(k))}
                  placeholder="分"
                  up
                />
              </>
            )}
          </div>
        </label>
        <div className="sched-on">
          <div>
            <b>启用该任务</b>
            <span className="lab-tip">关闭后不再自动执行，仍可随时手动「立即执行」</span>
          </div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>
        {initial?.lastError && <p className="form-msg bad">上次执行失败：{initial.lastError}</p>}
        <div className="actions">
          <button className="ghost" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={!name.trim() || !prompt.trim() || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
