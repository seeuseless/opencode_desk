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
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

/**
 * 定位内核二进制。
 *
 * ⚠️ 文件名**不能按平台猜**（2026-09-22 mac CI 实测踩到，与 electron/main/index.ts
 *   的 opencodeBin() 是同一个坑，两处必须保持一致）：
 *   opencode-ai 的 postinstall.mjs 第 29 行把目标路径**写死**成 `bin/opencode.exe`——
 *   即使跑在 macOS / Linux 上也叫 `opencode.exe`（内容确实是 Mach-O / ELF，
 *   它靠 `fs.chmodSync(target, 0o755)` 使其可执行，后缀只是个名字）。
 *   所以「非 Windows 就叫 opencode」的推断是错的，会去找一个永不存在的文件，
 *   报「找不到 .../bin/opencode」——而被拦截的其实是一个**正常可用**的安装。
 *
 * 按存在性探测：优先 .exe（上游的既定命名），退回到无后缀
 * （万一将来上游改成平台化命名，这里不用跟着改）。
 */
function resolveKernel() {
  const dir = join(root, 'node_modules', 'opencode-ai', 'bin')
  const withExt = join(dir, 'opencode.exe')
  const noExt = join(dir, 'opencode')
  if (existsSync(withExt)) return withExt
  if (existsSync(noExt)) return noExt
  // 两个都没有：把 dir 下实际有什么打出来，便于一眼看出是"没装全"还是"命名变了"
  return withExt
}

const target = resolveKernel()
const exe = target.split(/[\\/]/).pop()

/** 仓库预置占位脚本的大小，明显偏小的一律视为未替换 */
const PLACEHOLDER_MAX_BYTES = 4096

function fail(msg, hint) {
  console.error('\n✗ 内核二进制校验失败：' + msg)
  if (hint) console.error('  ' + hint)
  console.error('\n  这一步是为了拦住"装完打不开"的包（用户侧表现为 `spawn UNKNOWN`）。')
  console.error('  修复：在项目根目录跑 `node node_modules/opencode-ai/postinstall.mjs`，')
  console.error('        或重新 `yarn install` 让 postinstall 正常执行。')
  // 把目录实况打出来：区分"根本没装全"与"文件名不是预期的那两个"
  // （2026-09-22 mac CI 就因为只打印一句"找不到"而多绕了一圈）
  try {
    const dir = join(root, 'node_modules', 'opencode-ai', 'bin')
    if (existsSync(dir)) {
      const names = readdirSync(dir)
      console.error(`\n  ${dir} 里实际有：${names.length ? names.join(', ') : '(空目录)'}`)
      for (const n of names) {
        try {
          console.error(`    · ${n}  ${statSync(join(dir, n)).size} 字节`)
        } catch {
          /* 单个文件读不到就跳过 */
        }
      }
    } else {
      console.error(`\n  ${dir} 这个目录都不存在 —— 依赖没装全。`)
    }
  } catch {
    /* 诊断信息拿不到就算了，不影响失败本身 */
  }
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
/**
 * 接受**任一**已知可执行格式，而不是按当前平台只认一种。
 *
 * 为什么不按平台判：打包时可能跨平台（CI 的 win job 与 mac job 跑的是同一份脚本），
 * 而且上游的文件名与平台并不一一对应（mac 上也叫 opencode.exe，见上方说明）。
 * 这里的目的只是「排除掉文本占位脚本与损坏产物」，不是做严格的目标平台校验——
 * 架构是否匹配由下面真正跑 `--version` 来兜底（跑不起来就 fail）。
 */
const isPE = magic[0] === 0x4d && magic[1] === 0x5a // "MZ" PE
const isELF = hx.startsWith('7f454c46')
const isMachO =
  hx.startsWith('cffaedfe') || // Mach-O 小端 64
  hx.startsWith('cafebabe') || // Mach-O fat
  hx.startsWith('feedface') // Mach-O 大端 32
const ok = isPE || isELF || isMachO

if (!ok) {
  fail(
    `${target} 的文件头不是可执行格式（首 4 字节 0x${hx}）。`,
    '它可能仍是文本脚本或损坏的下载产物。',
  )
}

// 真正跑一次，确认能执行（这才是"架构对不对"的最终判据）
try {
  const out = execFileSync(target, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim()
  const kind = isPE ? 'PE' : isELF ? 'ELF' : 'Mach-O'
  const hint = isWin && kind !== 'PE' ? ` ⚠️ 当前是 Windows 但二进制是 ${kind}` : ''
  console.log(
    `✓ 内核二进制可用：${exe}（${(size / 1024 / 1024).toFixed(1)}MB，${kind}）version=${out}${hint}`,
  )
} catch (err) {
  fail(
    `${target} 存在且像可执行文件，但跑 \`--version\` 失败：${err.message}`,
    '可能是架构不匹配（x64 / arm64）或文件被安全软件拦截。',
  )
}
