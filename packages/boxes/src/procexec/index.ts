/**
 * 子进程执行底座：wsl.exe / docker / podman CLI 共用。
 * 两类语义分开：runProcess 是有界执行（超时 kill——zombie 契约：执行必须有界）；
 * spawnShellProcess 是无界交互（PTY 会话——边界是用户亲手关闭，退出走回调不走 Promise）。
 * 解码契约：命令输出默认 utf8 字节直传（Linux 侧进程输出是 UTF-8）；
 * wsl.exe 自身元信息输出（--list/--status）是 UTF-16LE，由调用方指定 encoding。
 * 参考：docs/platforms.md 地雷（wsl.exe UTF-16LE）、ARCHITECTURE.md §6 CLI 即接口。
 */
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

export interface ProcChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

export interface ProcSpec {
  /** argv 数组直传（不走 shell，无注入面） */
  command: string[]
  cwd?: string
  env?: Record<string, string>
  /** 超时 ms——到点 kill 子进程并置 timedOut（后端必须尊重 ExecSpec.timeoutMs 的传导） */
  timeoutMs?: number
  /** 输出解码；默认 'utf8'。wsl.exe 元信息用 'utf16le' */
  encoding?: 'utf8' | 'utf16le'
  /** 流式回调；聚合结果仍完整返回（流是实况，聚合是事实） */
  onChunk?: (chunk: ProcChunk) => void
}

export interface ProcResult {
  /** null = 被 signal 终止（超时或外部 kill） */
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 可注入的执行器类型（测试注入替身；默认 runProcess） */
export type ProcRunner = (spec: ProcSpec) => Promise<ProcResult>

/** 可执行文件不存在等 spawn 失败（上层 probe 依赖此语义判定「CLI 未安装」） */
export function isSpawnFailure(err: unknown): err is Error {
  return err instanceof Error && err.name === 'ProcSpawnError'
}

const runProcess: ProcRunner = (spec) =>
  new Promise<ProcResult>((resolve, reject) => {
    const file = spec.command[0]
    if (file === undefined) throw new Error('procexec: command 不能为空')
    const args = spec.command.slice(1)
    const options: SpawnOptions = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    if (spec.cwd !== undefined) options.cwd = spec.cwd
    if (spec.env !== undefined) options.env = { ...process.env, ...spec.env }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, options)
    } catch (err) {
      const e = new Error(`进程启动失败：${file}`, { cause: err })
      e.name = 'ProcSpawnError'
      reject(e)
      return
    }

    // WHATWG TextDecoder 标签是 'utf-16le'（带连字符）；对外 API 名保持 'utf16le'（Node 习惯）
    const decoderLabel = spec.encoding === 'utf16le' ? 'utf-16le' : 'utf8'
    const decoders = {
      stdout: new TextDecoder(decoderLabel),
      stderr: new TextDecoder(decoderLabel),
    }
    const acc = { stdout: '', stderr: '' }
    let timedOut = false
    let settled = false

    // spawn 的 error 事件（ENOENT 等）可能在 exit 之前或之后；只认第一个终态
    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const e = new Error(`进程启动失败：${file}`, { cause: err })
      e.name = 'ProcSpawnError'
      reject(e)
    })

    const collect = (name: 'stdout' | 'stderr'): void => {
      // stdio 配置为 pipe,运行时必非空;类型上判空防御
      const stream = child[name]
      if (!stream) return
      stream.on('data', (buf: Buffer) => {
        // TextDecoder stream 模式：正确处理多字节字符跨块
        const text = decoders[name].decode(buf, { stream: true })
        acc[name] += text
        spec.onChunk?.({ stream: name, text })
      })
    }
    collect('stdout')
    collect('stderr')

    const timer =
      spec.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true
            child.kill()
          }, spec.timeoutMs)
        : null

    child.on('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // flush 解码器残留（流内最后一块不完整多字节序列在此收敛）
      resolve({
        exitCode,
        signal,
        stdout: acc.stdout + decoders.stdout.decode(),
        stderr: acc.stderr + decoders.stderr.decode(),
        timedOut,
      })
    })
  })

export { runProcess }

// ---------------------------------------------------------------------------
// 长驻交互进程（PTY 会话底座）：stdin 可写、输出流式解码、退出回调
// ---------------------------------------------------------------------------

/** 长驻交互进程句柄（backend.openShell 的进程底座；注入替身可测 argv 与转发） */
export interface ShellProcess {
  /** 键入直写 stdin */
  write(text: string): void
  /** 输出增量（stdout/stderr 合流，UTF-8 跨块收敛） */
  onOutput(cb: (text: string) => void): void
  /** 进程退出（exit / 被杀 / spawn 失败均为 code|null） */
  onExit(cb: (code: number | null) => void): void
  /** 杀进程（幂等） */
  kill(): void
}

/** 可注入的交互进程启动器（默认 spawnShellProcess；测试注入替身断言 argv） */
export type ShellSpawner = (command: string[]) => ShellProcess

/** spawn 长驻交互进程：无超时、无聚合（与 runProcess 的有界语义相反） */
export function spawnShellProcess(command: string[]): ShellProcess {
  const file = command[0]
  if (file === undefined) throw new Error('procexec: command 不能为空')
  const child = spawn(file, command.slice(1), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = new TextDecoder('utf8')
  const outputCbs = new Set<(text: string) => void>()
  const exitCbs = new Set<(code: number | null) => void>()
  let exited = false
  const finish = (code: number | null): void => {
    if (exited) return
    exited = true
    const rest = decoder.decode() // flush 多字节残留
    if (rest !== '') for (const cb of outputCbs) cb(rest)
    for (const cb of exitCbs) cb(code)
  }
  const feed = (buf: Buffer): void => {
    const text = decoder.decode(buf, { stream: true })
    if (text !== '') for (const cb of outputCbs) cb(text)
  }
  child.stdout?.on('data', feed)
  // 交互会话 stderr 是 script 自身错误（罕见）——合流喂输出不分流（PTY 语义本就单流）
  child.stderr?.on('data', feed)
  child.on('close', (code) => finish(code))
  child.on('error', () => finish(null)) // spawn 失败（ENOENT 等）：close 可能不再触发
  return {
    write(text) {
      if (!child.stdin?.destroyed) child.stdin?.write(text)
    },
    onOutput(cb) {
      outputCbs.add(cb)
    },
    onExit(cb) {
      exitCbs.add(cb)
    },
    kill() {
      child.kill()
    },
  }
}
