/**
 * 内核日志 tail —— 把 opencode.log 里的**流式失败**实时推给渲染层，让用户第一时间看到。
 *
 * ## 为什么需要它
 *
 * 内核把大量上游失败只写进自己的日志，**既不推 `session.error` 事件，也不会立刻把 error 写进
 * 助手消息**。实测最典型的一条（2026-10-13）：
 *
 * ```
 * 13:04:49 stream qn-go/space-bunny-free
 * 13:04:50 ERROR stream error … Model is unavailable.
 * 13:04:54 ERROR stream error … Model is unavailable.     ← 内核自动重试，间隔递增
 * 13:04:58 / 13:05:08 / 13:05:26 / 13:06:03 …              ← 共 6 次，累计 1 分 39 秒
 * 13:06:04 ERROR process … error="Model is unavailable."  ← 到这才写进消息，界面才有反应
 * ```
 *
 * 也就是说界面会「一直转圈一分多钟」，用户既不知道出了什么事、也不知道该不该继续等。
 * 轮询兜底（ChatView 每 1.2s 拉一次 /message）救不了这个窗口——那 1 分 39 秒里消息里确实没有 error。
 * 日志是这段时间里**唯一**的信息源，所以这里 tail 它。
 *
 * ## 口径
 *
 * - 只取 `message="stream error"` 行（每回合每次重试一条），**不取 `process … error=`**：
 *   后者是内核最终放弃后的结论，渲染层的回合对账已经会兜住，重复推只会让同一条错误弹两遍。
 * - 每回合只推**第一次**（同一 sessionID + 同一错误文案只推一次，重试风暴不刷屏）。
 * - `server unavailable key=…` 这类 WARN **不推**（每个 session 都有一条，与失败无关，纯噪音）。
 * - 内核重启后日志会被**截断重写**，所以按字节偏移 tail，每轮重新核对文件大小，变小即重置。
 */
import { createReadStream, statSync, existsSync, watch, type FSWatcher } from 'node:fs'
import { opencodeDataDir } from './config.ts'

/** 单行最大读取长度：内核日志里有超长 stack 字段，不截断会一次性吃掉内存 */
const MAX_LINE = 8192

/** 一次读取的块大小（增量 tail 用） */
const CHUNK = 64 * 1024

export interface StreamErrorInfo {
  sessionID: string
  /** 已经过 humanizeError 的原文（此处只做清洗与截断，翻译在渲染层做——那边才有 i18n） */
  message: string
  providerID?: string
  modelID?: string
}

/**
 * 从一行日志里抠出字段值。
 *
 * 引号内的值可能带**转义引号**（`\"`）——实测见过 error.error="All providers for model \"x\" …" 这种，
 * 用 `"[^"]*"` 会截在第一个转义引号处，拿到半句垃圾文案。逐字符扫并识别 `\X` 转义才拿得全。
 * 无引号的裸值扫到空白为止。
 */
function field(line: string, key: string): string | undefined {
  const at = line.indexOf(key + '=')
  if (at < 0) return undefined
  // 键名左边必须是行首或空白，避免 `xsession.id=` 之类误命中
  if (at > 0 && !/[\s]/.test(line[at - 1])) return undefined
  let i = at + key.length + 1
  if (line[i] === '"') {
    let out = ''
    i++
    while (i < line.length) {
      const ch = line[i]
      if (ch === '\\' && i + 1 < line.length) {
        out += line[i + 1] // \" → " ，\n → n …
        i += 2
        continue
      }
      if (ch === '"') return out
      out += ch
      i++
    }
    return out // 行尾没有收尾引号：如实返回已扫到的部分，不丢内容
  }
  let out = ''
  while (i < line.length && !/\s/.test(line[i])) {
    out += line[i]
    i++
  }
  return out || undefined
}

export class KernelLogTail {
  /** 字节偏移：已消费到日志的哪个位置（重启被截断时归零重来） */
  private pos = 0
  /** 半个行的残留（内核写日志按行，但 chunk 边界可能切在 \n 中间） */
  private carry = ''
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  /** 去重指纹：同一回合的同一错误只提示一次（内核重试 6 次不该弹 6 个 toast） */
  private readonly seen = new Set<string>()
  /** 指纹上限：超出就清空重来（长期运行的进程不能无限涨） */
  private static readonly SEEN_MAX = 200

  constructor(private readonly onError: (info: StreamErrorInfo) => void) {}

  start(): void {
    this.stopped = false
    const file = logFile()
    if (!file) return
    try {
      this.watcher = watch(file, () => this.pump())
    } catch {
      // 监听失败（文件被短暂锁住等）：退回纯定时轮询，仍能工作
      this.watcher = null
    }
    // 兜底定时器：watch 在部分 Windows 场景下会漏事件（网络盘/杀软拦截），
    // 1.2s 一跳与渲染层轮询同频，保证最坏情况也只迟 1.2s。
    this.timer = setInterval(() => this.pump(), 1200)
    this.pump()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 增量读一遍新内容，按行分派 */
  private pump(): void {
    if (this.stopped) return
    const file = logFile()
    if (!file) return
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    // 内核重启 → 日志被截断重写：偏移越界，回到文件头
    if (size < this.pos) {
      this.pos = 0
      this.carry = ''
    }
    if (size === this.pos) return
    let buf = ''
    // encoding: 'utf8' 让流按字符串吐，但 TS 仍把 chunk 标成 string|Buffer，这里显式收一下
    const stream = createReadStream(file, { start: this.pos, end: size - 1, encoding: 'utf8' })
    stream.on('data', (chunk: string | Buffer) => {
      const c = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      buf += c
      if (buf.length > MAX_LINE * 8) {
        // 单次读太多（理论上不会）：丢弃前半，防内存涨
        this.pos += Buffer.byteLength(buf.slice(0, buf.length - MAX_LINE))
        buf = buf.slice(-MAX_LINE)
      }
    })
    stream.on('end', () => {
      this.pos = size
      const lines = (this.carry + buf).split('\n')
      // 最后一段可能是半行（内核还没写完换行）：留着等下一轮
      this.carry = lines.pop() ?? ''
      for (const line of lines) this.handle(line.trim())
    })
    stream.on('error', () => {
      /* 文件被删/锁：下一轮 pump 再试 */
    })
  }

  /** 单行分派：只认内核的流式失败行 */
  private handle(line: string): void {
    if (!line || !line.includes('message="stream error"')) return
    const sessionID = field(line, 'session\\.id')
    if (!sessionID) return
    // 错误文案在 error.error="…" 里（可能含空格，必须取引号内整段）
    const raw = field(line, 'error\\.error') ?? ''
    const message = raw.replace(/^[A-Za-z_]*Error:\s*/, '').trim()
    if (!message) return

    // 去重：同一回合同一错误只提示一次（重试风暴不刷屏）
    const key = sessionID + '|' + message.slice(0, 120)
    if (this.seen.has(key)) return
    if (this.seen.size > KernelLogTail.SEEN_MAX) this.seen.clear()
    this.seen.add(key)

    this.onError({
      sessionID,
      message: message.length > 300 ? message.slice(0, 300) + '…' : message,
      providerID: field(line, 'providerID'),
      modelID: field(line, 'modelID')
    })
  }
}

/** 内核日志文件路径（各版本目录略有出入，取存在的那个） */
function logFile(): string | null {
  const root = opencodeDataDir() + '/opencode/log'
  for (const f of [root + '/opencode.log', root + '/opencode-1.log']) {
    if (existsSync(f)) return f
  }
  return null
}