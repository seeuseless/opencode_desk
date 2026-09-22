/**
 * 打包前校验 OpenCode 内核二进制是真货（不是占位 shim）。
 *
 * 为什么必须有这一步（2026-09-22 踩坑，用户装完启动报 `spawn UNKNOWN`）：
 *   opencode-ai 的 package.json 里 `bin.opencode` 指向 `./bin/opencode.exe`，
 *   但**仓库里预置的那个文件只有 479 字节，是个 shell 斥退占位脚本**：
 *     echo "Error: opencode-ai's postinstall script was not run." >&2
 *     exit 1
 *   真正的二进制（Windows 上约 172MB）由 opencode-ai 的 postinstall.mjs 在安装后
 *   从平台包（opencode-windows-x64 / -baseline 等）**硬链接或拷贝**到 bin/ 下覆盖它。
 *
 *   electron-builder.yml 的 extraResources 从 `node_modules/opencode-ai/bin` 取文件，
 *   一旦 postinstall 没生效（CI 上 --ignore-scripts、postinstall 失败、离线装不上平台包…），
 *   就会**把那个 479B 的占位脚本原样打进安装包**。用户装上后主进程 spawn 它 → 
 *   `spawn UNKNOWN`（不是 ENOENT，因为文件确实存在，只是根本不是可执行程序），
 *   而且报错信息完全看不出根因，极难排查。
 *
 *   gen-deps / gen-update-meta 那两个脚本刻意吞掉所有异常（它们只补元数据，
 *   不该弄挂构建）；**本脚本相反：必须在坏的时候让构建立刻失败**，
 *   宁可不出包，也不能出一个装完打不开的包。
 *
 * 校验三条：
 *   1) 文件存在，且不是仓库预置的占位脚本（按大小 + 首两字节判断）
 *   2) 是 PE 可执行（Windows 上首两字节 "MZ"；mac/linux 上检查 ELF / Mach-O）
 *   3) 能跑起来：执行 `--version` 拿到版本号
 */
import { execFileSync } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const exe = isWin ? 'opencode.exe' : 'opencode'
const target = join(root, 'node_modules', 'opencode-ai', 'bin', exe)

/** 仓库预置占位脚本的大小，明显偏小的一律视为未替换 */
const PLACEHOLDER_MAX_BYTES = 4096

function fail(msg, hint) {
  console.error('\n✗ 内核二进制校验失败：' + msg)
  if (hint) console.error('  ' + hint)
  console.error('\n  这一步是为了拦住"装完打不开"的包（用户侧表现为 `spawn UNKNOWN`）。')
  console.error('  修复：在项目根目录跑 `node node_modules/opencode-ai/postinstall.mjs`，')
  console.error('        或重新 `yarn install` 让 postinstall 正常执行。')
  process.exit(1)
}

if (!existsSync(target)) {
  fail(
    `找不到 ${target}`,
    '依赖可能没装全，先跑 yarn install。',
  )
}

const size = statSync(target).size
if (size <= PLACEHOLDER_MAX_BYTES) {
  fail(
    `${target} 只有 ${size} 字节，是未替换的占位脚本而非真二进制。`,
    'opencode-ai 的 postinstall 没有生效——它本该把平台包里的 ~172MB 真二进制放过来。',
  )
}

// 读首字节判断可执行格式
const fd = openSync(target, 'r')
const magic = Buffer.alloc(4)
readSync(fd, magic, 0, 4, 0)
closeSync(fd)

const hx = magic.toString('hex')
const ok =
  isWin
    ? magic[0] === 0x4d && magic[1] === 0x5a // "MZ" PE
    : hx.startsWith('7f454c46') || // ELF
      hx.startsWith('cffaedfe') || // Mach-O 小端 64
      hx.startsWith('cafebabe') // Mach-O fat

if (!ok) {
  fail(
    `${target} 的文件头不是可执行格式（首 4 字节 0x${hx}）。`,
    '它可能仍是文本脚本或损坏的下载产物。',
  )
}

// 真正跑一次，确认能执行
try {
  const out = execFileSync(target, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim()
  console.log(`✓ 内核二进制可用：${exe}（${(size / 1024 / 1024).toFixed(1)}MB）version=${out}`)
} catch (err) {
  fail(
    `${target} 存在且像可执行文件，但跑 \`--version\` 失败：${err.message}`,
    '可能是架构不匹配（x64 / arm64）或文件被安全软件拦截。',
  )
}
