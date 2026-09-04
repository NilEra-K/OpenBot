/**
 * backend openPipe 测试（plan-computer-use 二期）：二进制管道会话的 argv 锁定——
 * env 注入方言与各自 exec 同款（坑⑭ busybox env 无 `--` / 坑⑮ podman crun 无 `--`），
 * stdout 走 PipeSpawner 原始字节直出（PTY 文本链路会毁 jpeg——pipe 语义是二期定夺点）。
 * 与 backend-wsl/oci 的 scripted 替身同一测试哲学（mock 对称，ARCHITECTURE.md §6）。
 */
import { describe, expect, it } from 'vitest'
import { WslBoxBackend, WSL_BOX_PREFIX } from '../src/backend-wsl/index.js'
import { OciBoxBackend } from '../src/backend-oci/index.js'
import type { PipeSpawner } from '../src/procexec/index.js'
import type { ProcResult, ProcRunner, ProcSpec } from '../src/procexec/index.js'

const OK: ProcResult = { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false }

function scripted(impl: (spec: ProcSpec) => ProcResult): { run: ProcRunner; calls: ProcSpec[] } {
  const calls: ProcSpec[] = []
  const run: ProcRunner = async (spec) => {
    calls.push(spec)
    return impl(spec)
  }
  return { run, calls }
}

/** 管道进程替身：记录 argv 与 stdin 写入，close 触发 onExit（kill 转发语义与 spawnPipeProcess 一致） */
function fakePipeSpawner(spawned: string[][], writes: string[] = []): PipeSpawner {
  return (command) => {
    spawned.push(command)
    let exitForward: ((code: number | null) => void) | null = null
    return {
      onOutput: () => {},
      onExit: (cb) => {
        exitForward = cb
      },
      stderrTail: () => '',
      write: (text) => writes.push(text),
      kill: () => exitForward?.(null),
    }
  }
}

describe('openPipe（backend-wsl）', () => {
  it('argv 与 exec 同款：env 经 coreutils env 注入（无 -- 分隔符坑⑭）、Box 内命令在后；stdin 写入透传', async () => {
    const spawned: string[][] = []
    const writes: string[] = []
    const { run } = scripted((spec) => {
      if (spec.command.includes('--list')) return { ...OK, stdout: 'Ubuntu\r\n' }
      return OK
    })
    const backend = new WslBoxBackend({ rootfs: 'C:/r.tar.gz', dir: 'D:/WSL', run, spawnPipe: fakePipeSpawner(spawned, writes) })
    const box = await backend.create({ image: 'default' })
    const pipe = await backend.openPipe(box, { command: ['ffmpeg', '-f', 'x11grab', 'pipe:1'], env: { DISPLAY: ':0' } })
    expect(spawned).toEqual([
      ['wsl', '-d', `${WSL_BOX_PREFIX}box-1`, '--cd', '/work', '--', 'env', 'DISPLAY=:0', 'ffmpeg', '-f', 'x11grab', 'pipe:1'],
    ])
    // 注入通道语义（P0-1）：write 行式透传到进程 stdin（GUI 常驻 sh -s 的命令行）
    pipe.write('xdotool mousemove 10 20\n')
    expect(writes).toEqual(['xdotool mousemove 10 20\n'])
    // close 杀进程（幂等——二次 close 不抛）
    pipe.close()
    expect(() => pipe.close()).not.toThrow()
    // Box 不存在的领域错误
    await expect(backend.openPipe('box-9', { command: ['true'] })).rejects.toMatchObject({ code: 'BOX_NOT_FOUND' })
  })
})

describe('openPipe（backend-oci）', () => {
  it('argv 与 exec 同款：-e K=V 注入、-i 接 stdin（坑⑰——常驻 sh -s 注入通道的命门）、容器名在前命令在后（无 -- 坑⑮）', async () => {
    const spawned: string[][] = []
    const { run } = scripted((spec) => {
      if (spec.command.includes('ps')) {
        const name = spec.command[spec.command.indexOf('--filter') + 1]?.slice('name='.length) ?? ''
        return { ...OK, stdout: `${name}\tUp 2 hours\r\n` } // 容器在跑（自然唤醒直通）
      }
      return OK
    })
    const backend = new OciBoxBackend({ id: 'podman', cli: 'podman', run, spawnPipe: fakePipeSpawner(spawned) })
    const box = await backend.create({ image: 'default' })
    await backend.openPipe(box, { command: ['ffmpeg', '-nostdin'], env: { DISPLAY: ':0' } })
    expect(spawned).toEqual([
      ['podman', 'exec', '-i', '-w', '/work', '-e', 'DISPLAY=:0', 'openbot-box-box-1', 'ffmpeg', '-nostdin'],
    ])
  })
})
