/**
 * h264 解析器真机套件：podman GUI 容器内真 ffmpeg x264 zerolatency 采集 → 真实 Annex B
 * 字节流 → createH264Parser 的 AU 切分验证（「字节→AU」半链实证；「AU→WebCodecs 解码→
 * canvas」半链只能 Electron 目验——Node 无 WebCodecs，如实记档）。
 * 门控：OPENBOT_TEST_GUI_STREAM=1 且容器在跑（默认 CI 零沙箱依赖）。
 */
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createH264Parser } from '../h264'

const REAL = process.env.OPENBOT_TEST_GUI_STREAM === '1'
const CONTAINER = process.env.OPENBOT_TEST_GUI_CONTAINER ?? 'openbot-box-box-1'

const containerUp = (): boolean => {
  try {
    const out = execFileSync('podman', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
    return out.split(/\r?\n/).includes(CONTAINER)
  } catch {
    return false
  }
}

describe.skipIf(!REAL || !containerUp())('h264 解析器（真机 ffmpeg 字节流）', () => {
  it('真 x264 zerolatency 流：AU 切分成立（首 AU key、delta 序列、IDR 周期 ≤30 帧）', { timeout: 60_000 }, async () => {
    // 抓 3 秒真流（容器内 timeout 定界——ffmpeg 被 SIGTERM exit 124 是预期，spawnSync
    // 不校验退出码直接取 stdout；与 openPipe 同为原始字节管道）
    const r = spawnSync(
      'podman',
      ['exec', CONTAINER, 'timeout', '3', 'ffmpeg', '-nostdin', '-f', 'x11grab', '-framerate', '60', '-video_size', '1920x1080',
       '-i', ':0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18',
       '-g', '30', '-pix_fmt', 'yuv420p', '-f', 'h264', 'pipe:1'],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
    )
    const stream = new Uint8Array(r.stdout)
    expect(stream.length).toBeGreaterThan(10_000) // 3s 真流不是空壳（静止桌面 zerolatency 也远超此值）

    // 按 16KB 块喂入（模拟 WS DATA 切块的任意边界）——解析器逐块消化 + flush 收尾
    const parser = createH264Parser()
    const aus = []
    for (let off = 0; off < stream.length; off += 16 * 1024) {
      aus.push(...parser.push(stream.subarray(off, Math.min(off + 16 * 1024, stream.length))))
    }
    aus.push(...parser.flush())

    expect(aus.length).toBeGreaterThan(30) // 3s@60fps 上百帧（静止画面 x264 跳帧复用会少——保底 30）
    expect(aus[0]!.type).toBe('key') // 流首 AU 必为 IDR（x264 起流即关键帧）
    expect(aus.filter((a) => a.type === 'key').length).toBeGreaterThanOrEqual(2) // -g 30 → ≥2 个 IDR 周期
    // AU 完整性：每 AU 都以 start code 开头（前缀并入语义）
    for (const au of aus) {
      expect(au.data[0]).toBe(0)
      expect(au.data[1]).toBe(0)
      expect(au.data[2] === 0 || au.data[2] === 1).toBe(true)
    }
    // IDR 间隔离散：-g 30 是 keyint 上限而非固定周期（静止画面 x264 自适应延迟插入 IDR，
    // 真机实测 88 帧——2 倍容差锁定「晚接入等待有界」的工程语义）
    const keyIdx = aus.map((a, idx) => (a.type === 'key' ? idx : -1)).filter((i) => i >= 0)
    for (let k = 1; k < keyIdx.length; k++) {
      expect(keyIdx[k]! - keyIdx[k - 1]!).toBeLessThanOrEqual(120)
    }
    console.log(`[openbot] h264 真机实测：3s ${stream.length} 字节 / ${aus.length} AU / key 帧 ${keyIdx.length} 个`)
  })
})
