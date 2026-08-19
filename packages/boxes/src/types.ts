/**
 * Box 能力协商（caps）与后端接口——单一真相源：runner 工具可用性、transport 事件下发、
 * renderer 按钮渲染三处消费同一个 caps，永不出现「UI 有按钮但后端不支持」。
 * 接口按 caps 设计，永不按「最强后端都能做什么」设计（ARCHITECTURE.md §6）。
 */

export const BoxesErrorCodes = {
  BOX_NOT_FOUND: 'BOX_NOT_FOUND',
  BOX_BACKEND_NOT_FOUND: 'BOX_BACKEND_NOT_FOUND',
} as const

export type BoxId = string
export type SnapshotId = string

/** Box 实例三态（与 v1.box.state 事件同词表） */
export type BoxInstanceState = 'active' | 'sleeping' | 'snapshot'

/** 后端能力声明（诚实版矩阵见 ARCHITECTURE.md §6） */
export interface BoxCaps {
  persistent: boolean
  snapshot: boolean
  headless: boolean
  resourceLimits: boolean
  isolation: 'low' | 'medium' | 'high'
}

export interface BoxSpec {
  /** 模板/镜像名（images 注册表；P1 用 'default'） */
  image: string
  /** 资源上限；caps.resourceLimits=false 的后端可如实忽略 */
  cpus?: number
  memoryMb?: number
}

export interface ExecSpec {
  command: string[]
  cwd?: string
  env?: Record<string, string>
  /** 超时 ms——后端必须尊重（zombie 契约：执行必须有界） */
  timeoutMs?: number
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface BoxStats {
  cpuPercent: number
  memoryMb: number
  diskMb: number
}

export interface BoxInstance {
  boxId: BoxId
  spec: BoxSpec
  state: BoxInstanceState
  createdAt: number
}

/** 沙箱后端接口——实现见 backend-wsl / backend-docker / backend-mock */
export interface BoxBackend {
  readonly id: string
  caps(): BoxCaps
  create(spec: BoxSpec): Promise<BoxId>
  exec(box: BoxId, cmd: ExecSpec): Promise<ExecResult>
  fsRead(box: BoxId, path: string): Promise<string | null>
  fsWrite(box: BoxId, path: string, content: string): Promise<void>
  snapshot(box: BoxId): Promise<SnapshotId>
  stats(box: BoxId): Promise<BoxStats>
  teardown(box: BoxId): Promise<void>
  /** 实例清单（box 目录与 boxes 视图用） */
  list(): Promise<BoxInstance[]>
}
