#!/usr/bin/env node
// 邮件 MCP：把 Agent Mail（agent.qq.com，agently-cli）的能力挂进对话。
// 收发都经 agently-cli 子进程完成（token 在系统钥匙串，授权入口在「设置 → 邮箱」）。
//
// 工具：me（账号/额度）、list、read、search、send、reply、forward、trash、
//       attachment_download（附件落盘）。
// 发送保留上游的两段式确认：首次 send/reply 不带 --confirmed 时服务端会发回
// confirmation-token，工具把它原样透给模型，要求先向用户复述收件人/主题/正文、
// 用户同意后再带 confirm=true 重调——不给模型「静默发信」的口子。
//
// CLI 定位顺序：env QN_AGENTLY_CLI → dev（本目录 node_modules，脚本就近解析，
// 见 resources/mcp/package.json）→ 打包态（resources/node_modules，extraResources 拷贝）
// → PATH 上的 agently-cli。前三种都用 Electron 自带 node 直跑 run.js，不依赖用户装 node。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const RUN_JS = join('@tencent-qqmail', 'agently-cli', 'scripts', 'run.js')

/** 找到可执行的 CLI：返回 { command: string[], cwd? } 或 null */
function resolveCli() {
  // 1. 显式环境变量（指向 run.js 或任意可执行入口）
  const env = process.env.QN_AGENTLY_CLI?.trim()
  if (env && existsSync(env)) return { command: [env] }
  // 2. dev：resources/mcp/node_modules（脚本与本目录同级）
  const dev = join(here, 'node_modules', RUN_JS)
  if (existsSync(dev)) return { command: [process.execPath, dev] }
  // 3. 打包态：resources/node_modules（脚本在 resources/ 根，依赖在其下 node_modules）
  const packed = join(here, '..', 'node_modules', RUN_JS)
  if (existsSync(packed)) return { command: [process.execPath, packed] }
  // 4. PATH 上的 agently-cli（Windows 的 npm shim 是 .cmd，要开 shell 才能拉起）
  const isWin = process.platform === 'win32'
  const exe = isWin ? 'agently-cli.cmd' : 'agently-cli'
  if (!isWin && existsSync(join('/usr/local/bin', exe))) return { command: [join('/usr/local/bin', exe)] }
  return { command: [exe], shell: isWin } // PATH 兜底；win 上 shell:true，找不到时 spawn 报 ENOENT
}

let cli = null
try {
  cli = resolveCli()
} catch {
  cli = null
}

const TOOLS = [
  {
    name: 'me',
    description:
      '查看当前邮箱账号（地址、别名）与配额（日发送上限、附件限制）。用户问「我的邮箱是什么」「还能发几封」时用它；' +
      '发送前不确定地址也可先查。报错通常意味着未授权，让用户到「设置 → 邮箱」完成授权。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list',
    description:
      '列出邮箱里的邮件（默认收件箱，可看已发送/废纸篓/垃圾箱）。返回摘要（主题、发件人、时间、片段、message_id）。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', enum: ['inbox', 'sent', 'trash', 'spam'], description: '文件夹，默认 inbox' },
        limit: { type: 'number', description: '每页条数（1-50，默认 10）' },
        cursor: { type: 'string', description: '上一页返回的翻页游标' },
        is_unread: { type: 'boolean', description: '只看未读' },
        has_attachments: { type: 'boolean', description: '只看带附件的' },
        after: { type: 'string', description: '只看此时间之后（ISO 8601）' },
        before: { type: 'string', description: '只看此时间之前（ISO 8601）' }
      }
    }
  },
  {
    name: 'read',
    description:
      '读一封邮件的完整内容（正文、附件清单、收发件人）。message_id 来自 list/search 结果。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'message_id（msg_ 开头）' } },
      required: ['id']
    }
  },
  {
    name: 'search',
    description: '按关键词搜邮件（默认搜主题+正文），可按发件人/收件人/文件夹/时间过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词' },
        from: { type: 'string', description: '按发件人过滤' },
        to: { type: 'string', description: '按收件人过滤' },
        dir: { type: 'string', enum: ['inbox', 'sent', 'trash', 'spam'], description: '文件夹过滤' },
        search_in: { type: 'string', enum: ['SEARCH_IN_ALL', 'SEARCH_IN_SUBJECT', 'SEARCH_IN_CONTENT'] },
        limit: { type: 'number', description: '每页条数（1-50，默认 10）' },
        cursor: { type: 'string', description: '翻页游标（翻页时须带上原过滤条件）' },
        after: { type: 'string', description: '只看此时间之后（ISO 8601）' },
        before: { type: 'string', description: '只看此时间之前（ISO 8601）' }
      },
      required: ['q']
    }
  },
  {
    name: 'send',
    description:
      '发一封新邮件。**首次调用不要带 confirm**：服务端会返回确认令牌，你必须先把收件人/主题/正文复述给用户、' +
      '得到明确同意后，再带 confirm=true 和返回的 token 信息重调一次才会真正发出。附件传本地文件的绝对路径。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: '收件人邮箱（可多个）' },
        subject: { type: 'string', description: '主题' },
        body: { type: 'string', description: '正文' },
        body_format: { type: 'string', enum: ['plain', 'html', 'markdown'], description: '正文格式，默认自动识别' },
        cc: { type: 'array', items: { type: 'string' }, description: '抄送' },
        bcc: { type: 'array', items: { type: 'string' }, description: '密送' },
        attachments: { type: 'array', items: { type: 'string' }, description: '附件本地路径（绝对路径）' },
        confirm: { type: 'boolean', description: '用户已确认过这封邮件的内容，允许真正发出' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'reply',
    description:
      '回复一封邮件（默认只回发件人，reply_all 回全部）。确认机制同 send：首调不带 confirm，向用户复述内容并征得同意后再带 confirm=true 重调。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要回复的 message_id' },
        body: { type: 'string', description: '回复正文' },
        reply_all: { type: 'boolean', description: '回复全部收件人' },
        attachments: { type: 'array', items: { type: 'string' }, description: '附件本地路径（绝对路径）' },
        confirm: { type: 'boolean', description: '用户已确认，允许真正发出' }
      },
      required: ['id', 'body']
    }
  },
  {
    name: 'forward',
    description: '把一封邮件转发给新收件人。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要转发的 message_id' },
        to: { type: 'array', items: { type: 'string' }, description: '转发收件人' },
        body: { type: 'string', description: '附加说明（可空）' }
      },
      required: ['id', 'to']
    }
  },
  {
    name: 'trash',
    description: '把一封邮件移入废纸篓（可恢复；彻底删除在网页端做）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'message_id' } },
      required: ['id']
    }
  },
  {
    name: 'attachment_download',
    description:
      '把邮件附件下载到本地目录，返回保存后的文件路径。msg 与 att 都来自 read 结果里的附件清单。',
    inputSchema: {
      type: 'object',
      properties: {
        msg: { type: 'string', description: 'message_id' },
        att: { type: 'string', description: 'attachment_id' },
        output: { type: 'string', description: '保存目录（绝对路径，默认系统临时目录）' }
      },
      required: ['msg', 'att']
    }
  }
]

const okText = (t) => ({ content: [{ type: 'text', text: t }] })
// 失败必须带 isError：只回一段普通文本，模型未必当成失败，会反复重试。
const errText = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const AUTH_HINT =
  '（如果这是授权问题：请让用户到「设置 → 邮箱」点击授权完成 Agent Mail 登录，然后重试。）'

/** 调一次 CLI，返回 stdout 文本 */
function runCli(args, cwd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!cli) return reject(new Error('未找到 agently-cli'))
    const [exe, ...rest] = cli.command
    // shell 模式（Windows PATH 兜底跑 .cmd shim）下 spawn 是空格拼接，含空格的参数要自己加引号
    const argv = cli.shell ? rest.map((x) => (/\s/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)) : rest
    const p = spawn(exe, [...argv, ...args.map((x) => (cli.shell && /\s/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x))], {
      cwd: cwd || undefined,
      shell: cli.shell === true,
      windowsHide: true,
      env: process.env
    })
    let out = ''
    let err = ''
    // Electron 当 node 用（process.execPath）会往 stderr 打 crashpad / GPU 等启动噪音，
    // 这些行不是 CLI 的输出，混进错误文案会误导模型与用户，spawn 出来就滤掉。
    const isNoise = (s) => /^\s*[\[(]?\d{4}\/|crashpad|Electron Security Warning|--trace-warnings|UnhandledPromiseRejection/i.test(s)
    const timer = setTimeout(() => {
      p.kill()
      reject(new Error('邮件命令超时（60 秒），请稍后重试'))
    }, timeoutMs)
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += String(d).split('\n').filter((l) => !isNoise(l)).join('\n')))
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || out.trim()) resolve(out)
      else reject(new Error(err.trim() || `agently-cli 退出码 ${code}`))
    })
  })
}

/** 截断过长的工具输出，保住上下文 */
function cap(text, max = 9000) {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n…（输出过长已截断，原文 ${text.length} 字符；可用 limit/cursor 翻页缩小范围）`
}

/** 把 CLI 的 JSON 输出整理成给模型看的文本 */
function present(raw) {
  const s = raw.trim()
  let j
  try {
    j = JSON.parse(s)
  } catch {
    return cap(s) // 非 JSON：原样给（CLI 某些提示性输出是纯文本）
  }
  if (j && j.ok === false) {
    const msg = String(j.error?.message ?? j.error?.data?.message ?? j.error?.name ?? JSON.stringify(j.error ?? j))
    // 授权类错误才带指引，别把「资源不存在」也误导成「没授权」
    const authLike = /auth|credential|unauthor|401|token|login/i.test(msg) || /auth|credential|unauthor|401/i.test(s)
    throw new Error(msg + (authLike ? ' ' + AUTH_HINT : ''))
  }
  return cap(s)
}

/** send/reply 的确认机制：输出里出现 confirmation-token 就要求模型走一遍人工确认 */
function confirmHint(text) {
  if (!text.includes('confirmation') && !text.includes('confirmation-token')) return text
  return (
    text +
    '\n\n【发送确认】邮件服务要求二次确认。请把收件人/主题/正文完整复述给用户，' +
    '用户明确同意后，带上 confirm=true 再次调用本工具（若上面给了 confirmation token，按其要求携带）完成发送。'
  )
}

function strArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v.map(String) : [String(v)]
}

/** 把工具参数翻译成 CLI 参数（各工具略有差异，集中在这一处） */
async function dispatch(action, a) {
  const run = (args, cwd) => runCli(args, cwd)
  switch (action) {
    case 'me':
      return present(await run(['+me']))
    case 'list': {
      const args = ['message', '+list', '--dir', String(a.dir || 'inbox'), '--limit', String(Math.min(Math.max(Number(a.limit) || 10, 1), 50))]
      if (a.cursor) args.push('--cursor', String(a.cursor))
      if (a.is_unread) args.push('--is-unread')
      if (a.has_attachments) args.push('--has-attachments')
      if (a.after) args.push('--after', String(a.after))
      if (a.before) args.push('--before', String(a.before))
      return present(await run(args))
    }
    case 'read':
      return present(await run(['message', '+read', '--id', String(a.id)]))
    case 'search': {
      const args = ['message', '+search', '--q', String(a.q), '--limit', String(Math.min(Math.max(Number(a.limit) || 10, 1), 50))]
      if (a.from) args.push('--from', String(a.from))
      if (a.to) args.push('--to', String(a.to))
      if (a.dir) args.push('--dir', String(a.dir))
      if (a.search_in) args.push('--search-in', String(a.search_in))
      if (a.cursor) args.push('--cursor', String(a.cursor))
      if (a.after) args.push('--after', String(a.after))
      if (a.before) args.push('--before', String(a.before))
      return present(await run(args))
    }
    case 'send':
    case 'reply': {
      const args =
        action === 'send'
          ? ['message', '+send', ...strArray(a.to).flatMap((x) => ['--to', x]), '--subject', String(a.subject)]
          : ['message', '+reply', '--id', String(a.id)]
      if (action === 'send') {
        for (const x of strArray(a.cc)) args.push('--cc', x)
        for (const x of strArray(a.bcc)) args.push('--bcc', x)
      } else if (a.reply_all) args.push('--reply-all')
      args.push('--body', String(a.body ?? ''))
      if (a.body_format && action === 'send') args.push('--body-format', String(a.body_format))
      for (const x of strArray(a.attachments)) args.push('--attachment', x)
      if (a.confirm) args.push('--confirmed')
      return confirmHint(present(await run(args)))
    }
    case 'forward': {
      const args = ['message', '+forward', '--id', String(a.id)]
      for (const x of strArray(a.to)) args.push('--to', x)
      if (a.body) args.push('--body', String(a.body))
      return present(await run(args))
    }
    case 'trash':
      return present(await run(['message', '+trash', '--id', String(a.id)]))
    case 'attachment_download': {
      const outDir = String(a.output || join(tmpdir(), 'qingniao-mail')).trim()
      return present(await run(['attachment', '+download', '--msg', String(a.msg), '--att', String(a.att), '--output', '.'], outDir))
    }
    default:
      throw new Error('未知工具：' + action)
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method } = req
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'qingniao-mail', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    const action = name.replace(/^mail_/, '')
    const args = req.params?.arguments ?? {}
    try {
      if (!cli) {
        send({
          jsonrpc: '2.0',
          id,
          result: errText('未找到 agently-cli（邮件功能依赖它）。请更新或重新安装青鸟桌面端。')
        })
        return
      }
      const text = await dispatch(action, args)
      send({ jsonrpc: '2.0', id, result: okText(text) })
    } catch (e) {
      const msg = e?.message ?? String(e)
      send({ jsonrpc: '2.0', id, result: errText('邮件操作失败：' + msg + (msg.includes('auth') ? ' ' + AUTH_HINT : '')) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
