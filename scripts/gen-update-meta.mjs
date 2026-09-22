/**
 * 生成更新元数据 resources/update.json（主进程 updater.ts 读它）。
 *
 * 为什么单独放一份而不是让主进程直接读 package.json：
 * 打包后 package.json 被塞进 asar（electron-builder 的 files 里含 out/** 与 resources/**，
 * 根 package.json 由 electron-builder 自己注入到 asar 内），虽然 app.getVersion() 拿得到版本号，
 * 但**仓库坐标与 tag 前缀**这两个"发版约定"不该埋进源码里写死——
 * 将来换仓库、换 tag 命名（v0.1 → 0.1）时，只改这一个文件即可。
 *
 * 版本号刻意不从这里读：app.getVersion() 才是权威（它来自 electron-builder 注入的版本），
 * 两份都对不上的时候信安装包自己的。
 *
 * 任何异常都吞掉：这一步只补元数据，绝不能把 yarn install / 打包弄失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

try {
  const pkg = readJson(join(root, 'package.json'))
  if (!pkg) throw new Error('读不到 package.json')

  // homepage / repository 里挑一个能认出 owner/repo 的地址
  const raw = String(pkg.repository?.url ?? pkg.homepage ?? '')
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[#/]|$)/i.exec(raw)
  const repo = m ? `${m[1]}/${m[2]}` : 'seeuseless/opencode_desk'

  const out = {
    repo,
    // tag 前缀：本项目发版打 v0.1 / v1.0 这类 tag，比较版本号时要摘掉
    tagPrefix: 'v',
    // 版本号只作参考，主进程以 app.getVersion() 为准
    version: String(pkg.version ?? '0.0.0'),
    // ⚠️ 这里**不要**再写 `latestYml: 'latest.yml'`（2026-09-22 移除）：
    //   electron-builder.yml 设了 `publish: null`，electron-builder 从此**不再生成** latest.yml，
    //   而 CI 的上传步骤带 `fail_on_unmatched_files: true`，一旦列上它就会
    //   报 `Pattern 'dist/latest.yml' does not match any files` 并把已构建成功的 exe 一起丢掉。
    //   主进程侧 updater.ts 也从未消费这个字段（只解析、无使用点），属纯死元数据。
    //   将来若改用 electron-updater，那时再让 electron-builder 产出并上传 latest.yml。
    generatedAt: new Date().toISOString()
  }

  mkdirSync(join(root, 'resources'), { recursive: true })
  const file = join(root, 'resources', 'update.json')
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`[update-meta] 已写入 resources/update.json（repo=${repo} version=${out.version}）`)
} catch (e) {
  console.log('[update-meta] 跳过：' + (e?.message ?? e))
}
