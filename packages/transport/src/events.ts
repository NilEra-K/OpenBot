/**
 * 协议事件目录（wire 侧）：版本前缀 + 七族。P5 relay 时这就是线上协议，不二次发明。
 * 参考：ARCHITECTURE.md §5 —— P1 实现。
 */
export const PROTOCOL_VERSION = 'v1'

export type VersionedEventFamily =
  | 'v1.lifecycle'
  | 'v1.message'
  | 'v1.task'
  | 'v1.box'
  | 'v1.approval'
  | 'v1.graph'
  | 'v1.system'

