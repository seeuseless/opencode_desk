#!/usr/bin/env node
/**
 * 生成 computer-use-mcp 的**自包含副本**到 resources/mcp/cu-mcp/node_modules/。
 *
 * 为什么需要它：screen-mcp.mjs 底下要 spawn computer-use-mcp。靠 `npx -y` 现拉有两个致命问题——
 *  1. 即便命中 npx 缓存也要 ~8 秒才吐第一行，内核启动时的 MCP 握手等不了这么久，
 *     computer-use 会被直接判启动失败（「开了桌面控制却没有截屏/点击/输入」）；
 *  2. 打包后的用户机器**多半没装 Node.js**，npx 根本不存在——裸 spawn npx 在 Windows 上
 *     还是 npx.cmd，不套 shell 直接 ENOENT，连"执行安装"这一步都走不到。
 *
 * 所以把 computer-use-mcp 连同其生产依赖整树装进 resources/mcp/cu-mcp/node_modules/：
 *  - dev：主进程 builtinComputerUseMcp() 的候选 3 命中它；
 *  - 打包：electron-builder extraResources 把它平铺到 resources/cu-mcp（候选 1）。
 * 开箱即用、完全离线，npx 只是最后的兜底。
 *
 * 何时跑：`yarn dist` / `yarn dist:mac` 的第一步（package.json 里已接线）。
 * 产物不入 git（见 .gitignore），换 computer-use-mcp 版本后重跑一次即可。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'resources', 'mcp', 'cu-mcp')
const registry = process.env.QN_NPM_REGISTRY || 'https://registry.npmmirror.com'

// computer-use-mcp 装在项目根 devDependencies 里，版本号以它为准（单一事实来源）
const pkgJson = join(root, 'node_modules', 'computer-use-mcp', 'package.json')
if (!existsSync(pkgJson)) {
  console.error('[prepare-cu-mcp] 项目根 node_modules 里没有 computer-use-mcp——先 yarn install 再跑本脚本')
  process.exit(1)
}
const version = JSON.parse(readFileSync(pkgJson, 'utf8')).version

// 幂等：同版本已生成过就直接跳过，dist 流程里反复跑也不拖时间
const targetEntry = join(target, 'node_modules', 'computer-use-mcp', 'package.json')
if (existsSync(targetEntry)) {
  const installed = JSON.parse(readFileSync(targetEntry, 'utf8')).version
  if (installed === version) {
    console.log(`[prepare-cu-mcp] ${version} 已就绪，跳过（${target}）`)
    process.exit(0)
  }
  console.log(`[prepare-cu-mcp] 版本变化 ${installed} → ${version}，重新生成`)
  rmSync(target, { recursive: true, force: true })
}

mkdirSync(target, { recursive: true })
// 独立的 package.json：在这里 npm install --omit=dev，得到一棵不含任何 devDep 的自包含依赖树
writeFileSync(
  join(target, 'package.json'),
  JSON.stringify({ name: 'qingniao-cu-mcp-bundle', private: true, dependencies: { 'computer-use-mcp': version } }, null, 2)
)

console.log(`[prepare-cu-mcp] 安装 computer-use-mcp@${version} → ${target}`)
const r = spawnSync(
  'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund', `--registry=${registry}`],
  { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' }
)
if (r.status !== 0) {
  console.error('[prepare-cu-mcp] npm install 失败，清理半成品')
  rmSync(join(target, 'node_modules'), { recursive: true, force: true })
  process.exit(r.status ?? 1)
}

// 校验产物：入口文件必须真的存在，否则打包后照样回落 npx，等于白干
const entry = join(target, 'node_modules', 'computer-use-mcp', 'dist', 'main.js')
if (!existsSync(entry)) {
  console.error(`[prepare-cu-mcp] 入口不存在：${entry}——上游包结构变了，检查 dist/main.js 路径`)
  process.exit(1)
}
console.log('[prepare-cu-mcp] 完成：' + entry)
