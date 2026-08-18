// tools/gen-icon.mjs —— 生成托盘图标（零依赖：手写 PNG 编码）
// 视觉母版同源：强调色 #EEB154 + 墨色 #17181C 的「O」徽标
// 用法：node tools/gen-icon.mjs  →  apps/desktop/resources/icon.png
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const S = 32 // 尺寸
const R = 9 // 圆角半径
const ACCENT = [238, 177, 84]
const INK = [23, 24, 28]

const half = S / 2
const inner = half - R
const inRound = (x, y) => {
  const dx = Math.abs(x - half)
  const dy = Math.abs(y - half)
  return (
    dx <= half && dy <= half &&
    (dx <= inner || dy <= inner || (dx - inner) ** 2 + (dy - inner) ** 2 <= R * R)
  )
}
const inCircle = (x, y, r) => (x - half) ** 2 + (y - half) ** 2 <= r * r

// RGBA 位图
const px = new Uint8Array(S * S * 4)
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const c = !inRound(x + 0.5, y + 0.5) ? [0, 0, 0, 0]
      : inCircle(x + 0.5, y + 0.5, 8.5) ? [...INK, 255]
      : [...ACCENT, 255]
    px.set(c, i)
  }
}

// PNG 编码：IHDR + IDAT（filter 0 逐行）+ IEND
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr.set([8, 6, 0, 0, 0], 8) // bitDepth 8 · colorType 6(RGBA)
const raw = Buffer.concat(
  Array.from({ length: S }, (_, y) =>
    Buffer.concat([Buffer.from([0]), Buffer.from(px.subarray(y * S * 4, (y + 1) * S * 4))])),
)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'resources', 'icon.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
console.log('icon written:', out, png.length, 'bytes')
