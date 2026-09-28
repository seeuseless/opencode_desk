import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { Modal } from './Modal'
import { moveItem, useDragSort } from './useDragSort'
import { Switch } from './Switch'
import { Menu } from './Menu'
import { t } from '../i18n'
import type { ScheduleSpec, ScheduleTask } from '../../../electron/main/types'

/** 时刻摘要：每天 09:00 / 每周一 08:30 / 每隔 4 小时 */
const pad = (n: number) => String(n).padStart(2, '0')
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function specLabel(s: ScheduleSpec): string {
  if (s.kind === 'hourly') return s.everyHours === 1 ? t('每隔 {n} 小时', { n: 1 }) : t('每隔 {n} 小时', { n: s.everyHours })
  const tm = `${pad(s.hour)}:${pad(s.minute)}`
  return s.kind === 'daily' ? t('每天 {tm}', { tm }) : t('每周{w} {tm}', { w: t(WEEK[s.day - 1]), tm })
}

/** 上次执行时间：本地时区的「月-日 时:分」；没跑过显示「尚未执行」 */
function ranLabel(ts: number | undefined): string {
  if (!ts) return t('尚未执行')
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface Props {
  /** 自增计数：主进程推「有任务到点执行」时 +1，列表跟着重读一次 */
  refreshSignal?: number
  /** 「立即执行」成功后展开左侧内置「任务」目录，让新会话直接可见 */
  onTaskSessionCreated: () => void
  /** 保存 / 执行 / 删除失败时弹全局提示 */
  onNotice: (msg: string) => void
  /** 关闭计划任务弹层 */
  onClose: () => void
}

/**
 * 计划任务列表（弹层内容）。
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
  /** 待删除任务：删除前二次确认 */
  const [confirmDel, setConfirmDel] = useState<ScheduleTask | null>(null)
  /** 只接受最后一次拖拽响应，避免较慢的旧请求覆盖新顺序 */
  const reorderSeq = useRef(0)

  useEffect(() => {
    void window.qingniao.scheduleList().then(setTasks).catch(() => undefined)
  }, [p.refreshSignal])

  async function remove(task: ScheduleTask): Promise<void> {
    try {
      setTasks(await window.qingniao.scheduleRemove(task.id))
    } catch (e) {
      p.onNotice(t('删除失败：') + (e instanceof Error ? e.message : String(e)))
    }
  }

  async function runNow(task: ScheduleTask): Promise<void> {
    setRunning(task.id)
    try {
      const r = await window.qingniao.scheduleRunNow(task.id)
      if (r.ok) p.onTaskSessionCreated()
      else if (r.error) p.onNotice(r.error)
      try {
        setTasks(await window.qingniao.scheduleList())
      } catch { /* 刷新失败不影响执行结果 */ }
    } catch (e) {
      p.onNotice(t('执行失败：') + (e instanceof Error ? e.message : String(e)))
    } finally {
      setRunning('')
    }
  }

  async function reorderTasks(from: number, to: number): Promise<void> {
    const previous = tasks
    const next = moveItem(tasks, from, to)
    if (next === previous) return
    const seq = ++reorderSeq.current
    setTasks(next)
    try {
      const saved = await window.qingniao.scheduleReorder(next.map((x) => x.id))
      if (reorderSeq.current === seq) setTasks(saved)
    } catch (e) {
      if (reorderSeq.current !== seq) return
      try {
        setTasks(await window.qingniao.scheduleList())
      } catch {
        setTasks(previous)
      }
      p.onNotice(t('排序保存失败：') + (e instanceof Error ? e.message : String(e)))
    }
  }

  const taskSort = useDragSort((from, to) => void reorderTasks(from, to))
  const initial = editing === 'new' ? null : editing

  return (
    <>
      <div className="spage">
        <div className="spage-head">
          <h3 style={{ flex: 'none' }}>{t('计划任务')}</h3>
          <button className="icon-btn" onClick={() => setEditing('new')} title={t('新建计划任务')}>
            <Plus size={16} />
          </button>
          <span className="spacer" />
          <button className="icon-btn" onClick={p.onClose} title={t('关闭计划任务')}>
            <X size={16} />
          </button>
        </div>
        <div className="spage-body">
          {tasks.length === 0 ? (
            <div className="spage-empty">{t('还没有计划任务。点右上角「新建计划任务」，让它每天、每周或每隔几小时自动执行。')}</div>
          ) : (
            tasks.map((tk, i) => (
              <div
                {...taskSort.rowProps(i)}
                {...taskSort.handleProps(i)}
                key={tk.id}
                className={
                  'scard'
                  + (tk.enabled ? '' : ' off')
                  + (taskSort.dragIdx === i ? ' dragging' : '')
                  + (taskSort.overIdx === i ? ' dragover ' + taskSort.overPos : '')
                }
              >
                <div className="scard-main" onClick={() => setEditing(tk)}>
                  <div className="scard-name">
                    <span className="scard-title">{tk.name}</span>
                    {tk.lastError && <span className="scard-err">{t('上次执行失败：')}{tk.lastError}</span>}
                  </div>
                  <div className="scard-sub">
                    {specLabel(tk.spec)} · {t('上次执行')} {ranLabel(tk.lastRun)}
                    {tk.enabled ? '' : ' · ' + t('已停用')}
                    {/* 补跑只在「启用 且 开着 catchUp」时才真的会发生，关掉的那条不必占地方 */}
                    {tk.enabled && tk.catchUp !== false ? ' · ' + t('错过后补跑') : ''}
                  </div>
                </div>
                <div className="scard-acts">
                  <button
                    className="icon-btn"
                    title={running === tk.id ? t('执行中…') : t('立即执行')}
                    aria-busy={running === tk.id}
                    disabled={!!running}
                    onClick={() => void runNow(tk)}
                  >
                    {running === tk.id ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
                  </button>
                  <button className="icon-btn" title={t('编辑')} onClick={() => setEditing(tk)}>
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title={t('删除计划任务（已产出的会话保留）')}
                    onClick={() => setConfirmDel(tk)}
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

      {confirmDel && (
        <Modal title={t('删除计划任务')} onClose={() => setConfirmDel(null)}>
          <p className="confirm-text">
            {t('确定删除「{name}」吗？删除后不再自动执行，已产出的会话会保留。', { name: confirmDel.name })}
          </p>
          <div className="actions">
            <button className="ghost" onClick={() => setConfirmDel(null)}>
              {t('取消')}
            </button>
            <button
              className="primary danger-btn"
              onClick={() => {
                const target = confirmDel
                setConfirmDel(null)
                void remove(target)
              }}
            >
              {t('删除')}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

/** 新建 / 编辑共用一份表单；新建时主进程补 createdAt / order / nextRun，这里填占位值即可 */
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
  /** 补跑默认开：老存档没这个键，按开处理（与主进程 normalizeTask 的缺省一致） */
  const [catchUp, setCatchUp] = useState(initial?.catchUp !== false)
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    const sp: ScheduleSpec =
      mode === 'daily'
        ? { kind: 'daily', hour, minute }
        : mode === 'weekly'
          ? { kind: 'weekly', day, hour, minute }
          : { kind: 'hourly', everyHours: Number(hours) }
    const task: ScheduleTask = {
      id: initial?.id ?? 'st' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      prompt: prompt.trim(),
      spec: sp,
      enabled,
      catchUp,
      createdAt: initial?.createdAt ?? Date.now(),
      order: initial?.order ?? 0,
      nextRun: initial?.nextRun ?? Date.now()
    }
    setSaving(true)
    try {
      await window.qingniao.scheduleSave(task)
      onSaved()
    } catch (e) {
      onNotice(t('保存失败：') + (e instanceof Error ? e.message : String(e)))
      setSaving(false)
    }
  }

  return (
    <Modal title={initial ? t('计划任务') : t('新建计划任务')} onClose={onClose} wide>
      <div className="sched-form">
        <label>
          {t('任务名称')}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('如：每日晨报')} maxLength={40} autoFocus />
        </label>
        <label>
          {t('任务内容')}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('定时要执行的内容，会以新会话发给 AI')}
            rows={3}
          />
        </label>
        <label>
          {t('执行时间')}
          {/* 面板一律向上弹：这行在弹窗里位置偏下，向下展开会被弹窗底边裁掉 */}
          <div className="sched-pick">
            <Menu
              value={mode}
              options={[
                { key: 'daily', label: t('每天') },
                { key: 'weekly', label: t('每周') },
                { key: 'hourly', label: t('每隔 N 小时') }
              ]}
              onChange={(k) => setMode(k as ScheduleSpec['kind'])}
              placeholder={t('选择周期')}
              up
            />
            {mode === 'weekly' && (
              <Menu
                value={String(day)}
                options={WEEK.map((w, i) => ({ key: String(i + 1), label: t(w) }))}
                onChange={(k) => setDay(Number(k))}
                placeholder={t('选择星期')}
                up
              />
            )}
            {mode === 'hourly' ? (
              <Menu
                value={hours}
                options={Array.from({ length: 24 }, (_, i) => ({
                  key: String(i + 1),
                  label: t('每隔 {n} 小时', { n: i + 1 })
                }))}
                onChange={setHours}
                placeholder={t('选择间隔')}
                up
              />
            ) : (
              <>
                <Menu
                  value={pad(hour)}
                  options={Array.from({ length: 24 }, (_, i) => ({ key: pad(i), label: pad(i) + ' ' + t('时') }))}
                  onChange={(k) => setHour(Number(k))}
                  placeholder={t('时')}
                  up
                />
                <Menu
                  value={pad(minute)}
                  options={Array.from({ length: 60 }, (_, i) => ({ key: pad(i), label: pad(i) + ' ' + t('分') }))}
                  onChange={(k) => setMinute(Number(k))}
                  placeholder={t('分')}
                  up
                />
              </>
            )}
          </div>
        </label>
        <div className="sched-on">
          <div>
            <b>{t('启用该任务')}</b>
            <span className="lab-tip">{t('关闭后不再自动执行，仍可随时手动「立即执行」')}</span>
          </div>
          <Switch checked={enabled} onChange={setEnabled} />
        </div>
        <div className="sched-on">
          <div>
            <b>{t('错过后补跑')}</b>
            <span className="lab-tip">
              {t('到点时电脑关着或应用没开，下次启动会补跑那一次（仅限 24 小时内，且只补最近一次）')}
            </span>
          </div>
          <Switch checked={catchUp} onChange={setCatchUp} />
        </div>
        {initial?.lastError && <p className="form-msg bad">{t('上次执行失败：')}{initial.lastError}</p>}
        <div className="actions">
          <button className="ghost" onClick={onClose}>
            {t('取消')}
          </button>
          <button className="primary" disabled={!name.trim() || !prompt.trim() || saving} onClick={() => void save()}>
            {saving ? t('保存中…') : t('保存')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
