/**
 * 七族事件目录（内核侧类型定义）。wire 定义见 docs/protocol.md 与 @openbot/transport。
 * 参考：ARCHITECTURE.md §5 —— P1 实现。
 */
export type EventFamily =
  | 'lifecycle'
  | 'message'
  | 'task'
  | 'box'
  | 'approval'
  | 'graph'
  | 'system'

