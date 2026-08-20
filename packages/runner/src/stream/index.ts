/**
 * run 流事件（run 实况）：turn 引擎与工具层产生的流式增量经此类型上报——
 * 装配根把它接到 WS /stream（StreamHub），**不进事件总线**（流是实况、聚合是事实：
 * SSE 重放的是事实，流断了就断了；ARCHITECTURE.md §5 三通道之数据面）。
 * 类型定义在 runner（依赖序位于 transport 之下），coordinator 消费。
 */

export type RunStreamKind = 'llm' | 'exec'

export interface RunStreamEvent {
  /** 流生命周期：open（开流）→ chunk×N（增量）→ end（正常收流）/ abort（异常中止） */
  type: 'open' | 'chunk' | 'end' | 'abort'
  agentId: string
  runId: string
  stream: RunStreamKind
  /** open 附带：exec 为命令与所属 Box；llm 为本轮 chat 序号（1 起） */
  meta?: { command?: string[]; round?: number; boxId?: string }
  /** chunk 的文本增量 */
  text?: string
  /** exec chunk 通道（stdout/stderr；llm 无此字段） */
  channel?: 'stdout' | 'stderr'
  /** exec end 附带退出码 */
  exitCode?: number
  /** abort 原因 */
  reason?: string
}
