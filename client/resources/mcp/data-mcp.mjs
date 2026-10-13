#!/usr/bin/env node
// 数据处理 MCP：json_query / regex_find —— 让模型用一次调用从 JSON 接口 / 大文本里取准内容。
//
// 动机（2026-10-13 用户实测）：问「cakephp 最新版本」时模型先 webfetch 拉 JSON，
// 再用 bash grep 啃压缩成单行的大 JSON，截不准就反复重试，每轮都是几秒的模型往返。
// 本服务三个输入源（url / text / filePath）× 两种提取器：
//   - json_query：路径表达式取值（$.a.b[0].c、[*] 通配、fallback 兜底），未命中带键名提示帮模型自纠
//   - regex_find：正则提取全部匹配（含分组），按行编号限量返回
// 典型用法：data_json_query({ url: 'https://repo.packagist.org/p2/topthink/framework.json',
//                             path: '$.packages["topthink/framework"][0].version' }) 一次拿回版本号。
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { resolve as pathResolve, isAbsolute } from 'node:path'

const MAX_TEXT = 5 * 1024 * 1024        // text 入参上限
const MAX_FILE = 20 * 1024 * 1024       // filePath 读取上限
const MAX_OUT = 4000                    // 返回给模型的文本上限（省 token）
const MAX_MATCH = 200                   // regex_find 单个匹配回显上限

const okText = (t) => ({ content: [{ type: 'text', text: t }] })
// 失败必须带 isError：只回一段普通文本模型未必当成失败，会反复重试
const errText = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const cut = (t) => (t.length > MAX_OUT ? t.slice(0, MAX_OUT) + `\n…(过长已截断，原文共 ${t.length} 字符，请用更精确的 path/pattern 收窄)` : t)

/** 取输入源：url 优先（自带网络，一步取数），其次 filePath，最后 text */
async function loadSource(args) {
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : ''
  const text = typeof args.text === 'string' ? args.text : ''
  if (url) {
    let r
    try {
      r = await fetch(url, {
        headers: { 'user-agent': 'QingNiao-Data-MCP/1.0', accept: 'application/json,text/json,*/*' },
        signal: AbortSignal.timeout(30000)
      })
    } catch (e) {
      throw new Error('请求失败：' + (e?.message ?? e))
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}：${url}`)
    const body = await r.text()
    if (body.length > MAX_TEXT) throw new Error(`响应体 ${(body.length / 1048576).toFixed(1)}MB 超过上限，请换分页/字段更少的接口`)
    return body
  }
  if (filePath) {
    const abs = isAbsolute(filePath) ? filePath : pathResolve(process.cwd(), filePath)
    return readFileSync(abs, 'utf8')
  }
  if (text) {
    if (text.length > MAX_TEXT) throw new Error('text 超过 5MB 上限，请先把内容写到文件再用 filePath 传入')
    return text
  }
  throw new Error('缺少输入：url / filePath / text 至少给一个')
}

/** 路径表达式 → token 流。四种形态：裸键 packages、.key、["键名"]、[0]、[*]。
 *  裸键（不带点）必须支持——`$.packages[...]` 剥掉 `$.` 后第一个键前面没有点。 */
function parsePath(p) {
  const s = p.trim().replace(/^\$+/, '')
  const toks = []
  const re = /\[\s*(?:"([^"]*)"|'([^']*)')\s*\]|\[\s*(\d+)\s*\]|\[\s*\*\s*\]|([^.\[\]"'\s]+)/g
  let m
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) toks.push({ t: 'key', v: m[1] })
    else if (m[2] !== undefined) toks.push({ t: 'key', v: m[2] })
    else if (m[3] !== undefined) toks.push({ t: 'idx', v: Number(m[3]) })
    else if (m[4] !== undefined) toks.push({ t: 'key', v: m[4] })
    else toks.push({ t: 'star' })
  }
  return toks
}

function pick(cur, toks, i) {
  if (i === toks.length) return { ok: true, v: cur }
  const tok = toks[i]
  if (tok.t === 'star') {
    let arr = cur
    if (!Array.isArray(arr)) {
      if (arr && typeof arr === 'object') arr = Object.values(arr)
      else return { ok: false, at: i }
    }
    const out = []
    for (const item of arr) {
      const r = pick(item, toks, i + 1)
      if (r.ok) out.push(r.v)
    }
    return { ok: true, v: out }
  }
  if (cur == null || typeof cur !== 'object') return { ok: false, at: i }
  if (tok.t === 'idx') {
    if (!Array.isArray(cur) || tok.v >= cur.length) return { ok: false, at: i }
    return pick(cur[tok.v], toks, i + 1)
  }
  if (!(tok.v in cur)) return { ok: false, at: i }
  return pick(cur[tok.v], toks, i + 1)
}

/** 未命中时给「这里有什么」的提示，模型照着改路径一次就能纠对 */
function missHint(cur, toks, at) {
  let container = cur
  for (let k = 0; k < at && container != null && typeof container === 'object'; k++) {
    const tok = toks[k]
    if (tok.t === 'star') {
      const arr = Array.isArray(container) ? container : Object.values(container)
      container = arr[0]
    } else if (tok.t === 'idx') container = Array.isArray(container) ? container[tok.v] : undefined
    else container = container[tok.v]
  }
  if (Array.isArray(container)) return `数组共 ${container.length} 项${container.length ? '，可用 [0] 取第一项' : ''}`
  if (container && typeof container === 'object') {
    const keys = Object.keys(container)
    return `该对象的键有：${keys.slice(0, 30).join(', ')}${keys.length > 30 ? ` …等 ${keys.length} 个` : ''}`
  }
  return '上层不是对象/数组，无法继续取值'
}

async function jsonQuery(args) {
  const raw = await loadSource(args)
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    throw new Error('内容不是合法 JSON：' + (e?.message ?? e))
  }
  const path = String(args.path ?? '').trim()
  if (!path) throw new Error('缺少 path（如 $.packages["name"][0].version）')
  const toks = parsePath(path)
  if (!toks.length) throw new Error('path 解析结果为空：' + path)
  const r = pick(data, toks, 0)
  if (!r.ok) {
    const fb = args.fallback
    if (fb !== undefined && fb !== null && String(fb) !== '') {
      return `路径未命中（${missHint(data, toks, r.at)}），按 fallback 返回：\n${String(fb)}`
    }
    throw new Error(`路径未命中：${path}\n未命中位置提示——${missHint(data, toks, r.at)}`)
  }
  const v = r.v
  // 字符串原样回；数字/布尔/对象统一 JSON 化（对象带缩进便于模型读结构）
  return cut(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}

async function regexFind(args) {
  const raw = await loadSource(args)
  const pattern = String(args.pattern ?? '')
  if (!pattern) throw new Error('缺少 pattern（正则表达式）')
  let re
  try {
    const fl = String(args.flags ?? 'g')
    re = new RegExp(pattern, fl.includes('g') ? fl : fl + 'g')
  } catch (e) {
    throw new Error('正则不合法：' + (e?.message ?? e))
  }
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500)
  const out = []
  let m
  let n = 0
  while ((m = re.exec(raw)) && n < limit) {
    n++
    const short = m[0].length > MAX_MATCH ? m[0].slice(0, MAX_MATCH) + '…' : m[0]
    let line = `${n}. ${short}`
    if (m.length > 1) {
      const gs = m.slice(1).map((g, i) => `g${i + 1}=${g === undefined ? '(空)' : g.length > MAX_MATCH ? g.slice(0, MAX_MATCH) + '…' : g}`)
      line += '\n   ' + gs.join(' | ')
    }
    if (m.groups) {
      const ng = Object.entries(m.groups).map(([k, g]) => `${k}=${g === undefined ? '(空)' : g}`)
      if (ng.length) line += '\n   ' + ng.join(' | ')
    }
    out.push(line)
    if (m[0] === '') re.lastIndex++ // 零宽匹配防死循环
  }
  if (!n) {
    return `没有匹配（pattern=${pattern}）。先确认文本里真的有目标内容，或放宽正则。`
  }
  let tail = ''
  if (n >= limit) tail = `\n…仅显示前 ${limit} 条（可用 limit 参数调大，上限 500）`
  return cut(out.join('\n') + tail)
}

const TOOLS = [
  {
    name: 'json_query',
    description:
      '从 JSON 按路径表达式取值。三个输入源任选其一：url（直接请求 JSON 接口，一步取数）、filePath（读本地文件）、text（直接给文本）。' +
      'path 语法：$.a.b[0].c，["键名"] 处理带点/中文的键，[*] 对数组逐项取值（如 $.[*].version 收集所有版本）。' +
      '路径未命中时会给出该层对象的键名提示，照提示改一次 path 即可。' +
      '**webfetch 拿到 JSON 后、或已知 JSON 接口地址时，一律优先用本工具取值，不要用 bash grep/sed 去啃压缩成单行的 JSON**——' +
      '那样截不准还得多轮重试。把整个 JSON 读进对话同样浪费，只取需要的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'JSON 接口地址（给 url 就不必先 webfetch）' },
        filePath: { type: 'string', description: '本地 JSON 文件路径' },
        text: { type: 'string', description: 'JSON 文本本体（短的时候直接给）' },
        path: { type: 'string', description: '路径表达式，如 $.packages["pkg/name"][0].version' },
        fallback: { type: 'string', description: '可选：路径未命中时返回这个兜底值' }
      }
    }
  },
  {
    name: 'regex_find',
    description:
      '用正则从文本里提取全部匹配（含分组，按行编号限量返回）。输入源同 json_query：url / filePath / text。' +
      '适合从普通文本（日志、HTML、清单）批量抽内容。**压缩成单行的 JSON 请改用 json_query**，不要用正则啃。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文本来源 URL' },
        filePath: { type: 'string', description: '本地文件路径' },
        text: { type: 'string', description: '文本本体' },
        pattern: { type: 'string', description: '正则表达式' },
        flags: { type: 'string', description: '正则 flags，默认 g' },
        limit: { type: 'number', description: '最多返回条数，默认 50，上限 500' }
      }
    }
  }
]

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
        serverInfo: { name: 'qingniao-data', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '')
    // 内核转发的是带前缀的全名（data_json_query），也容忍裸名
    const action = name.replace(/^data_/, '')
    const args = req.params?.arguments ?? {}
    try {
      if (action === 'json_query') {
        send({ jsonrpc: '2.0', id, result: okText(await jsonQuery(args)) })
      } else if (action === 'regex_find') {
        send({ jsonrpc: '2.0', id, result: okText(await regexFind(args)) })
      } else {
        send({ jsonrpc: '2.0', id, result: errText('未知工具：' + name) })
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: errText(String(e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})
