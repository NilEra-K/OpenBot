/**
 * adb 发现/配对测试（plan-screen-firstclass P9-3c）：devices -l 解析（坏行跳过）、
 * 配对二维码 WIFI:S:..;P:..;; 解析、pair/connect 的 argv 与结果判定（ProcRunner 替身）。
 */
import { describe, expect, it } from 'vitest'
import { AdbDiscovery, parseAdbDevices, parsePairingQr } from '../src/backend-adb/discovery.js'

describe('parseAdbDevices（devices -l 解析）', () => {
  it('USB / wifi / mDNS 别名 / 坏行混合——坏行跳过不拖累清单', () => {
    const out = parseAdbDevices(
      [
        'List of devices attached',
        'R58NXXXXXX           device product:raven model:Pixel_6',
        '192.168.31.141:38579  device product:missi model:M2012K11AC',
        'adb-24c4c05c-ya3fi9._adb-tls-connect._tcp device usb:337641472X product:missi model:M2012K11AC',
        'FAKE-1                offline',
        'FAKE-2                unauthorized',
        '（空行/半行）',
        '',
      ].join('\n'),
    )
    expect(out).toEqual([
      { serial: 'R58NXXXXXX', state: 'device', product: 'raven', model: 'Pixel_6' },
      { serial: '192.168.31.141:38579', state: 'device', product: 'missi', model: 'M2012K11AC' },
      { serial: 'adb-24c4c05c-ya3fi9._adb-tls-connect._tcp', state: 'device', product: 'missi', model: 'M2012K11AC' },
      { serial: 'FAKE-1', state: 'offline', product: '', model: '' },
      { serial: 'FAKE-2', state: 'unauthorized', product: '', model: '' },
    ])
  })
})

describe('parsePairingQr（配对面板二维码内容）', () => {
  it('WIFI:S:服务名;P:码;; 解析；他格式 null（回退手动表单）', () => {
    expect(parsePairingQr('WIFI:S:adb-24c4c05c-YA3FI9._adb-tls-pairing._tcp;P:455194;;')).toEqual({
      service: 'adb-24c4c05c-YA3FI9._adb-tls-pairing._tcp',
      code: '455194',
    })
    expect(parsePairingQr('https://example.com')).toBeNull()
    expect(parsePairingQr('WIFI:S:x;P:y;')).toBeNull() // 缺尾分号
  })
})

describe('AdbDiscovery（ProcRunner 替身——argv 锁死）', () => {
  const make = () => {
    const calls: Array<{ argv: string[] }> = []
    const result = { exitCode: 0, stdout: '', stderr: '' }
    const run = (async (spec: { command: string[] }) => {
      calls.push({ argv: spec.command })
      return { ...result, timedOut: false, aborted: false }
    }) as never
    return { calls, result, run }
  }

  it('listDevices：devices -l + 解析透传', async () => {
    const { calls, result, run } = make()
    result.stdout = 'List of devices attached\nR58N device product:p model:M\n'
    const d = new AdbDiscovery({ run })
    await expect(d.listDevices()).resolves.toEqual([{ serial: 'R58N', state: 'device', product: 'p', model: 'M' }])
    expect(calls[0]!.argv[1]).toBe('devices')
    expect(calls[0]!.argv[2]).toBe('-l')
  })

  it('pair：mDNS 服务名 / ip:port 双形态同一命令面；成功 null / 失败取结论行', async () => {
    const { calls, result, run } = make()
    result.stdout = 'Successfully paired to 192.168.31.141:37547 [guid=adb-xxx]'
    const d = new AdbDiscovery({ run })
    await expect(d.pair('adb-xxx._adb-tls-pairing._tcp', '455194')).resolves.toBeNull()
    expect(calls[0]!.argv[1]).toBe('pair')
    expect(calls[0]!.argv[2]).toBe('adb-xxx._adb-tls-pairing._tcp')
    expect(calls[0]!.argv[3]).toBe('455194')
    result.exitCode = 1
    result.stdout = ''
    result.stderr = 'failed to pair to 192.168.31.141:37537:\x0a\terror: closed'
    await expect(d.pair('192.168.31.141:37537', '000000')).resolves.toBe('error: closed')
  })

  it('connect：成功（connected to）/ 失败（cannot connect ... 结论行）', async () => {
    const { calls, result, run } = make()
    result.stdout = 'connected to 192.168.31.141:38579'
    const d = new AdbDiscovery({ run })
    await expect(d.connect('192.168.31.141:38579')).resolves.toBeNull()
    expect(calls[0]!.argv[1]).toBe('connect')
    result.exitCode = 1
    result.stdout = 'cannot connect to 192.168.31.141:42419: 由于目标计算机积极拒绝 (10061)'
    await expect(d.connect('192.168.31.141:42419')).resolves.toContain('10061')
  })
})
