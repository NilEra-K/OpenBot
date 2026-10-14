/**
 * 图标圆角化 + 64 重建（2026-10-14，纯 Node 零依赖——PNG 解析/编码自持）：
 *  1) icon_64x64.png 从干净的 256 重建（生成器导出的 64 内部特征被压到 alpha≈45）；
 *  2) icons/src 全套按半径百分比做 SDF 抗锯齿圆角（边界 ±0.5px 线性过渡）；
 *  3) 刷新 resources/icons/icon.png（= 圆角 256）并重跑 make-ico.mjs。
 * 用法：node scripts/round-icon.mjs [半径百分比=22]
 * PNG 支持面：8bit RGBA 非隔行（本套图形态）；重编码统一 filter=0（体积换正确性）。
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { inflateSync, deflateSync, crc32 } from 'node:zlib'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RADIUS_PCT = Number(process.argv[2] ?? 22) / 100
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(APP_ROOT, 'resources', 'icons', 'src')
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 解析 PNG → { width, height, px(RGBA 连续缓冲) } */
const parsePng = (buf) => {
  let pos = 8
  let width = 0
  let height = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error(`仅支持 8bit RGBA 非隔行（得到 depth=${data[8]} color=${data[9]} interlace=${data[12]}）`)
      }
    } else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const px = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const rowOff = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowOff + x]
      const left = x >= 4 ? px[dst + x - 4] : 0
      const up = y > 0 ? px[dst - stride + x] : 0
      const ul = y > 0 && x >= 4 ? px[dst - stride + x - 4] : 0
      px[dst + x] =
        cur + (f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, ul))
    }
  }
  return { width, height, px }
}

/** 编码 PNG（filter 全 0；chunk + zlib.crc32） */
const encodePng = ({ width, height, px }) => {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  const chunk = (type, data) => {
    const c = Buffer.alloc(12 + data.length)
    c.writeUInt32BE(data.length, 0)
    c.write(type, 4, 'ascii')
    data.copy(c, 8)
    c.writeUInt32BE(crc32(Buffer.concat([c.subarray(4, 8 + data.length)])) >>> 0, 8 + data.length)
    return c
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** SDF 圆角裁 alpha：圆角矩形边界 ±0.5px 线性过渡，其余保持原 alpha */
const roundAlpha = (img, radiusRatio) => {
  const s = img.width
  const r = s * radiusRatio
  const half = s / 2
  const stride = s * 4
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const qx = Math.abs(x + 0.5 - half) - (half - r)
      const qy = Math.abs(y + 0.5 - half) - (half - r)
      const dist =
        Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, Math.max(qy, 0)), 0) - r
      const ai = y * stride + x * 4 + 3
      if (dist >= 0.5) img.px[ai] = 0
      else if (dist > -0.5) img.px[ai] = Math.round(img.px[ai] * (0.5 - dist))
    }
  }
  return img
}

/** 整数倍盒式降采样（预乘 alpha 平均——256→64 即 4×4 块均值） */
const downscale = (img, size) => {
  const k = img.width / size
  if (!Number.isInteger(k)) throw new Error(`非整数倍降采样：${img.width}→${size}`)
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = y * k; sy < (y + 1) * k; sy++) {
        for (let sx = x * k; sx < (x + 1) * k; sx++) {
          const i = (sy * img.width + sx) * 4
          const al = img.px[i + 3] / 255
          r += img.px[i] * al
          g += img.px[i + 1] * al
          b += img.px[i + 2] * al
          a += img.px[i + 3]
        }
      }
      const n = k * k
      const af = a / n
      const o = (y * size + x) * 4
      px[o + 3] = Math.round(af)
      if (af > 0) {
        px[o] = Math.round(r / (a / 255)) // 预乘逆除
        px[o + 1] = Math.round(g / (a / 255))
        px[o + 2] = Math.round(b / (a / 255))
      }
    }
  }
  return { width: size, height: size, px }
}

// ---- 主流程 ----
const src256 = parsePng(readFileSync(join(SRC, 'icon_256x256.png')))
const rebuilt64 = downscale(src256, 64)
writeFileSync(join(SRC, 'icon_64x64.png'), encodePng(rebuilt64))
console.log('[round] 64x64 已从 256 重建（预乘盒式 4×4 降采样）')

for (const f of [
  'icon_64x64.png',
  'icon_128x128.png',
  'icon_256x256.png',
  'icon_512x512.png',
  'icon_1024x1024.png',
  'icon_2048x2048.png',
]) {
  const p = join(SRC, f)
  const img = parsePng(readFileSync(p))
  roundAlpha(img, RADIUS_PCT)
  writeFileSync(p, encodePng(img))
  console.log(`[round] ${f} 半径 ${(img.width * RADIUS_PCT).toFixed(1)}px 完成`)
}

copyFileSync(join(SRC, 'icon_256x256.png'), join(APP_ROOT, 'resources', 'icons', 'icon.png'))
console.log('[round] resources/icons/icon.png 已刷新')

execSync('node make-ico.mjs', { cwd: dirname(fileURLToPath(import.meta.url)), stdio: 'inherit' })
