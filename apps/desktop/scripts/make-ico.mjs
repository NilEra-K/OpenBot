/**
 * icon.ico 生成器（2026-10-14）：把 resources/icons/src 的 PNG 套图拼成多尺寸 ICO
 * （Vista+ 允许 ICO 内嵌 PNG 条目——electron-builder/rcedit 直接嵌入 exe，各尺寸取最近档）。
 * 用法：node scripts/make-ico.mjs（换图后重跑即可；档位改 ICON_SIZES）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ICON_SIZES = [64, 128, 256] // exe/开始菜单常用档；套图更小尺寸暂缺——系统从最近档缩放

const entries = ICON_SIZES.map((size) => {
  const png = readFileSync(join(APP_ROOT, 'resources', 'icons', 'src', `icon_${size}x${size}.png`))
  const w = png.readUInt32BE(16) // IHDR width
  const h = png.readUInt32BE(20) // IHDR height
  if (w !== size || h !== size) throw new Error(`icon_${size}x${size}.png 实际 ${w}x${h}，与文件名不符`)
  return { png, size }
})

// ICONDIR（6B）+ N × ICONDIRENTRY（16B）+ 顺序拼接的 PNG 数据
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: 1 = icon
header.writeUInt16LE(entries.length, 4)

let offset = 6 + entries.length * 16
const dirs = []
const blobs = []
for (const { png, size } of entries) {
  const dir = Buffer.alloc(16)
  const dim = size === 256 ? 0 : size // 256 记 0（ICO 单字节约定）
  dir.writeUInt8(dim, 0) // width
  dir.writeUInt8(dim, 1) // height
  dir.writeUInt8(0, 2) // palette 数（0 = 无调色板）
  dir.writeUInt8(0, 3) // reserved
  dir.writeUInt16LE(1, 4) // color planes
  dir.writeUInt16LE(32, 6) // bits per pixel
  dir.writeUInt32LE(png.length, 8) // 条目字节数
  dir.writeUInt32LE(offset, 12) // 数据偏移
  dirs.push(dir)
  blobs.push(png)
  offset += png.length
}

const out = join(APP_ROOT, 'resources', 'icons', 'icon.ico')
writeFileSync(out, Buffer.concat([header, ...dirs, ...blobs]))
console.log(`[make-ico] ${out} 已生成：${entries.map((e) => `${e.size}px/${(e.png.length / 1024).toFixed(0)}KB`).join(' + ')}`)
