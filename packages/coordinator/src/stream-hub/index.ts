/**
 * StreamHub：run 实况（RunStreamEvent）→ WS /stream 帧的汇聚与分发（装配根职责）。
 * 架构哲学「流是实况、聚合是事实」：这里只转发实况，不落任何存储——
 * 断线不补发（SSE 重放的是事实，流断了就断了）；exitCode 等聚合事实走事件总线（v1.box.exec）。
 *
 * 语义约定：
 * - 每条 open 事件开一条流（同 runId 的多轮 llm / 多次 exec 按序号区分）；
 * - 流只发给 open 时刻已连接的会话（中途接入者只看新流——诚实，不假装补历史）；
 * - 无订阅者时丢弃（turn 逻辑不受渲染层在线状态影响）；
 * - OPEN meta.meta = { agentId, runId, stream, seq, command?, round? }；DATA 负载 JSON { t, ch? }。
 */
import { StreamSession } from '@openbot/transport'
import type { StreamOpenMeta } from '@openbot/transport'
import type { RunStreamEvent } from '@openbot/runner'

/** DATA 帧负载 JSON 形状（t=文本增量；ch 仅 exec 流携带，stdout/stderr） */
export interface StreamChunkPayload {
  t: string
  ch?: 'stdout' | 'stderr'
}

interface HubStream {
  /** open 时刻绑定的活跃会话（发送时惰性过滤已关闭者） */
  targets: Map<StreamSession, number>
}

const encoder = new TextEncoder()

export class StreamHub {
  readonly #sessions = new Set<StreamSession>()
  readonly #streams = new Map<string, HubStream>()
  /** (runId:stream) → 已开流计数（序号递增；重启后随连接自然重置——实况无持久语义） */
  readonly #counters = new Map<string, number>()

  /** WS 连接建立时登记（gateway onStreamSession 回调接进来） */
  attach(session: StreamSession): void {
    this.#sessions.add(session)
  }

  detach(session: StreamSession): void {
    this.#sessions.delete(session)
    for (const stream of this.#streams.values()) stream.targets.delete(session)
  }

  get sessionCount(): number {
    this.#prune()
    return this.#sessions.size
  }

  /** runner onStream 的消费者：事件驱动流生命周期 */
  handle(event: RunStreamEvent): void {
    this.#prune()
    const prefix = `${event.runId}:${event.stream}`
    if (event.type === 'open') {
      const seq = (this.#counters.get(prefix) ?? 0) + 1
      this.#counters.set(prefix, seq)
      const targets = new Map<StreamSession, number>()
      const meta: StreamOpenMeta = {
        kind: 'frames',
        meta: {
          agentId: event.agentId,
          runId: event.runId,
          stream: event.stream,
          seq,
          ...(event.meta ?? {}),
        },
      }
      for (const session of this.#sessions) {
        if (session.closed) continue
        targets.set(session, session.openStream(meta))
      }
      this.#streams.set(`${prefix}:${seq}`, { targets })
      return
    }
    const key = `${prefix}:${this.#counters.get(prefix) ?? 0}`
    const entry = this.#streams.get(key)
    if (!entry) return // 无订阅者时 open 已丢弃（或流已收）——实况丢弃，不影响 turn
    if (event.type === 'chunk') {
      const payload: StreamChunkPayload = {
        t: event.text ?? '',
        ...(event.channel !== undefined ? { ch: event.channel } : {}),
      }
      const bytes = encoder.encode(JSON.stringify(payload))
      for (const [session, streamId] of entry.targets) {
        if (!session.closed) session.sendChunk(streamId, bytes)
      }
      return
    }
    // end / abort：收流并除名（后续 chunk 不可能再有——runner 语义保证）
    for (const [session, streamId] of entry.targets) {
      if (session.closed) continue
      if (event.type === 'end') session.endStream(streamId)
      else session.abortStream(streamId, event.reason)
    }
    entry.targets.clear()
    this.#streams.delete(key)
  }

  /** 惰性清理已关闭连接 */
  #prune(): void {
    for (const session of this.#sessions) {
      if (session.closed) this.detach(session)
    }
  }
}
