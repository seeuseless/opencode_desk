/**
 * 编译青鸟平台服务端（Go）到 server/bin，供 electron-builder 的 extraResources 收进安装包。
 *
 * 为什么单独一个脚本：桌面端是「本地一体化」的——服务端要随安装包一起到用户机器上，
 * 主进程启动时自动拉起（见 client/electron/main/server.ts）。所以打包前必须先有二进制。
 *
 * 失败策略：**不让打包失败**。开发机上没装 Go 时照样能出包（只是安装包里没有服务端，
 * 用户自己起一份或用在线平台都能用）。CI 上装了 Go，出的是完整包。
 *
 * 交叉编译：electron-builder 的 arch flag 决定目标架构，这里按 process.arch 编。
 * CI 一次出双架构包时，beforePack 钩子已经会为每个架构各跑一次，所以这里不用自己判断。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = join(root, '..', 'server')
const outDir = join(serverDir, 'bin')

const isWin = process.platform === 'win32'
const binName = isWin ? 'qingniao-server.exe' : 'qingniao-server'

function log(msg) {
  console.log('[build-server] ' + msg)
}

function main() {
  if (!existsSync(join(serverDir, 'go.mod'))) {
    log('找不到 server/go.mod，跳过服务端编译')
    return
  }

  // 目标二进制名：主进程 server.ts 的 serverBin() 优先找 .exe，退回到无后缀
  const target = join(outDir, binName)
  const alt = join(outDir, isWin ? 'qingniao-server' : 'qingniao-server.exe')

  try {
    mkdirSync(outDir, { recursive: true })
    // 清掉另一下架构的产物，别把两个架构的二进制一起塞进包
    if (existsSync(alt)) rmSync(alt)

    log(`编译 ${binName}（${process.platform}/${process.arch}）…`)
    execFileSync('go', ['build', '-ldflags=-s -w', '-o', target, './cmd/server'], {
      cwd: serverDir,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0' }
    })
    log('完成：' + target)
  } catch (e) {
    // 没装 Go 或编译失败都不阻断打包
    log('编译失败（不影响打包，安装包里将不含服务端）：' + (e?.message ?? e))
  }
}

main()
