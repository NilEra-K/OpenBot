/**
 * ShellService：交互式 shell 会话（PTY）的生命周期与流分发（装配根职责）。
 * - open：backend.openShell 起会话 → 向全部已连接 WS 会话开流（kind:'pty'）
 * - write：键入路由（命令面进来，每键几字节——环回 HTTP 无感）
 * - close：杀会话（用户关操作台）；bash 自己 exit 与被杀同走 onExit 收流
 * 流是实况：无 WS 订阅者时会话照样跑（终端输出丢弃）——与 StreamHub 同哲学，
 * 会话生命周期不受渲染层在线状态影响；退出后除名，shellId 不复用。
 */
import { KernelError } from '@openbot/core'
import type { StreamSession } from '@openbot/transport'
import type { BoxBackend, ShellSession } from '@openbot/boxes'

export const ShellErrorCodes = {
  /** caps.interactive=false 或后端未实现 openShell */
  SHELL_UNSUPPORTED: 'SHELL_UNSUPPORTED',
  /** 会话不存在（已退出/已关闭/从未打开） */
  SHELL_NOT_FOUND: 'SHELL_NOT_FOUND',
} as const

/** pty 流 OPEN meta（meta.meta 的形状；renderer 侧 lib/stream.ts 对照） */
export interface PtyStreamMeta {
  shellId: string
  boxId: string
}

interface Entry {
  boxId: string
  session: ShellSession
  /** open 时刻绑定的活跃 WS 会话（发送时惰性过滤已关闭者） */
  targets: Map<StreamSession, number>
}

const encoder = new TextEncoder()

export class ShellService {
  readonly #backend: BoxBackend
  readonly #nextShellId: () => string
  readonly #sessions = new Set<StreamSession>()
  readonly #shells = new Map<string, Entry>()
  #counter = 0

  constructor(deps: { backend: BoxBackend; nextShellId?: () => string }) {
    this.#backend = deps.backend
    this.#nextShellId = deps.nextShellId ?? (() => `shell-${++this.#counter}`)
  }

  /** WS 连接建立时登记（gateway onStreamSession 回调接进来——与 streamHub 并联） */
  attach(session: StreamSession): void {
    this.#sessions.add(session)
  }

  detach(session: StreamSession): void {
    this.#sessions.delete(session)
    for (const entry of this.#shells.values()) entry.targets.delete(session)
  }

  get openCount(): number {
    return this.#shells.size
  }

  /** 起会话并开流（命令 v1.boxes.shellOpen） */
  async open(boxId: string, opts?: { cols?: number; rows?: number }): Promise<{ shellId: string }> {
    this.#prune()
    // caps 与接口永不背离（types.ts 约定）；未支持是领域错误，UI 按 caps 提前不渲染入口
    if (!this.#backend.caps().interactive || !this.#backend.openShell) {
      throw new KernelError(ShellErrorCodes.SHELL_UNSUPPORTED, '当前沙箱后端不支持交互式终端')
    }
    const shellId = this.#nextShellId()
    const session = await this.#backend.openShell(boxId, opts)
    const entry: Entry = { boxId, session, targets: new Map() }
    this.#shells.set(shellId, entry)
    // 输出 → open 时刻已连接的会话（中途接入者看不到本会话——实况不补，同 run 流语义）
    const meta = { kind: 'pty' as const, boxId, meta: { shellId, boxId } satisfies PtyStreamMeta }
    for (const ws of this.#sessions) {
      if (!ws.closed) entry.targets.set(ws, ws.openStream(meta))
    }
    session.onData((text) => {
      for (const [ws, streamId] of entry.targets) {
        if (!ws.closed) ws.sendChunk(streamId, encoder.encode(JSON.stringify({ t: text })))
      }
    })
    session.onExit(() => {
      // 退出与被杀同路径：收流（END）+ 除名（后续 write 报 SHELL_NOT_FOUND）
      for (const [ws, streamId] of entry.targets) {
        if (!ws.closed) ws.endStream(streamId)
      }
      entry.targets.clear()
      this.#shells.delete(shellId)
    })
    return { shellId }
  }

  /** 键入路由（命令 v1.boxes.shellWrite） */
  write(shellId: string, data: string): void {
    const entry = this.#shells.get(shellId)
    if (!entry) {
      throw new KernelError(ShellErrorCodes.SHELL_NOT_FOUND, `会话不存在：${shellId}`)
    }
    entry.session.write(data)
  }

  /** 杀会话（命令 v1.boxes.shellClose；幂等——已退出的会话静默成功） */
  close(shellId: string): void {
    const entry = this.#shells.get(shellId)
    if (!entry) return
    entry.session.close() // 触发 onExit 统一收流路径
  }

  /** 应用退出兜底：杀全部会话（不留后台 shell） */
  dispose(): void {
    for (const entry of this.#shells.values()) entry.session.close()
    this.#shells.clear()
    this.#sessions.clear()
  }

  /** 惰性清理已关闭连接（与 StreamHub 同款） */
  #prune(): void {
    for (const ws of this.#sessions) {
      if (ws.closed) this.detach(ws)
    }
  }
}
