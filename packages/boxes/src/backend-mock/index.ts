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
  SnapshotId,
} from '../types.js'

/** mock 的诚实能力：功能全「假装 ✓」（矩阵见 ARCHITECTURE.md §6），隔离强度如实为 low */
export const MOCK_BOX_CAPS: BoxCaps = {
  persistent: true,
  snapshot: true,
  headless: true,
  resourceLimits: true,
  isolation: 'low',
}

/** 一次 exec 的留痕（断言「runner 让沙箱跑了什么」） */
export interface MockExecCall {
  boxId: BoxId
  spec: ExecSpec
  at: number
}

export interface MockBoxBackendOptions {
  now?: () => number
  nextBoxId?: () => BoxId
  /** 自定义 exec 行为；默认 exit 0、stdout = 'mock: <command>' */
  exec?: (boxId: BoxId, spec: ExecSpec) => ExecResult | Promise<ExecResult>
}

interface MockBox {
  spec: BoxSpec
  state: BoxInstance['state']
  createdAt: number
  files: Map<string, string>
}

export class MockBoxBackend implements BoxBackend {
  readonly id = 'mock'
  readonly #now: () => number
  readonly #nextBoxId: () => BoxId
  readonly #execImpl: (boxId: BoxId, spec: ExecSpec) => ExecResult | Promise<ExecResult>
  readonly #boxes = new Map<BoxId, MockBox>()
  #snapshotCounter = 0
  readonly calls: MockExecCall[] = []

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
    return this.#execImpl(boxId, spec)
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
    this.#require(boxId)
    this.#snapshotCounter += 1
    return `snap-${this.#snapshotCounter}`
  }

  async stats(_boxId: BoxId): Promise<BoxStats> {
    this.#require(_boxId)
    return { cpuPercent: 0, memoryMb: 0, diskMb: 0 }
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
