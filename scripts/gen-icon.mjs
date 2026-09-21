/* 生成应用图标：青鸟（lucide bird，ISC）+ 渐变蓝圆角底 → resources/image/icon.png / icon.ico */
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
console.log('icon.png / icon.ico done')
