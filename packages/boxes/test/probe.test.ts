/**
 * probe 测试（P5 Step 6）：三探测替身单测——ProcRunner 注入（与 backend 同哲学）。
 * 锁定语义：probePodman 的 machine 运行态判定（实测样本：podman 6.0.1，machine 从未启动时
 * exit 0 + Running:false——`podman info` 探不出运行态是收紧动机）与 probeDocker 的
 * Engine 运行态校验（docker info Server 段，exit 非 0 = Engine 停止带指引）。
 */
import { describe, expect, it } from 'vitest'
import { parseMachineList, probeDocker, probePodman, probeWsl } from '../src/probe/index.js'
import type { ProcResult, ProcRunner, ProcSpec } from '../src/procexec/index.js'

const OK: ProcResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false }

/** 固定应答替身（按命令首词路由） */
const respond = (impl: Record<string, ProcResult | Promise<ProcResult>>): ProcRunner => async (spec: ProcSpec) => {
  const head = spec.command[0]
  const hit = head !== undefined ? impl[head] : undefined
  if (hit === undefined) throw new Error(`替身未覆盖命令：${spec.command.join(' ')}`)
  return hit
}

/** podman 6.0.1 实测样本（machine 从未启动——LastUp 零值、Running:false） */
const MACHINE_STOPPED = `[
    {
        "Name": "podman-machine-default",
        "Default": true,
        "Created": "2026-07-15T15:14:29.7526842+08:00",
        "Running": false,
        "Starting": false,
        "LastUp": "0001-01-01T00:00:00Z",
        "Stream": "default",
        "VMType": "hyperv",
        "CPUs": 14,
        "Memory": "2147483648",
        "Swap": "0",
        "DiskSize": "107374182400",
        "Port": 49479,
        "RemoteUsername": "core",
        "UserModeNetworking": true
    }]`

describe('parseMachineList（纯函数）', () => {
  it('实测样本：machine 从未启动 → 单条 running=false', () => {
    expect(parseMachineList(MACHINE_STOPPED)).toEqual([{ name: 'podman-machine-default', running: false }])
  })

  it('运行中样本与多 machine 数组', () => {
    expect(parseMachineList('[{"Name":"m1","Running":true}]')).toEqual([{ name: 'm1', running: true }])
    expect(parseMachineList('[{"Name":"a","Running":false},{"Name":"b","Running":true}]')).toEqual([
      { name: 'a', running: false },
      { name: 'b', running: true },
    ])
  })

  it('空数组（尚无 machine）是合法输出；损坏/非数组/字段异常 → null', () => {
    expect(parseMachineList('[]')).toEqual([])
    expect(parseMachineList('')).toBeNull()
    expect(parseMachineList('Error response from podman machine')).toBeNull()
    expect(parseMachineList('{"Name":"x","Running":true}')).toBeNull() // 非数组
    expect(parseMachineList('[{"Name":42,"Running":true}]')).toBeNull() // 字段类型异常
    expect(parseMachineList('[{"Name":"x","Running":"yes"}]')).toBeNull()
  })
})

describe('probePodman（machine 运行态校验）', () => {
  it('任一 machine Running:true → available', async () => {
    const run = respond({ podman: { ...OK, stdout: '[{"Name":"m","Running":true}]' } })
    await expect(probePodman(run)).resolves.toEqual({ id: 'podman', available: true })
  })

  it('实测样本（Running:false，exit 0）→ 不可用，指引 machine start（exit 0 探不出运行态的证据）', async () => {
    const run = respond({ podman: { ...OK, stdout: MACHINE_STOPPED } })
    await expect(probePodman(run)).resolves.toMatchObject({
      id: 'podman',
      available: false,
      reason: expect.stringContaining('podman machine start'),
    })
  })

  it('空数组 → 不可用，指引 machine init；输出损坏 → 不可用如实报解析失败', async () => {
    const run = respond({ podman: { ...OK, stdout: '[]' } })
    await expect(probePodman(run)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('machine init'),
    })
    const bad = respond({ podman: { ...OK, stdout: 'not json' } })
    await expect(probePodman(bad)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('无法解析'),
    })
  })

  it('exit 非 0 带退出码与 stderr；CLI 未装（ProcSpawnError）→ 未安装指引', async () => {
    const run = respond({ podman: { ...OK, exitCode: 125, stderr: 'machine list failed' } })
    await expect(probePodman(run)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('125'),
    })
    const spawnFail: ProcRunner = () =>
      Promise.reject(Object.assign(new Error('spawn podman ENOENT'), { name: 'ProcSpawnError' }))
    await expect(probePodman(spawnFail)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('未安装或不在 PATH'),
    })
  })
})

describe('probeDocker / probeWsl（收紧后语义回归）', () => {
  it('docker info exit 0 → available；exit 非 0（Engine 停止）→ 不可用带指引（Step 5 收紧语义）', async () => {
    const run = respond({
      docker: { ...OK, stdout: '27.3.1' },
      wsl: { ...OK, stdout: '' },
    })
    await expect(probeDocker(run)).resolves.toEqual({ id: 'docker', available: true })
    const stopped = respond({
      docker: { ...OK, exitCode: 1, stderr: 'Cannot connect to the Docker daemon' },
      wsl: { ...OK, stdout: '' },
    })
    await expect(probeDocker(stopped)).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining('Docker Engine 未运行'),
    })
  })

  it('探测命令如实下探（docker info Server 段 / wsl --status utf16le）', async () => {
    const seen: ProcSpec[] = []
    const run: ProcRunner = async (spec) => {
      seen.push(spec)
      return OK
    }
    await probeDocker(run)
    await probeWsl(run)
    expect(seen[0]?.command).toEqual(['docker', 'info', '--format', '{{.ServerVersion}}'])
    expect(seen[1]?.command).toEqual(['wsl', '--status'])
    expect(seen[1]?.encoding).toBe('utf16le')
  })
})
