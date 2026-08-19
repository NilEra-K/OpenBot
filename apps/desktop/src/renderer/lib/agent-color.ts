/**
 * agent 稳定色：agentId 哈希到固定色相（同一 agent 跨视图/重启颜色一致——原型的身份色语义）。
 */
const PALETTE = ['#d95926', '#aab137', '#199e70', '#3987e5', '#9a6de0', '#d05a9e', '#c98a3d', '#4fa3b8']

export function agentColor(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]!
}
