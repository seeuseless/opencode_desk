/* 生成应用图标：青鸟（lucide bird，ISC）+ 渐变蓝圆角底
 *   → resources/image/icon.png  （Linux / 主进程 createWindow+createTray 运行时读）
 *   → resources/image/icon.ico  （Windows：electron-builder 的 win.icon）
 *   → resources/image/icon.icns （macOS：electron-builder 的 mac.icon）
 *
 * 三个格式都是**一次性生成、随仓库提交**的产物，改动图标后才需要重跑：
 *   node scripts/gen-icon.mjs
 * 它依赖 devDependency 的 sharp（纯构建期），不进安装包。
 */
import sharp from 'sharp'
import { writeFileSync, mkdirSync } from 'node:fs'

const PATHS = [
  'M16 7h.01',
  'M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20',
  'm20 7 2 .5-2 .5',
  'M10 18v3',
  'M14 17.75V21',
  'M7 18a6 6 0 0 0 3.84-10.61'
].map((d) => `<path d="${d}"/>`).join('')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3ec7ff"/>
      <stop offset="1" stop-color="#2f6fed"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#g)"/>
  <g transform="translate(64 64) scale(16)" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${PATHS}</g>
</svg>`

mkdirSync('resources/image', { recursive: true })

await sharp(Buffer.from(svg)).resize(512, 512).png().toFile('resources/image/icon.png')

/** 组装 PNG-in-ICO（Windows Vista+ 支持），多尺寸 */
function makeIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((en, i) => {
    const d = 6 + i * 16
    header.writeUInt8(en.size >= 256 ? 0 : en.size, d)
    header.writeUInt8(en.size >= 256 ? 0 : en.size, d + 1)
    header.writeUInt16LE(1, d + 2)
    header.writeUInt16LE(32, d + 4)
    header.writeUInt32LE(en.buf.length, d + 8)
    header.writeUInt32LE(offset, d + 12)
    offset += en.buf.length
  })
  return Buffer.concat([header, ...entries.map((e) => e.buf)])
}

const entries = []
for (const size of [16, 32, 48, 256]) {
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
  entries.push({ size, buf })
}
writeFileSync('resources/image/icon.ico', makeIco(entries))

/**
 * 组装 .icns（macOS 图标容器），供 electron-builder 的 mac 目标使用。
 *
 * 格式很简单：8 字节文件头（magic 'icns' + 总长度 BE）+ 若干块，
 * 每块 = 4 字节 type + 4 字节块长度(BE，含这 8 字节头) + 数据。
 * 数据部分**允许直接是 PNG**（macOS 10.7+ 支持），所以不需要 iconutil。
 *
 * ⚠️ 为什么手写而不是调 `iconutil`：CI 的 Windows runner 上没有 iconutil（那是 macOS 自带），
 *    而这个脚本在 Windows 上就要能跑（yarn dist 前置步骤）。手写 20 行换来跨平台一致，
 *    比"mac job 里另外跑一套生成逻辑"更不容易两边漂移。
 *
 * size → type 的映射是苹果固定枚举，别改：
 *   icp4=16  icp5=32  icp6=64  ic07=128  ic08=256  ic09=512  ic10=1024(512@2x)
 * mac 的 .icns 惯例要求提供 16~1024 全套，缺了 Finder/Dock 在对应场景就回落到默认图标。
 */
function makeIcns(entries) {
  const blocks = entries.map(({ type, buf }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(buf.length + 8, 4)
    return Buffer.concat([head, buf])
  })
  const body = Buffer.concat(blocks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

const icnsEntries = []
for (const [type, size] of [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
]) {
  const buf = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
  icnsEntries.push({ type, buf })
}
writeFileSync('resources/image/icon.icns', makeIcns(icnsEntries))
console.log('icon.png / icon.ico / icon.icns done')
