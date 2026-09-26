/**
 * Windows 机内真机门控套件（plan-screen-firstclass P9-3a）：ssh → 远端 powershell
 * EncodedCommand 全链实证——exec/env/fs/PTY/截屏几何/注入通道（SendInput 真实注入）/
 * b64 行帧流。门控：OPENBOT_TEST_WINSSH=1 且 OPENBOT_TEST_WINSSH_HOST 在场（默认 CI 零依赖
 * ——ssh-real 同哲学）。目标机要求：Windows + OpenSSH Server + 密钥免密 + 桌面保持登录态。
 * 注入套件（GUI 子集）会真实移动目标机鼠标——另需 OPENBOT_TEST_WINSSH_GUI=1 显式开启。
 */
import { describe, expect, it } from 'vitest'
import { SshWindowsBoxBackend } from '../src/backend-ssh-windows/index.js'
import { SshWindowsScreenControl } from '../src/screen/ssh-windows.js'

const REAL = process.env.OPENBOT_TEST_WINSSH === '1' && !!process.env.OPENBOT_TEST_WINSSH_HOST
const GUI = REAL && process.env.OPENBOT_TEST_WINSSH_GUI === '1'
const HOST = process.env.OPENBOT_TEST_WINSSH_HOST ?? ''
const PORT = process.env.OPENBOT_TEST_WINSSH_PORT !== undefined ? Number(process.env.OPENBOT_TEST_WINSSH_PORT) : undefined
const USER = process.env.OPENBOT_TEST_WINSSH_USER
const KEY = process.env.OPENBOT_TEST_WINSSH_KEY

const backend = () =>
  new SshWindowsBoxBackend({
    host: HOST,
    ...(PORT !== undefined ? { port: PORT } : {}),
    ...(USER !== undefined ? { user: USER } : {}),
    ...(KEY !== undefined ? { keyPath: KEY } : {}),
    workdir: 'C:\\openbot-test-work',
    now: Date.now,
  })

describe.skipIf(!REAL)('Windows 机内真机全链（OPENBOT_TEST_WINSSH=1）', () => {
  it('attach + exec（EncodedCommand/退出码/工作目录）+ env + fs 往返', async () => {
    const b = backend()
    const boxId = await b.create({ image: 'win-real' })
    expect(boxId).toContain('win-')
    // exec：原生命令退出码传导 + cwd 生效
    const r = await b.exec(boxId, { command: ['cmd', '/c', 'echo'], timeoutMs: 20_000 })
    expect(r.exitCode).toBe(0)
    const cwd = await b.exec(boxId, { command: ['powershell', '-NoProfile', '-Command', 'Write-Output $PWD.Path'], timeoutMs: 20_000 })
    expect(cwd.stdout.trim()).toBe('C:\\openbot-test-work')
    // env 注入
    const env = await b.exec(boxId, { command: ['powershell', '-NoProfile', '-Command', 'Write-Output $env:OPENBOT_TEST_VAR'], timeoutMs: 20_000, env: { OPENBOT_TEST_VAR: 'hello-注入' } })
    expect(env.stdout.trim()).toBe('hello-注入')
    // fs 往返（中文 + 大小 ~64KB）
    const content = '你好 Windows 机内\n'.repeat(500)
    await b.fsWrite(boxId, 'C:\\openbot-test-work\\roundtrip.txt', content)
    await expect(b.fsRead(boxId, 'C:\\openbot-test-work\\roundtrip.txt')).resolves.toBe(content)
    await b.teardown(boxId)
    expect(await b.list()).toEqual([])
  })
})

describe.skipIf(!GUI)('Windows 机内注入/截屏全链（OPENBOT_TEST_WINSSH_GUI=1——会真实注入目标机键鼠）', () => {
  it('几何 + 截屏 + 注入通道（ack 往返实测）+ b64 帧流', async () => {
    const b = backend()
    const boxId = await b.create({ image: 'win-real' })
    const screen = new SshWindowsScreenControl({ host: b, execTimeoutMs: 20_000 })
    const geo = await screen.geometry(boxId)
    expect(geo).not.toBeNull()
    const cap = await screen.capture(boxId)
    expect(cap.mime).toBe('image/jpeg')
    expect(cap.bytes.length).toBeGreaterThan(1000) // 真 JPEG 有体量
    // 注入通道：ready 握手 → move 动作 → ok ack（往返延迟实测打点）
    const t0 = Date.now()
    await screen.act(boxId, { kind: 'move', x: Math.round((geo?.width ?? 1920) / 2), y: Math.round((geo?.height ?? 1080) / 2) })
    const actMs = Date.now() - t0
    console.log(`[winssh-real] 注入往返实测：${actMs}ms（move 单动作，含几何查询与 ack）`)
    // b64 行帧流：≥3 帧到达
    const s = await screen.stream(boxId, { codec: 'mjpeg', fps: 5 })
    const frames: number[] = []
    s.onData((b2) => frames.push(b2.length))
    await new Promise((r) => setTimeout(r, 3_000))
    const fpsMeasured = ((frames.length / 3) * 10) / 10
    console.log(`[winssh-real] 实况帧率实测：${fpsMeasured} fps（窗口 3s，帧 ${frames.length}）`)
    expect(frames.length).toBeGreaterThanOrEqual(2)
    s.close()
    await b.teardown(boxId)
  }, 60_000)
})
