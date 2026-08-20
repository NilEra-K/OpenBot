/**
 * Box 能力协商（caps）与后端接口——单一真相源：runner 工具可用性、transport 事件下发、
 * renderer 按钮渲染三处消费同一个 caps，永不出现「UI 有按钮但后端不支持」。
 * 接口按 caps 设计，永不按「最强后端都能做什么」设计（ARCHITECTURE.md §6）。
 */

export const BoxesErrorCodes = {
  BOX_NOT_FOUND: 'BOX_NOT_FOUND',
  BOX_BACKEND_NOT_FOUND: 'BOX_BACKEND_NOT_FOUND',
  /** Box 内文件写入失败（路径非法/磁盘满等） */
  BOX_FS_WRITE_FAILED: 'BOX_FS_WRITE_FAILED',
  /** Box 内命令被外部中止（run 取消/抢占传导——用户打断工作中的 agent） */
  BOX_EXEC_ABORTED: 'BOX_EXEC_ABORTED',
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
  /** 交互式 shell（PTY）——操作台终端远程控制的能力声明（caps.interactive=true 必须实现 openShell） */
  interactive: boolean
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
  /** 流式输出回调（可选）：实况逐块上报，聚合结果仍完整返回（流是实况，聚合是事实） */
  onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
  /** 外部中止（run 取消/抢占传导）：后端必须尊重——触发即终止 Box 内命令并抛 BOX_EXEC_ABORTED */
  signal?: AbortSignal
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

/** 交互式 shell 会话（PTY）：远端真终端——键入直写、输出含 ANSI 转义序列（xterm.js 可直接渲染）。
 *  与 exec 的有界语义（zombie 契约）相反，会话是无界的：边界是用户亲手关闭（远程控制的语义） */
export interface ShellSession {
  /** 键入（文本；控制字符与转义序列原样传输——远端终端自己解释） */
  write(text: string): void
  /** 输出增量（含转义序列；多字节 UTF-8 跨块由实现保证收敛） */
  onData(cb: (text: string) => void): void
  /** 会话退出（shell exit / 进程被杀）；close 后不再回调 */
  onExit(cb: (code: number | null) => void): void
  /** 杀会话（幂等；用户关闭操作台即调） */
  close(): void
}

/** openShell 参数：初始终端尺寸（默认 100×30；管道方案无 TIOCSWINSZ，中途不随窗口变） */
export interface ShellOpenOptions {
  cols?: number
  rows?: number
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
  /** 交互式 shell（可选实现；caps.interactive=true 时必须存在——caps 与接口永不背离） */
  openShell?(box: BoxId, opts?: ShellOpenOptions): Promise<ShellSession>
}
