/**
 * 内核错误基类与稳定 code 目录：code 是跨层契约（渲染层据此出文案），message 仅诊断用
 * 参考：.ai/rules/code-style.md「协议与错误」。
 */

/** 内核错误：边界层（transport/boxes/llm）统一转为带 code 的错误对象，不裸抛字符串 */
export class KernelError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'KernelError'
    this.code = code
  }

  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message }
  }
}

/** 稳定错误 code 目录（UPPER_SNAKE_CASE，随用随补；文案归渲染层） */
export const ErrorCodes = {
  /** 活跃 run 被可 steer 来客抢占 */
  RUN_STEER: 'RUN_STEER',
  /** 外部取消 */
  RUN_CANCELLED: 'RUN_CANCELLED',
  /** 超过硬期限被 abort */
  RUN_DEADLINE: 'RUN_DEADLINE',
  /** watchdog 逃逸：grace 窗口超限，settled 先行结算 */
  RUN_GRACE_EXCEEDED: 'RUN_GRACE_EXCEEDED',
  /** execute 抛出非 KernelError 时的兜底归类 */
  RUN_INTERNAL: 'RUN_INTERNAL',
} as const
