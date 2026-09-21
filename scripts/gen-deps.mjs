/**
 * 生成第三方依赖快照 resources/deps.json（设置 → 依赖 页的数据源）。
 *
 * 为什么需要这份快照：打包时 electron-builder 的 files 只带上了运行时必需的
 * node_modules/qrcode-generator，其余依赖在装好的应用里根本读不到 package.json，
 * 界面上就会显示一堆「未知」协议。所以这里在**装依赖时**把每个包的真实版本号与
 * 真实协议拍一份下来，随安装包分发（见 electron-builder.yml 的 files）。
 *
 * 主进程运行时仍然**优先**读 node_modules（源码跑时永远是最新的），
 * 只在读不到时才回落到这份快照。
 *
 * 任何异常都吞掉：这一步只是给界面补充信息，绝不能把 npm/yarn install 弄失败。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 取包声明的协议：可能是字符串、{ type } 对象，或旧式的 licenses 数组 */
function licenseOf(pkg) {
  const raw = pkg?.license
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (raw && typeof raw === 'object' && typeof raw.type === 'string' && raw.type.trim()) return raw.type.trim()
  if (Array.isArray(pkg?.licenses)) {
    for (const one of pkg.licenses) {
      if (typeof one === 'string' && one.trim()) return one.trim()
      if (one && typeof one === 'object' && typeof one.type === 'string' && one.type.trim()) return one.type.trim()
    }
  }
  return ''
}

// 包没写 license 字段时（如 exif-parser），读包里的 LICENSE 文件开头认 SPDX
const SPDX_RULES = [
  [/Apache License/i, 'Apache-2.0'],
  [/Mozilla Public License/i, 'MPL-2.0'],
  [/\bISC\b/i, 'ISC'],
  [/\bMIT\b/i, 'MIT'],
  [/BSD[- ]?3|BSD 3-Clause/i, 'BSD-3-Clause'],
  [/BSD[- ]?2|BSD 2-Clause/i, 'BSD-2-Clause'],
  [/0BSD/i, '0BSD'],
  [/The Unlicense/i, 'Unlicense']
]
function sniffLicense(dir) {
  try {
    if (!existsSync(dir)) return ''
    const hit = readdirSync(dir).find((n) => /^licen[cs]e(\.|$)/i.test(n))
    if (!hit) return ''
    const head = readFileSync(join(dir, hit), 'utf8').slice(0, 4000)
    if (/General Public License/i.test(head)) return /Version\s*2\b/i.test(head) ? 'GPL-2.0' : 'GPL-3.0'
    if (/Lesser General Public License/i.test(head)) return /Version\s*2(\.1)?\b/i.test(head) ? 'LGPL-2.1' : 'LGPL-3.0'
    for (const [re, spdx] of SPDX_RULES) if (re.test(head)) return spdx
  } catch {
    /* 读不到就算了 */
  }
  return ''
}

try {
  const pkg = readJson(join(root, 'package.json'))
  if (!pkg) throw new Error('读不到 package.json')
  const items = []
  const collect = (deps, dev) => {
    for (const [name, range] of Object.entries(deps ?? {})) {
      const dir = join(root, 'node_modules', name)
      const inst = readJson(join(dir, 'package.json'))
      const version = typeof inst?.version === 'string' ? inst.version : String(range ?? '').replace(/^[\^~>=<v ]+/, '')
      const license = (inst ? licenseOf(inst) : '') || sniffLicense(dir) || '未知'
      items.push({ name, declared: String(range ?? ''), version, license, dev })
    }
  }
  collect(pkg.dependencies, false)
  collect(pkg.devDependencies, true)
  items.sort((a, b) => a.name.localeCompare(b.name))
  writeFileSync(
    join(root, 'resources', 'deps.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2) + '\n',
    'utf8'
  )
  console.log('[gen-deps] 已写入 resources/deps.json（' + items.length + ' 个依赖）')
} catch (e) {
  console.log('[gen-deps] 跳过：' + (e?.message ?? e))
}
