/**
 * mock 后端：全链路 CI 确定性跑通的地基，与 llm 的 mock 对称（接口完全一致）。
 * 行为全部内存化、id 与时间全注入——exec 调用序列可断言，模拟失败可编排。
 * 参考：ARCHITECTURE.md §6「mock 对称」。
 */
import { KernelError } from '@openbot/core'
import { BoxesErrorCodes } from '../types.js'
import type {
  BoxBackend,
  BoxCaps,
  BoxId,
  BoxInstance,
  BoxSpec,
  BoxStats,
  ExecResult,
  ExecSpec,
  PipeSession,
  PipeSpec,
  ShellOpenOptions,
  ShellSession,
  SnapshotId,
  SnapshotInfo,
} from '../types.js'

/** mock 的诚实能力：功能全「假装 ✓」（矩阵见 ARCHITECTURE.md §6），隔离强度如实为 low */
export const MOCK_BOX_CAPS: BoxCaps = {
  persistent: true,
  snapshot: true,
  headless: true,
  resourceLimits: true,
  isolation: 'low',
  // 回显式假终端（openShell 同步实现）——E2E 全链路可测，CI 零沙箱依赖不动摇
  interactive: true,
  // 休眠状态机对称（P4 Step 8）：内存态置位/复位，E2E 可断言
  suspendable: true,
}

/** 一次 exec 的留痕（断言「runner 让沙箱跑了什么」） */
export interface MockExecCall {
  boxId: BoxId
  spec: ExecSpec
  at: number
}

/** 一次 openPipe 的留痕（断言「GUI 流让沙箱跑了什么 argv」——与 exec 留痕同哲学） */
export interface MockPipeCall {
  boxId: BoxId
  spec: PipeSpec
  at: number
}

export interface MockBoxBackendOptions {
  now?: () => number
  nextBoxId?: () => BoxId
  /** 自定义 exec 行为；默认 exit 0、stdout = 'mock: <command>' */
  exec?: (boxId: BoxId, spec: ExecSpec) => ExecResult | Promise<ExecResult>
  /** 自定义 openPipe 行为；缺省返回静默常驻会话（记录调用、零输出——
   *  假 ffmpeg 流由装配层注入：E2E 传周期吐帧的实现，断言帧到达与切流） */
  pipe?: (boxId: BoxId, spec: PipeSpec) => PipeSession
  /** 整包覆盖 stats 确定值（缺省 {cpu 12/mem 256/disk 1200}）——E2E 色档高值档位的注入面（P5 Step 7） */
  stats?: BoxStats
}

interface MockBox {
  spec: BoxSpec
  state: BoxInstance['state']
  createdAt: number
  files: Map<string, string>
}

/** mock 快照记录（P4 Step 9）：files 深拷贝——回滚可验证「内容恢复到快照点」 */
interface MockSnapshot {
  snapshotId: SnapshotId
  boxId: BoxId
  createdAt: number
  files: Map<string, string>
}

export class MockBoxBackend implements BoxBackend {
  readonly id = 'mock'
  readonly #now: () => number
  readonly #nextBoxId: () => BoxId
  readonly #execImpl: (boxId: BoxId, spec: ExecSpec) => ExecResult | Promise<ExecResult>
  readonly #pipeImpl: ((boxId: BoxId, spec: PipeSpec) => PipeSession) | null
  readonly #statsImpl: BoxStats
  readonly #boxes = new Map<BoxId, MockBox>()
  readonly #snapshots = new Map<SnapshotId, MockSnapshot>()
  #snapshotCounter = 0
  readonly calls: MockExecCall[] = []
  readonly pipeCalls: MockPipeCall[] = []

  constructor(options: MockBoxBackendOptions = {}) {
    this.#now = options.now ?? (() => 0)
    let counter = 0
    this.#nextBoxId = options.nextBoxId ?? (() => `box-${++counter}`)
    this.#execImpl =
      options.exec ??
      ((_boxId, spec) => ({
        exitCode: 0,
        stdout: `mock: ${spec.command.join(' ')}`,
        stderr: '',
      }))
    this.#pipeImpl = options.pipe ?? null
    this.#statsImpl = options.stats ?? { cpuPercent: 12, memoryMb: 256, diskMb: 1200 }
  }

  caps(): BoxCaps {
    return { ...MOCK_BOX_CAPS }
  }

  async create(spec: BoxSpec): Promise<BoxId> {
    const boxId = this.#nextBoxId()
    this.#boxes.set(boxId, { spec, state: 'active', createdAt: this.#now(), files: new Map() })
    return boxId
  }

  async exec(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    this.#require(boxId)
    this.calls.push({ boxId, spec, at: this.#now() })
    const result = await this.#execRacingAbort(boxId, spec)
    // 流式语义对称（mock 对称原则）：结果按行拆块回调——真实后端是逐块到达，
    // 调用方（runner/WS 实况）不感知后端种类
    if (spec.onChunk) {
      for (const line of result.stdout.split(/(?<=\n)/)) {
        if (line) spec.onChunk({ stream: 'stdout', text: line })
      }
      if (result.stderr) {
        for (const line of result.stderr.split(/(?<=\n)/)) {
          if (line) spec.onChunk({ stream: 'stderr', text: line })
        }
      }
    }
    return result
  }

  /** 中止语义对称（真实后端：signal 触发即 kill 子进程）：abort 不等 execImpl、立即抛 BOX_EXEC_ABORTED */
  async #execRacingAbort(boxId: BoxId, spec: ExecSpec): Promise<ExecResult> {
    const signal = spec.signal
    if (!signal) return this.#execImpl(boxId, spec)
    const aborted = (): KernelError =>
      new KernelError(BoxesErrorCodes.BOX_EXEC_ABORTED, `exec 已中止：${spec.command.join(' ')}`)
    if (signal.aborted) throw aborted()
    return await new Promise<ExecResult>((resolve, reject) => {
      const onAbort = (): void => reject(aborted())
      signal.addEventListener('abort', onAbort, { once: true })
      Promise.resolve(this.#execImpl(boxId, spec)).then(
        (result) => {
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        },
      )
    })
  }

  async openShell(boxId: BoxId, _opts: ShellOpenOptions = {}): Promise<ShellSession> {
    this.#require(boxId)
    // 回显式假终端（mock 对称原则）：键入逐字符回显 + 回车「执行」回假输出——真 PTY 的回显由远端
    // bash 做，mock 自己做；转义序列按行式终端最小集（\r\n / \b），够 E2E 断言回显。
    // 同步回调（真后端是进程输出异步到达；mock 同步让断言零时序）+ 注册前缓冲回放（开场提示不丢）
    let dataCb: ((text: string) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    let closed = false
    let line = ''
    const pending: string[] = []
    const emit = (text: string): void => {
      if (closed) return
      if (dataCb) dataCb(text)
      else pending.push(text)
    }
    const finish = (code: number | null): void => {
      closed = true
      exitCb?.(code)
    }
    emit('mock shell（回显演示——无真实沙箱，命令不实际执行）\r\n$ ')
    return {
      write(text: string): void {
        if (closed) return
        for (const ch of text) {
          if (ch === '\r') {
            emit('\r\n') // 逐字符回显已发生，回车只补换行
            const cmd = line.trim()
            line = ''
            if (cmd === 'exit') {
              finish(0)
              return
            }
            if (cmd !== '') emit(`mock: ${cmd}\r\n`)
            emit('$ ')
          } else if (ch === '\u007f') {
            // 退格：真终端的擦除序列
            if (line !== '') {
              line = line.slice(0, -1)
              emit('\b \b')
            }
          } else {
            line += ch
            emit(ch)
          }
        }
      },
      onData(cb: (text: string) => void): void {
        dataCb = cb
        for (const t of pending.splice(0)) cb(t)
      },
      onExit(cb: (code: number | null) => void): void {
        exitCb = cb
      },
      close(): void {
        if (closed) return
        finish(null)
      },
    }
  }

  async openPipe(boxId: BoxId, spec: PipeSpec): Promise<PipeSession> {
    this.#require(boxId)
    this.pipeCalls.push({ boxId, spec, at: this.#now() })
    if (this.#pipeImpl) return this.#pipeImpl(boxId, spec)
    // 缺省静默常驻会话（流开成功但零帧——如实；降帧兜底路径由 GuiScreen 轮询接住）
    let dataCb: ((chunk: Uint8Array) => void) | null = null
    let exitCb: ((code: number | null) => void) | null = null
    let closed = false
    return {
      onData(cb) {
        dataCb = cb
      },
      onExit(cb) {
        exitCb = cb
      },
      stderrTail: () => '',
      write(_text) {
        /* 静默会话无 stdin 面（记录型替身由 options.pipe 注入） */
      },
      close() {
        if (closed) return
        closed = true
        exitCb?.(null)
      },
    }
  }

  async fsRead(boxId: BoxId, path: string): Promise<string | null> {
    const box = this.#require(boxId)
    return box.files.get(path) ?? null
  }

  async fsWrite(boxId: BoxId, path: string, content: string): Promise<void> {
    const box = this.#require(boxId)
    box.files.set(path, content)
  }

  async snapshot(boxId: BoxId): Promise<SnapshotId> {
    const box = this.#require(boxId)
    this.#snapshotCounter += 1
    const snapshotId = `snap-${this.#snapshotCounter}`
    this.#snapshots.set(snapshotId, {
      snapshotId,
      boxId,
      createdAt: this.#now(),
      files: new Map(box.files),
    })
    return snapshotId
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    return [...this.#snapshots.values()]
      .map((s) => ({ snapshotId: s.snapshotId, createdAt: s.createdAt }))
      .sort((a, b) => Number(b.snapshotId.slice(5)) - Number(a.snapshotId.slice(5)))
  }

  async restore(boxId: BoxId, snapshotId: SnapshotId): Promise<void> {
    const box = this.#require(boxId)
    const snap = this.#snapshots.get(snapshotId)
    if (!snap) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `快照不存在：${snapshotId}`)
    }
    box.files = new Map(snap.files)
  }

  async pause(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    box.state = 'sleeping'
  }

  async resume(boxId: BoxId): Promise<void> {
    const box = this.#require(boxId)
    box.state = 'active'
  }

  async stats(_boxId: BoxId): Promise<BoxStats> {
    this.#require(_boxId)
    // 模拟后端的设计本分：确定性假值（Step 6 仪表与 E2E 断言的地基——mock 不造假给谁看？给测试看）；
    // options.stats 整包覆盖（E2E 高值档位注入，P5 Step 7）
    return { ...this.#statsImpl }
  }

  async teardown(boxId: BoxId): Promise<void> {
    this.#require(boxId)
    this.#boxes.delete(boxId)
  }

  async list(): Promise<BoxInstance[]> {
    return [...this.#boxes.entries()]
      .map(([boxId, box]) => ({ boxId, spec: { ...box.spec }, state: box.state, createdAt: box.createdAt }))
      .sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.boxId < b.boxId ? -1 : 1))
  }

  /** 测试辅助：Box 内文件快照 */
  filesOf(boxId: BoxId): Record<string, string> {
    const box = this.#require(boxId)
    return Object.fromEntries(box.files)
  }

  #require(boxId: BoxId): MockBox {
    const box = this.#boxes.get(boxId)
    if (!box) {
      throw new KernelError(BoxesErrorCodes.BOX_NOT_FOUND, `Box 不存在：${boxId}`)
    }
    return box
  }
}
