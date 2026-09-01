/**
 * 出 Box 闸门：宿主文件/网络访问必须审批——复用 state 幂等账本（nonce 派生自
 * originMessageId + toolCallId，redrive 后重试同键，不双弹窗、不双执行）。
 * 包内工具（in-box）自由、不过闸；host 工具按需包 gated()。
 */
import { KernelError } from '@openbot/core'
import type { ToolCall } from '@openbot/llm'
import { approvalDenied, ApprovalErrorCodes } from '../approval/index.js'
import type { ApprovalGate, ApprovalRequest } from '../approval/index.js'
import type { Tool, ToolContext, ToolResult } from '../tools/index.js'

export interface GatedToolDeps {
  gate: ApprovalGate
  /** 审批理由（进 v1.approval 事件，帮用户决策） */
  reason?: (ctx: ToolContext, args: unknown) => string | undefined
}

/** 把任意工具包成「先过闸」：拒绝时以 APPROVAL_DENIED 文本回喂模型，不执行 */
export function gated(tool: Tool, deps: GatedToolDeps): Tool {
  return {
    spec: tool.spec,
    async execute(ctx: ToolContext, args: unknown): Promise<string | ToolResult> {
      const call: ToolCall = { id: ctx.toolCallId, name: tool.spec.name, args }
      const request: ApprovalRequest = {
        runId: ctx.runId,
        agentId: ctx.agentId,
        tool: tool.spec.name,
        reason: deps.reason?.(ctx, args),
        nonce: `${ctx.originMessageId}:${call.id}`,
      }
      // 已中止的 run 不进闸门（不发 requested 事件——用户中止后不再弹窗打扰）
      if (ctx.signal.aborted) {
        throw new KernelError(ApprovalErrorCodes.APPROVAL_RUN_ABORTED, 'run 已中止，审批作废')
      }
      const approved = await requestRacingAbort(deps.gate.request(request), ctx.signal)
      if (!approved) {
        const err = approvalDenied(request)
        return `错误 ${err.code}: ${err.message}`
      }
      return tool.execute(ctx, args)
    },
  }
}

/**
 * 审批等待与 run 中止 race：中止即作废（抛 APPROVAL_RUN_ABORTED——用户中止 run，
 * 未决请求不再等决议；遗留审批条目由装配层 revokeRun 按 denied 落账收敛）。
 * 竞争失败后原 promise 不再消费，挂 noop catch 防 unhandled rejection。
 */
function requestRacingAbort(promise: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new KernelError(ApprovalErrorCodes.APPROVAL_RUN_ABORTED, 'run 已中止，审批作废'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (approved) => {
        signal.removeEventListener('abort', onAbort)
        resolve(approved)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
