/**
 * 正文预览幂等判据（v0.1.113 报障「一段输出被切割成两段」修复）：
 * live 预览块与终答消息的让位判定——全等或**双向前缀**（trim 边界）。
 *
 * 背景：正文流式走 WS /stream（渲染层聚合预览），终答走事件总线（两通道独立）。
 * WS 断线丢 chunk 时预览聚合只是终答的**前缀**——原精确全等判据让位失败，
 * 预览与终答双气泡并存（用户观感「一段输出被切割」）。前缀/超集均判重；
 * 中间轮正文是独立叙述（非终答前缀）→ 不误伤，仍按设计保留为过程事实。
 *
 * v0.1.121 曾补「长终答后缀」判据应对断线续写拼接（end 丢失旧块滞留 live 被新轮
 * chunk 续写）；同版 seq 身份配对（onStreamChunk 按流代际精确找块）已从结构上根除
 * 错位续写，拼接形态不再产生——后缀判据随之退休，判据回归三形态极简。
 *
 * 2026-11-02 起降级为**防御层**：主路径已由 run 语义终结统一接管（终答/finished 事件
 * → finalizeRun 封存 + markRunFinalized 记档，晚到增量结构性丢弃）——身份判定不再
 * 依赖文本猜度。本判据仅兜「终答事件极端缺席」（双通道同时故障）时的双气泡呈现。
 */

/** 终答与预览是否重复（让位）：全等 / 预览为终答前缀（断线丢尾）/ 预览为终答超集（重放）。
 *  trim 边界后比较；空文本恒不判（防空前缀 startsWith 恒真误杀） */
export function isPreviewDup(finalText: string, preview: string): boolean {
  const t = finalText.trim()
  const s = preview.trim()
  if (t === '' || s === '') return false
  return t === s || t.startsWith(s) || s.startsWith(t)
}
