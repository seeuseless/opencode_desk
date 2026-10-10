#!/usr/bin/env node
// 办公文件 MCP：读写 pdf / docx / pptx / xlsx 的独立 node 进程。
// 读取：extract 统一入口按扩展名分发（pdf 抠文字、docx 抽正文、xlsx 展开成表格文本、pptx 抽每页标题与要点）。
// 写入：write_docx / write_xlsx / write_pptx 分别生成对应文档；pdf 不做「从零生成」——纯文本 PDF 需要内嵌
// 中文字体（Helvetica 等标准字体不盖英文以外字符），改走 office_pdf 合并/拆分已有 PDF。
// 依赖（xlsx/docx/pptxgenjs/mammoth/jszip/pdf-lib/pdfjs-dist）随 extraResources 拷到 resources/node_modules，
// 本脚本紧挨着它 import，dev 用 resources/mcp/node_modules 同样就近解析。
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import XLSX from 'xlsx'
import { Document, Packer, HeadingLevel, Paragraph } from 'docx'
import pptxgen from 'pptxgenjs'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'

// PDF 文字提取需要 worker：脚本与 node_modules 毗邻（dev 在 resources/mcp、打包在 resources），
// 紧挨脚本的 node_modules 里就有随附的 worker，Node 里 pdfjs 用它起 worker_threads
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  fileURLToPath(new URL('./node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url))
).href

// ---------- 读取 ----------

/** 从 pptx 的 ppt/slides/slideN.xml 里抠出可读文本（a:t 的纯文本，含标题与要点） */
async function readPptx(buf) {
  const zip = await JSZip.loadAsync(buf)
  const slides = Object.keys(zip.files)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const n = (x) => Number(x.replace(/\D/g, ''))
      return n(a) - n(b)
    })
  const head = await zip.file('ppt/presentation.xml')?.async('string').catch(() => '')
  const out = []
  for (const k of slides) {
    const xml = await zip.file(k).async('string')
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1])
    if (!texts.some((t) => t.trim())) continue
    out.push((out.length ? '\n' : '') + `--- 第 ${out.length + 1} 页 ---\n` + texts.join('\n').replace(/\n+/g, '\n'))
  }
  return out.join('\n') || '（未在 PPT 中提取到文本，本演示可能是纯图片页）'
}

/** xlsx → 每个工作表展开成行列文本 */
async function readXlsx(path) {
  const wb = XLSX.readFile(path)
  const out = []
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false })
    out.push(`[工作表] ${name}`)
    // 空行跳过、整表压缩展示；行数多时截一部分防输出爆炸
    let shown = 0
    for (const row of rows) {
      if (!row.some((c) => String(c).trim() !== '')) continue
      if (shown >= 2000) {
        out.push('…（行过多已省略）')
        break
      }
      out.push(row.map((c) => String(c).includes('\t') ? `"${c}"` : String(c)).join('\t'))
      shown++
    }
  }
  return out.join('\n') || '（空工作簿）'
}

const MAX_EXTRACT = 40000
function cap(t) {
  return t.length > MAX_EXTRACT ? t.slice(0, MAX_EXTRACT) + `\n…（内容超长，已截断到 ${MAX_EXTRACT} 字）` : t
}

const TEXT_EXTS = {
  '.pdf': async (p) => {
    const data = new Uint8Array(readFileSync(p))
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise
    const n = doc.numPages
    let text = ''
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      // 按行聚拢词块：同一 y 坐标的片段拼成一行，换行在 y 变化处
      text += content.items.filter((it) => 'str' in it).map((it) => it.str).join(' ') + '\n'
    }
    return `PDF 共 ${n} 页\n` + text
  },
  '.docx': async (p) => {
    const r = await mammoth.extractRawText({ path: p })
    return r.value
  },
  '.doc': () => { throw new Error('旧版 .doc 不是开放格式，请先用 Word 另存为 .docx 再处理') },
  '.xlsx': readXlsx,
  '.xls': (p) => readXlsx(p),
  '.pptx': async (p) => readPptx(readFileSync(p))
}

async function officeExtract(path) {
  const p = resolve(path)
  const ext = extname(p).toLowerCase()
  if (ext === '.pdf' || ext === '.docx' || ext === '.doc' || ext === '.xlsx' || ext === '.xls' || ext === '.pptx') {
    const fn = TEXT_EXTS[ext]
    if (!fn) throw new Error(`暂不支持解析 ${ext} 文件`)
    return cap(await fn(p))
  }
  // 扩展名未知但内容是 zip（docx/xlsx/pptx 本质都是 zip）时按包内去向猜，兜底 pptx
  const head = readFileSync(p)
  if (head.length > 4 && head[0] === 0x50 && head[1] === 0x4b) {
    const low = p.toLowerCase()
    if (low.includes('.pptx') || low.includes('ppt/')) return cap(await readPptx(head))
    if (low.includes('.docx') || low.includes('/word/')) {
      const r = await mammoth.extractRawText({ path: p })
      return cap(r.value)
    }
    if (low.includes('.xlsx') || low.includes('/xl/')) return cap(await readXlsx(p))
    return cap(await readPptx(head))
  }
  throw new Error(`不是可识别的办公文件：${path}`)
}

// ---------- 写入 ----------

async function writeDocx(out, blocks) {
  const children = []
  const level = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3 }
  for (const b of blocks ?? []) {
    const text = String(b?.text ?? '')
    const type = b?.type || 'p'
    if (type === 'h1' || type === 'h2' || type === 'h3') {
      children.push(new Paragraph({ text, heading: level[type], spacing: { before: 240 } }))
    } else if (type === 'bullet') {
      children.push(new Paragraph({ text, bullet: { level: 0 } }))
    } else if (type === 'numbered') {
      children.push(new Paragraph({ text, numbering: { reference: 'default', level: 0 } }))
    } else {
      children.push(new Paragraph({ text, spacing: { after: 120 } }))
    }
  }
  const doc = new Document({ numbering: { config: [{ reference: 'default', levels: [{ level: 0, format: 'decimal', text: '%1.' }] }] }, sections: [{ children }] })
  writeFileSync(out, await Packer.toBuffer(doc))
  return `已生成 ${out}`
}

async function writeXlsx(out, sheets) {
  const wb = XLSX.utils.book_new()
  for (const s of sheets ?? []) {
    const rows = Array.isArray(s?.rows) ? s.rows : []
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), String(s?.name || 'Sheet1').slice(0, 31))
  }
  XLSX.writeFile(wb, out)
  return `已生成 ${out}`
}

async function writePptx(out, slides) {
  const pptx = new pptxgen()
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 })
  pptx.layout = 'WIDE'
  for (const s of slides ?? []) {
    const slide = pptx.addSlide()
    const topY = 0.4
    if (s?.title) {
      slide.addText(String(s.title), { x: 0.5, y: topY, w: 12.3, h: 0.9, fontSize: 28, bold: true, color: '1F3864' })
    }
    const bullets = Array.isArray(s?.bullets) ? s.bullets : Array.isArray(s?.body) ? s.body : []
    slide.addText(
      bullets.map((b) => ({ text: String(b), options: { bullet: { code: '2022' }, paraSpaceAfter: 8 } })),
      { x: 0.5, y: topY + 1.2, w: 12.3, h: 5.6, fontSize: 18, valign: 'top' }
    )
  }
  await pptx.writeFile({ fileName: out })
  return `已生成 ${out}`
}

async function officePdf(out, op, args) {
  if (op === 'merge') {
    const paths = args?.paths ?? []
    if (!paths.length) throw new Error('合并需要 paths 至少一个 PDF')
    const outDoc = await PDFDocument.create()
    for (const src of paths) {
      const d = await PDFDocument.load(readFileSync(resolve(src)))
      const pages = await outDoc.copyPages(d, d.getPageIndices())
      pages.forEach((p) => outDoc.addPage(p))
    }
    writeFileSync(out, await outDoc.save())
    return `已合并 ${paths.length} 个 PDF → ${out}`
  }
  if (op === 'split') {
    const src = args?.src
    if (!src) throw new Error('拆分需要 src 指定源 PDF')
    const d = await PDFDocument.load(readFileSync(resolve(src)))
    let pages = args?.pages
    if (!Array.isArray(pages) || !pages.length) pages = [[1, d.getPageCount()]]
    for (let i = 0; i < (args?.all ? d.getPageCount() : 1); i++) {
      if (args?.all) pages = pages.concat([[i + 1, i + 1]])
    }
    // pages = [[start,end], ...] 逐段切开分别存 <out 去扩展名>_#.pdf
    const base = out.replace(/\.pdf$/i, '')
    let n = 0
    for (const [s, e] of pages) {
      const doc = await PDFDocument.create()
      const idx = []
      for (let i = Math.max(1, Number(s)); i <= Math.min(d.getPageCount(), Number(e)); i++) idx.push(i - 1)
      const cp = await doc.copyPages(d, idx)
      cp.forEach((p) => doc.addPage(p))
      const part = `${base}_${++n}.pdf`
      writeFileSync(part, await doc.save())
    }
    return `已拆分为 ${n} 个 PDF → ${base}_1..${base}_${n}.pdf`
  }
  throw new Error(`未知的 PDF 操作：${op}（支持 merge / split）`)
}

// ---------- stdio JSON-RPC ----------

const TOOLS = [
  {
    name: 'extract',
    description: '读取办公/PDF 文件的文本内容。统一按扩展名识别：.docx→正文、.xlsx/.xls→每个工作表按行展开成表格文本、.pptx→每页标题与要点、.pdf→抽取文字。用户发来或项目里的办公文件要在动手改它之前先用它读内容。会超长的内容会自动截断并注明。',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '办公文件路径（绝对路径或相对项目目录路径）' } }, required: ['path'] }
  },
  {
    name: 'write_docx',
    description: '生成 Word .docx 文档。blocks 为有序内容块，type 支持 h1/h2/h3（标题）、p（段落）、bullet（圆点）、numbered（编号）；正文写成纯文本即可，代码/表格也可用 p 表达。',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string', description: '输出 .docx 路径' },
        blocks: { type: 'array', description: '内容块数组', items: { type: 'object', properties: { type: { type: 'string', description: 'h1|h2|h3|p|bullet|numbered' }, text: { type: 'string' } } } }
      },
      required: ['out', 'blocks']
    }
  },
  {
    name: 'write_xlsx',
    description: '生成 Excel .xlsx。sheets 为工作表数组，每项 { name?, rows }，rows 是二维数组（首行可为表头）。单元格值统一填成原始数据类型或字符串即可。',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string' },
        sheets: { type: 'array', description: '工作表数组', items: { type: 'object', properties: { name: { type: 'string' }, rows: { type: 'array' } } } }
      },
      required: ['out', 'sheets']
    }
  },
  {
    name: 'write_pptx',
    description: '生成 PowerPoint .pptx 演示文稿。slides 为页数组，每项 { title?, bullets? }，bullets 为该页要点列表。',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string' },
        slides: { type: 'array', description: '幻灯片数组', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } } } }
      },
      required: ['out', 'slides']
    }
  },
  {
    name: 'pdf_utils',
    description: 'PDF 结构处理（不重新排版）：merge 合并多个 PDF，split 按页拆分。op 为 merge 时用 paths；为 split 时用 src + pages。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', description: 'merge | split' },
        out: { type: 'string', description: '输出 PDF 路径（split 时会把分段存为 <out 去掉 .pdf>_1.pdf、_2.pdf…）' },
        paths: { type: 'array', items: { type: 'string' }, description: 'merge：待合并的 PDF 路径列表' },
        src: { type: 'string', description: 'split：源 PDF 路径' },
        pages: { type: 'array', description: 'split：要切出的页段 [[start,end],…]（1 起）' }
      },
      required: ['op', 'out']
    }
  }
]

const okText = (t) => ({ content: [{ type: 'text', text: t }] })
const errText = (t) => ({ content: [{ type: 'text', text: t }], isError: true })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function dispatch(action, args) {
  switch (action) {
    case 'extract': return okText(await officeExtract(String(args.path ?? '')))
    case 'write_docx': return okText(await writeDocx(resolve(String(args.out ?? '')), args.blocks))
    case 'write_xlsx': return okText(await writeXlsx(resolve(String(args.out ?? '')), args.sheets))
    case 'write_pptx': return okText(await writePptx(resolve(String(args.out ?? '')), args.slides))
    case 'pdf_utils': return okText(await officePdf(resolve(String(args.out ?? '')), String(args.op ?? ''), args))
    default: throw new Error(`未知工具：${action}`)
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method } = req
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'office-files', version: '1.0.0' }
      }
    })
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  } else if (method === 'tools/call') {
    const name = String(req.params?.name ?? '').replace(/^office_/, '')
    try {
      const r = await dispatch(name, req.params?.arguments ?? {})
      send({ jsonrpc: '2.0', id, result: r })
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: errText('办公文件处理失败：' + (e?.message ?? e)) })
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } })
  }
})