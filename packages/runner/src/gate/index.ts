/**
 * 出 Box 闸门：宿主文件/网络访问必须审批——复用 state 幂等账本（nonce 派生自
 * originMessageId + toolCallId，redrive 后重试同键，不双弹窗、不双执行）。
 * 包内工具（in-box）自由、不过闸；host 工具按需包 gated()。
 */
import { KernelError } from '@openbot/core'
import { approvalDenied, ApprovalErrorCodes } from '../approval/index.js'
import type { ApprovalGate, ApprovalRequest } from '../approval/index.js'
import type { Tool, ToolContext, ToolResult } from '../tools/index.js'

export interface GatedToolDeps {
  gate: ApprovalGate
  /** 审批理由（进 v1.approval 事件，帮用户决策） */
  reason?: (ctx: ToolContext, args: unknown) => string | undefined
}

/**
 * 单次审批请求（gated() 与 computer 动作工具 actionGate 共用——P9-1 宿主屏幕载体恒过闸）：
 * 已中止的 run 不进闸门（不发 requested 事件）；拒绝返回 null 由调用方决定回喂形态。
 */
export async function requestToolApproval(
  gate: ApprovalGate,
  ctx: ToolContext,
  toolName: string,
  reason?: string,
): Promise<{ approved: true } | { approved: false; denial: string }> {
  const request: ApprovalRequest = {
    runId: ctx.runId,
    agentId: ctx.agentId,
    tool: toolName,
    ...(reason !== undefined ? { reason } : {}),
    nonce: `${ctx.originMessageId}:${ctx.toolCallId}`,
  }
  if (ctx.signal.aborted) {
    throw new KernelError(ApprovalErrorCodes.APPROVAL_RUN_ABORTED, 'run 已中止，审批作废')
  }
  const approved = await requestRacingAbort(gate.request(request), ctx.signal)
  if (!approved) {
    const err = approvalDenied(request)
    return { approved: false, denial: `错误 ${err.code}: ${err.message}` }
  }
  return { approved: true }
}

/** 把任意工具包成「先过闸」：拒绝时以 APPROVAL_DENIED 文本回喂模型，不执行 */
export function gated(tool: Tool, deps: GatedToolDeps): Tool {
  return {
    spec: tool.spec,
    async execute(ctx: ToolContext, args: unknown): Promise<string | ToolResult> {
      const reason = deps.reason?.(ctx, args)
      const r = await requestToolApproval(deps.gate, ctx, tool.spec.name, reason)
      if (!r.approved) return r.denial
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
