#!/usr/bin/env node
/**
 * 确保 Electron 二进制真的存在——缺了就用国内镜像自动补装。
 *
 * 为什么要它：electron 包的 postinstall（下载 ~100MB 二进制并解压）很容易被网络
 * 问题或安装环境的文件保护机制打断，包本体装上了、dist/ 却是空的。此时
 * electron-vite 启动即报 `Error: Electron uninstall`，非常迷惑。挂在 postinstall
 * 链最前面：每次 yarn/npm install 后自检，缺了就补，不再让用户手动修。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const pkgDir = join(root, 'node_modules', 'electron')

// 各平台的可执行文件落点（electron 解压后应有其中之一）
const candidates =
  process.platform === 'win32'
    ? [join(pkgDir, 'dist', 'electron.exe')]
    : process.platform === 'darwin'
      ? [join(pkgDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')]
      : [join(pkgDir, 'dist', 'electron')]

if (candidates.some((p) => existsSync(p))) {
  console.log('[ensure-electron] Electron 二进制已就绪，跳过')
  process.exit(0)
}

console.log('[ensure-electron] 缺少 Electron 二进制，开始补装（npmmirror 镜像）…')
// 默认走国内镜像；CI/海外环境可用 ELECTRON_MIRROR 覆盖
const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
}
// 清掉注入的 NODE_OPTIONS：安装脚本要做批量文件解压/替换，别被本机 shim 拦住
delete env.NODE_OPTIONS
const r = spawnSync(process.execPath, [join(pkgDir, 'install.js')], { cwd: pkgDir, stdio: 'inherit', env })
if (r.status !== 0 || !candidates.some((p) => existsSync(p))) {
  console.error('[ensure-electron] 补装失败——检查网络后重跑 yarn install，或手动执行：')
  console.error('  cd node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js')
  process.exit(r.status ?? 1)
}
console.log('[ensure-electron] Electron 二进制补装完成')
