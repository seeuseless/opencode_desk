/**
 * postinstall:
 * 1) 在 macOS 上把 opencode-ai 原生二进制加可执行位（npm optional dep 安装后常缺 x）
 * 2) 从 resources/icon.png 生成 resources/icon.icns（mac 打包需要；Windows 跳过）
 *
 * 任何一步失败都静默（不影响 Windows 安装）。
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { platform } = process

function ok(msg) {
  console.log('[postinstall] ' + msg)
}

// 1) chmod opencode bin
if (platform === 'darwin') {
  const binDir = path.join(__dirname, '..', 'node_modules', 'opencode-ai', 'bin')
  if (fs.existsSync(binDir)) {
    try {
      execSync(`chmod +x "${binDir}"/*`, { stdio: 'ignore' })
      ok('opencode bin chmod +x 完成')
    } catch {
      ok('chmod opencode bin 失败（忽略）')
    }
  }
}

// 2) 生成 icns（仅当缺失且 icon.png 存在）
const resources = path.join(__dirname, '..', 'resources')
const icns = path.join(resources, 'icon.icns')
const png = path.join(resources, 'icon.png')
if (fs.existsSync(icns)) {
  ok('icon.icns 已存在，跳过')
} else if (fs.existsSync(png) && platform === 'darwin') {
  // macOS 上 sips + iconutil 生成 .icns（mac 打包需要）
  try {
    const iconset = path.join(resources, 'icon.iconset')
    fs.rmSync(iconset, { recursive: true, force: true })
    fs.mkdirSync(iconset, { recursive: true })
    // sips 生成 1024×1024，拷贝成 iconutil 需要的两个尺寸命名
    execSync(`sips -z 1024 1024 "${png}" --out "${iconset}/icon_512x512@2x.png" >/dev/null`, { stdio: 'ignore' })
    execSync(`cp "${iconset}/icon_512x512@2x.png" "${iconset}/icon_512x512.png"`, { stdio: 'ignore' })
    execSync(`iconutil -c icns "${iconset}" -o "${icns}"`, { stdio: 'ignore' })
    fs.rmSync(iconset, { recursive: true, force: true })
    ok('icon.icns 已生成（sips + iconutil）')
  } catch (e) {
    ok('生成 icon.icns 失败：' + e.message + '（可手动: sips -z 1024 1024 resources/icon.png 后 iconutil 生成）')
  }
} else if (!fs.existsSync(icns) && fs.existsSync(png)) {
  ok('icon.icns 缺失且当前非 macOS；mac 打包前请在 Mac 上先跑一次 npm install 自动生成')
}
