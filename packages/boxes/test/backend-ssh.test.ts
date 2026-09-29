/**
 * backend-ssh 测试（P8-1）：脚本化替身（CI 零 ssh 依赖）——断言远端命令构造（argv→远端 sh 串
 * 的单引号转义/env 前缀/cd 注入）、连接选项与 target 顺序、attach/teardown 语义（裁定 C）、
 * PTY/管道启动器的 argv 与会话接线、超时/中止传导。
 * 真机链路走 OPENBOT_TEST_SSH 门控套件（ssh-real.test.ts）——与 backend-oci 同一测试哲学。
 */
import { describe, expect, it } from 'vitest'
import { SshBoxBackend, buildRemoteScript, sshQuote } from '../src/backend-ssh/index.js'
import { BoxesErrorCodes } from '../src/types.js'
import type { ProcResult, ProcRunner, ProcSpec, PipeSpawner, ShellSpawner } from '../src/procexec/index.js'

const OK: ProcResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false }

/** 记录调用的替身执行器（默认全通） */
function scripted(impl?: (spec: ProcSpec) => ProcResult | Promise<ProcResult>): { run: ProcRunner; calls: ProcSpec[] } {
  const calls: ProcSpec[] = []
  const run: ProcRunner = async (spec) => {
    calls.push(spec)
    return impl ? await impl(spec) : OK
  }
  return { run, calls }
}

const last = (calls: ProcSpec[]): string[] => calls[calls.length - 1]?.command ?? []

const BASE = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10']

describe('SshBoxBackend（脚本化替身）', () => {
  it('caps 如实：persistent ✓（用户资产）/ snapshot ✗ / resourceLimits ✗ / isolation high / interactive ✓ / suspendable ✗', () => {
    const backend = new SshBoxBackend({ host: 'vm.local' })
    expect(backend.id).toBe('ssh')
    expect(backend.caps()).toEqual({
      persistent: true,
      snapshot: false,
      headless: true,
      resourceLimits: false,
      isolation: 'high',
      interactive: true,
      suspendable: false,
    })
  })

  it('boxId 由主机名净化派生（跨重启稳定；多 agent 复用同一载体）', async () => {
    const { run } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    const box = await backend.create({ image: 'default' })
    expect(box).toBe('ssh-vm.local')
    // IPv6 方括号/冒号等非安全字符 → '-'（方括号字面量建议进 host 串，这里只验净化不炸）
    const backend2 = new SshBoxBackend({ host: '[::1]', run })
    expect(await backend2.create({ image: 'default' })).toBe('ssh----1-')
  })

  it('create = attach（裁定 C）：连通验证 true → mkdir -p 工作目录 → 记账；幂等（二次 create 零往返）', async () => {
    const { run, calls } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run, workdir: '/work' })
    const box = await backend.create({ image: 'default', cpus: 2, memoryMb: 2048 })
    expect(box).toBe('ssh-vm.local')
    expect(calls[0]?.command).toEqual([...BASE, 'vm.local', 'true'])
    expect(calls[1]?.command).toEqual([...BASE, 'vm.local', `mkdir -p ${sshQuote('/work')}`])
    expect(calls).toHaveLength(2)
    // attach 幂等：已附着零网络往返；spec 仅记账（SSH 机器不从镜像创建——image 如实忽略）
    await expect(backend.create({ image: 'other' })).resolves.toBe('ssh-vm.local')
    expect(calls).toHaveLength(2)
  })

  it('create 连接选项变体：user@ / -p / -i 全在 destination 之前（destination 后的词进远端命令串）', async () => {
    const { run, calls } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', port: 2222, user: 'ops', keyPath: 'C:/keys/vm.pem', run })
    await backend.create({ image: 'default' })
    const expected = [
      'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
      '-p', '2222', '-i', 'C:/keys/vm.pem', 'ops@vm.local',
    ]
    expect(calls[0]?.command).toEqual([...expected, 'true'])
    expect(calls[1]?.command.slice(0, -1)).toEqual(expected)
  })

  it('create 连接失败抛 BOX_CREATE_FAILED（stderr 进 message）', async () => {
    const { run } = scripted(() => ({ ...OK, exitCode: 255, stderr: 'Permission denied (publickey)' }))
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await expect(backend.create({ image: 'default' })).rejects.toMatchObject({
      code: 'BOX_CREATE_FAILED',
      message: expect.stringContaining('Permission denied (publickey)'),
    })
  })

  it('exec：argv 单引号转义拼远端 sh 串（cd 前缀 + env K=前缀 + 全元素加引号——消灭词切分与 glob）', async () => {
    const { run, calls } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run, workdir: '/work' })
    await backend.create({ image: 'default' })
    await backend.exec('ssh-vm.local', {
      command: ['xdotool', 'key', 'Return'],
      cwd: '/tmp',
      env: { DISPLAY: ':0' },
    })
    expect(last(calls)).toEqual([
      ...BASE, 'vm.local',
      `cd ${sshQuote('/tmp')}; DISPLAY=${sshQuote(':0')} ${sshQuote('xdotool')} ${sshQuote('key')} ${sshQuote('Return')}`,
    ])
  })

  it('exec：无 cwd/env 时缺省工作目录；含空格/单引号/特殊字符的参数逐字保留（坑⑫同款转义）', async () => {
    const { run, calls } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await backend.create({ image: 'default' })
    await backend.exec('ssh-vm.local', { command: ['echo', "it's a  test$HOME"] })
    expect(last(calls)).toEqual([
      ...BASE, 'vm.local',
      `cd ${sshQuote('/work')}; ${sshQuote('echo')} ${sshQuote("it's a  test$HOME")}`,
    ])
    // 转义正确性对拍：shQuote 产物在远端 sh 语义下还原原文（单测锁形状，真机套件锁行为）
    expect(sshQuote("it's")).toBe(`'it'\\''s'`)
  })

  it('exec：timeoutMs/onChunk/signal 直传底层（流是实况，聚合是事实）', async () => {
    const chunks: string[] = []
    const { run, calls } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await backend.create({ image: 'default' })
    const controller = new AbortController()
    await backend.exec('ssh-vm.local', {
      command: ['tail', '-f', '/dev/null'],
      timeoutMs: 5_000,
      signal: controller.signal,
      onChunk: (c) => chunks.push(c.text),
    })
    expect(calls[2]?.timeoutMs).toBe(5_000) // create 占前两条（true + mkdir）
    expect(calls[2]?.signal).toBe(controller.signal)
    expect(calls[2]?.onChunk).toBeDefined()
  })

  it('exec 超时/中止语义：BOX_EXEC_TIMEOUT / BOX_EXEC_ABORTED（procexec 传导）', async () => {
    let mode: 'normal' | 'timeout' | 'abort' = 'normal'
    const { run } = scripted((spec) => {
      if (spec.command.at(-1) === 'true') return OK
      if (mode === 'timeout') return { ...OK, exitCode: null, timedOut: true }
      if (mode === 'abort') return { ...OK, exitCode: null, aborted: true }
      return OK
    })
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await backend.create({ image: 'default' })
    mode = 'timeout'
    await expect(backend.exec('ssh-vm.local', { command: ['x'] })).rejects.toMatchObject({ code: 'BOX_EXEC_TIMEOUT' })
    mode = 'abort'
    await expect(backend.exec('ssh-vm.local', { command: ['x'] })).rejects.toMatchObject({ code: 'BOX_EXEC_ABORTED' })
  })

  it('fsRead：cat -- 经同一构造点；exit 0 → stdout，否则 null', async () => {
    const { run, calls } = scripted((spec) =>
      spec.command.at(-1) === 'true' ? OK : { ...OK, stdout: 'vm-host\n' },
    )
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await backend.create({ image: 'default' })
    await expect(backend.fsRead('ssh-vm.local', '/etc/hostname')).resolves.toBe('vm-host\n')
    expect(last(calls)).toEqual([
      ...BASE, 'vm.local',
      `cd ${sshQuote('/work')}; ${sshQuote('cat')} ${sshQuote('--')} ${sshQuote('/etc/hostname')}`,
    ])
    const { run: runFail } = scripted((spec) =>
      spec.command.at(-1)?.includes("'cat'") ? { ...OK, exitCode: 1 } : OK, // create（true/mkdir）放行，只失败 cat
    )
    const backend2 = new SshBoxBackend({ host: 'vm.local', run: runFail })
    await backend2.create({ image: 'default' })
    await expect(backend2.fsRead('ssh-vm.local', '/nope')).resolves.toBeNull()
  })

  it('fsWrite：内容走 stdin（input=base64——绕 Windows 32K argv 上限）；失败抛 BOX_FS_WRITE_FAILED', async () => {
    const { run, calls } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await backend.create({ image: 'default' })
    await backend.fsWrite('ssh-vm.local', '/tmp/hi.txt', '你好 ssh')
    const call = calls[calls.length - 1]
    expect(call?.command).toEqual([
      ...BASE, 'vm.local',
      `base64 -d > ${sshQuote('/tmp/hi.txt')}`,
    ])
    expect(call?.input).toBe(Buffer.from('你好 ssh', 'utf8').toString('base64'))
    const { run: runFail } = scripted((spec) =>
      spec.command.at(-1)?.includes('base64 -d') ? { ...OK, exitCode: 1, stderr: 'cannot create' } : OK, // create 放行，只失败落盘
    )
    const backend2 = new SshBoxBackend({ host: 'vm.local', run: runFail })
    await backend2.create({ image: 'default' })
    await expect(backend2.fsWrite('ssh-vm.local', '/x', 'y')).rejects.toMatchObject({
      code: BoxesErrorCodes.BOX_FS_WRITE_FAILED,
    })
  })

  it('openShell：-tt 在 destination 之前 + stty 注入尺寸 + exec bash 接管；会话三向接线', async () => {
    const shells: string[][] = []
    const writes: string[] = []
    let killed = false
    const spawnShell: ShellSpawner = (command) => {
      shells.push(command)
      return {
        write: (t) => writes.push(t),
        onOutput: () => undefined,
        onExit: () => undefined,
        kill: () => {
          killed = true
        },
      }
    }
    const { run } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run, spawnShell })
    await backend.create({ image: 'default' })
    const session = await backend.openShell('ssh-vm.local', { cols: 120, rows: 40 })
    expect(shells[0]).toEqual([...BASE, '-tt', 'vm.local', 'stty rows 40 cols 120; exec bash'])
    let exited: number | null | undefined
    session.onExit((code) => {
      exited = code
    })
    session.write('echo hi\n')
    expect(writes).toEqual(['echo hi\n'])
    session.close()
    expect(killed).toBe(true)
    expect(exited).toBeUndefined() // close 不伪造退出——真实退出码来自进程
  })

  it('openPipe：-T 显式禁 PTY（二进制纯净）；env 注入同款；PipeSession 接线（write/close）', async () => {
    let pipeArgv: string[] = []
    let wrote: string[] = []
    let killed = false
    const spawnPipe: PipeSpawner = (command) => {
      pipeArgv = command
      return {
        onOutput: () => undefined,
        onExit: () => undefined,
        stderrTail: () => '',
        write: (t) => wrote.push(t),
        kill: () => {
          killed = true
        },
      }
    }
    const { run } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run, spawnPipe })
    await backend.create({ image: 'default' })
    const pipe = await backend.openPipe('ssh-vm.local', {
      command: ['sh', '-s', 'openbot-gui-input'],
      env: { DISPLAY: ':0' },
    })
    expect(pipeArgv).toEqual([
      ...BASE, '-T', 'vm.local',
      `cd ${sshQuote('/work')}; DISPLAY=${sshQuote(':0')} ${sshQuote('sh')} ${sshQuote('-s')} ${sshQuote('openbot-gui-input')}`,
    ])
    pipe.write('xdotool key Return\n')
    expect(wrote).toEqual(['xdotool key Return\n'])
    pipe.close()
    expect(killed).toBe(true)
  })

  it('teardown = 断开（裁定 C）：只清本侧记账、零远端命令；其后 exec 按BOX_NOT_FOUND 拒绝', async () => {
    const { run, calls } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await backend.create({ image: 'default' })
    await backend.teardown('ssh-vm.local')
    expect(calls).toHaveLength(2) // attach 的两条（true + mkdir）——teardown 雷新命令
    await expect(backend.list()).resolves.toEqual([])
    await expect(backend.exec('ssh-vm.local', { command: ['x'] })).rejects.toMatchObject({
      code: BoxesErrorCodes.BOX_NOT_FOUND,
    })
    await expect(backend.teardown('ssh-vm.local')).rejects.toMatchObject({
      code: BoxesErrorCodes.BOX_NOT_FOUND,
    })
  })

  it('list：附着后单实例 active（机器即 Box——多 agent 共享同一载体记账）；未附着空表', async () => {
    const { run } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run, now: () => 1234 })
    await expect(backend.list()).resolves.toEqual([])
    const box = await backend.create({ image: 'default' })
    await expect(backend.list()).resolves.toEqual([
      { boxId: box, spec: { image: 'default' }, state: 'active', createdAt: 1234 },
    ])
  })

  it('snapshot 无 per-Box 原语：BOX_UNSUPPORTED 如实拒绝（caps.snapshot=false 协议层兜底）；stats 如实空报告', async () => {
    const { run } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await backend.create({ image: 'default' })
    await expect(backend.snapshot('ssh-vm.local')).rejects.toMatchObject({ code: BoxesErrorCodes.BOX_UNSUPPORTED })
    await expect(backend.stats('ssh-vm.local')).resolves.toEqual({})
  })

  it('未附着（或外来 boxId）的一切操作按 BOX_NOT_FOUND 拒绝', async () => {
    const { run } = scripted()
    const backend = new SshBoxBackend({ host: 'vm.local', run })
    await expect(backend.exec('ssh-other', { command: ['x'] })).rejects.toMatchObject({
      code: BoxesErrorCodes.BOX_NOT_FOUND,
    })
  })
})

describe('buildRemoteScript（远端命令构造纯函数）', () => {
  it('cd 语句恒在（分号分隔——v0.1.39 修）；env 键不加引号、值加引号；空 argv 合法（仅 cd）', () => {
    expect(buildRemoteScript([], {}, '/work')).toBe(`cd ${sshQuote('/work')}`)
    expect(buildRemoteScript(['true'], { cwd: '/a b' }, '/work')).toBe(`cd ${sshQuote('/a b')}; ${sshQuote('true')}`)
    expect(buildRemoteScript(['sh', '-c', 'x'], { env: { A: '1', B: "q'z" } }, '/work')).toBe(
      `cd ${sshQuote('/work')}; A=${sshQuote('1')} B=${sshQuote("q'z")} ${sshQuote('sh')} ${sshQuote('-c')} ${sshQuote('x')}`,
    )
  })
})
