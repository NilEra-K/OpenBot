/**
 * Box 能力协商（caps）——单一真相源：runner 工具可用性、transport 事件下发、
 * renderer 按钮渲染三处消费同一个 caps，永不出现「UI 有按钮但后端不支持」。
 * 参考：ARCHITECTURE.md §6 —— P1/P3 实现。
 */
export type BoxId = string
export type SnapshotId = string

/** 后端能力声明 */
export interface BoxCaps {
  persistent: boolean
  snapshot: boolean
  headless: boolean
  resourceLimits: boolean
  isolation: 'low' | 'medium' | 'high'
}

export interface BoxSpec {
  /** P1 填充：镜像/模板、资源上限、网络策略 */
}

export interface BoxStats {
  /** P1 填充：CPU/内存/磁盘（喂磁盘压力告警） */
}

/** 沙箱后端接口——实现见 backend-wsl / backend-docker / backend-mock */
export interface BoxBackend {
  readonly id: string
  caps(): BoxCaps
  // P1 起：create / exec / fsRead / fsWrite / snapshot / stats / teardown
}

