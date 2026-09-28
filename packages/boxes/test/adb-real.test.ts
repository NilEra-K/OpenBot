/**
 * Android 真机门控套件（plan-screen-firstclass P9-3b）：adb → 设备端 EncodedCommand 全链
 * 实证——exec/env/fs/截屏/注入（input 真实触屏）/screenrecord h264 流。
 * 门控：OPENBOT_TEST_ADB=1 且 OPENBOT_TEST_ADB_HOST（序列号或 wifi 地址）在场（默认 CI 零
 * 依赖——ssh-real 同哲学）。注入子套件另需 OPENBOT_TEST_ADB_GUI=1（会真实触控目标设备）。
 * 设备要求：USB 调试开启（或 adb tcpip 5555）；目标设备零预装。
 */
import { describe, expect, it } from 'vitest'
import { AdbBoxBackend } from '../src/backend-adb/index.js'
import { AdbScreenControl } from '../src/screen/adb.js'

const REAL = process.env.OPENBOT_TEST_ADB === '1' && !!process.env.OPENBOT_TEST_ADB_HOST
const GUI = REAL && process.env.OPENBOT_TEST_ADB_GUI === '1'
const HOST = process.env.OPENBOT_TEST_ADB_HOST ?? ''

const backend = () => new AdbBoxBackend({ host: HOST, now: Date.now })

describe.skipIf(!REAL)('Android 真机基础链（OPENBOT_TEST_ADB=1）', () => {
  it('attach + exec（POSIX 包装/退出码/工作目录）+ env + fs 往返', async () => {
    const b = backend()
    const boxId = await b.create({ image: 'adb-real' })
    expect(boxId).toContain('adb-')
    const cwd = await b.exec(boxId, { command: ['sh', '-c', 'echo $PWD'], timeoutMs: 20_000 })
    expect(cwd.stdout.trim()).toBe('/data/local/tmp/openbot')
    const env = await b.exec(boxId, { command: ['sh', '-c', 'echo $OPENBOT_TEST_VAR'], timeoutMs: 20_000, env: { OPENBOT_TEST_VAR: 'hello-adb' } })
    expect(env.stdout.trim()).toBe('hello-adb')
    const content = '你好 Android\n'.repeat(200)
    await b.fsWrite(boxId, '/data/local/tmp/openbot/roundtrip.txt', content)
    await expect(b.fsRead(boxId, '/data/local/tmp/openbot/roundtrip.txt')).resolves.toBe(content)
    await b.teardown(boxId)
    expect(await b.list()).toEqual([])
  })
})

describe.skipIf(!GUI)('Android 真机注入/截屏/流全链（OPENBOT_TEST_ADB_GUI=1——会真实触控设备）', () => {
  it('几何 + 截屏 + 注入往返实测 + screenrecord 帧率实测', async () => {
    const b = backend()
    const boxId = await b.create({ image: 'adb-real' })
    const screen = new AdbScreenControl({ host: b, execTimeoutMs: 20_000 })
    const geo = await screen.geometry(boxId)
    expect(geo).not.toBeNull()
    const cap = await screen.capture(boxId)
    expect(cap.mime).toBe('image/png')
    expect(cap.bytes.length).toBeGreaterThan(1000)
    // 注入往返实测（act 单动作 exec 往返）
    const t0 = Date.now()
    await screen.act(boxId, { kind: 'click', button: 1, x: Math.round((geo?.width ?? 1080) / 2), y: Math.round((geo?.height ?? 2400) / 2) })
    console.log(`[adb-real] 注入往返实测：${Date.now() - t0}ms（tap 单动作，含几何查询与 exec 往返）`)
    // screenrecord h264 流：帧字节持续到达
    const s = await screen.stream(boxId, { codec: 'h264' })
    expect(s.codec).toBe('h264')
    const bytes: number[] = []
    s.onData((chunk) => bytes.push(chunk.length))
    await new Promise((r) => setTimeout(r, 3_000))
    console.log(`[adb-real] 实况流实测：3s 窗口 ${bytes.length} 个 chunk（h264raw 字节流——fps 由设备编码器决定）`)
    expect(bytes.length).toBeGreaterThanOrEqual(2)
    s.close()
    await b.teardown(boxId)
  }, 60_000)
})
