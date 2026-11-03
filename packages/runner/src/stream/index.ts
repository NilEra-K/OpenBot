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
  /** open 附带：exec 为命令与所属 Box；llm 为本轮 chat 序号（1 起）；startedAt = 流的
   *  领域起点时刻（2026-11-02：llm=轮开始 roundStartedAt、exec=命令开始——渲染端建块
   *  的 at 来源，与回放投影同源；到达时刻作 at 会在「终答先到+归档落定」竞速下晚于
   *  终答事件，思考卡被排序甩到终答之后——整卡错位报障） */
  meta?: { command?: string[]; round?: number; boxId?: string; startedAt?: number }
  /** chunk 的文本增量 */
  text?: string
  /** llm chunk 的流类（v0.1.43 双通道）：think=思考增量（onThinking）/ text=正文增量（缺省
   *  text——旧事件流兼容：无 kind 的 llm chunk 一律按正文处理） */
  think?: boolean
  /** exec chunk 通道（stdout/stderr；llm 无此字段） */
  channel?: 'stdout' | 'stderr'
  /** exec end 附带退出码 */
  exitCode?: number
  /** abort 原因 */
  reason?: string
}
