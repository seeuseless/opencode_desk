/**
 * electron-builder beforePack 钩子：交叉架构打包时把内核换成目标架构。
 *
 * 为什么需要（2026-09-25 补 mac Intel / Windows ARM64 支持）：
 *   extraResources 从 node_modules/opencode-ai/bin 取内核，而这个 bin 是
 *   opencode-ai 的 postinstall 按「当前安装机器」的平台+架构放的——在 Apple
 *   Silicon / x64 Windows 的 CI runner 上装完永远是本机架构内核。CI 一次要出
 *   双架构包，交叉架构那个包若直接用这个 bin，内核在目标机器上跑不起来
 *   （Electron 本体 electron-builder 会按 arch 自行下载，唯独 extraResources 里
 *   我们自己拷的内核不会换）。
 *
 * 处理规则：
 *   · 管 darwin / win32 / linux（三个发版平台），其他平台直接返回；
 *   · **无条件**按目标架构从对应平台包拷内核（不做"本机架构短路"）：
 *     CI 一条命令连打两个架构，哪个轮先跑没有保证——若本机架构轮短路不拷，
 *     交叉轮把 bin 换掉后，本机轮再打就会把错误架构的内核带进包（2026-09-25
 *     本地验证时 x64 轮后跑就复现了这个污染）。无条件拷贝则顺序无关、幂等。
 *     x64 一律选 baseline 版——安装包发布后要面对所有老机器，baseline 是兼容面
 *     最大的那个（支持 AVX2 的机器跑 baseline 只是少点指令优化），本机 dev 态
 *     不走打包，不受影响。平台包版本必须与 opencode-ai 对齐，由 release.yml
 *     构建前显式安装（os/cpu 不匹配的包 npm 装不上，得走 npm pack + tar 解压）。
 *
 * 用 .cjs 不用 .mjs：electron-builder 用 require() 式加载钩子文件（config.beforePack）。
 *
 * 时机：beforePack 在 extraResources 拷贝之前触发，这里覆盖的文件就是最终进包的文件。
 * 文件名事实（与 check-kernel.mjs / electron/main/index.ts 的 opencodeBin() 一致）：
 * 上游把目标路径写死成 bin/opencode.exe（mac / linux 上也叫这个名）；平台包内部则
 * Windows 叫 bin/opencode.exe、mac 与 linux 叫 bin/opencode（见 postinstall.mjs 的
 * sourceBinary）。
 */
const { copyFileSync, existsSync, chmodSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')

/**
 * context.arch 是 builder-util 的数字枚举（ia32=0 / x64=1 / armv7l=2 / arm64=3 /
 * universal=4），不是字符串——2026-09-25 踩坑：直接拼平台包名会得到
 * "opencode-darwin-3"，和 process.arch 比较也永远不等。数字/字符串两种都认，
 * 换版本的 electron-builder 若改回字符串枚举这里也不用动。
 */
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

/** electron-builder 平台名 → opencode 平台包前缀 + 包内二进制名 */
const PLATFORMS = {
  darwin: { pkg: 'darwin', inner: 'opencode' },
  win32: { pkg: 'windows', inner: 'opencode.exe' },
  // Linux（2026-10-08 加）：包内二进制叫 `opencode`（无后缀），与 darwin 同款。
  // 确认过 unpkg 的包元数据：opencode-linux-x64@1.18.33 只有 bin/opencode 一个文件。
  // 注意只出 **glibc** 版（包名无 -musl 后缀）；Alpine 用户暂不支持，见 README。
  linux: { pkg: 'linux', inner: 'opencode' },
}

module.exports = async function beforePack(context) {
  const platform = PLATFORMS[context.electronPlatformName]
  if (!platform) return
  const arch = ARCH_NAMES[context.arch] ?? context.arch

  const root = context.packager.projectDir
  const bin = join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
  const candidates =
    arch === 'x64'
      ? [`opencode-${platform.pkg}-x64-baseline`, `opencode-${platform.pkg}-x64`]
      : [`opencode-${platform.pkg}-${arch}`]
  const src = candidates
    .map((name) => join(root, 'node_modules', name, 'bin', platform.inner))
    .find(existsSync)

  if (!src) {
    throw new Error(
      `交叉打包缺内核平台包：${candidates.join(' / ')}（构建前先装对应版本，见 release.yml 的「安装 … 内核平台包」步骤）`,
    )
  }

  // 必须先 unlink 再拷贝，不能直接 copyFileSync 覆盖：postinstall 把 bin/opencode.exe
  // 从平台包**硬链接**过来（linkSync），就地写入等于写穿硬链接、把源平台包的二进制
  // 一起改掉；unlink 断开链接后 copy 生成新文件，平台包不受影响（重跑 postinstall 会
  // 自愈恢复硬链接）。
  // Windows 上 175MB 大文件常被实时杀毒短暂锁定（EBUSY/EPERM），指数退避重试几次。
  for (let attempt = 1; ; attempt++) {
    try {
      unlinkSync(bin)
    } catch {
      /* 不存在或暂时被锁，拷贝时若真有问题会再抛 */
    }
    try {
      copyFileSync(src, bin)
      break
    } catch (e) {
      const transient = e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code)
      if (!transient || attempt >= 5) throw e
      // 同步阻塞等待（钩子无异步调度可依赖）：500ms * attempt
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt)
      console.log(`[beforePack] 拷贝内核被暂时锁定（${e.code}），第 ${attempt} 次重试`)
    }
  }
  // copyFileSync 不保留源文件的权限位（目标按 umask 建），mac 上没 x 位主进程 spawn 不了
  chmodSync(bin, 0o755)
  console.log(`✓ [beforePack] 内核已切换为 ${arch}（源：${src}）`)
}
