/**
 * 出 Box 闸门：宿主文件/网络访问必须审批——复用 state 幂等账本（nonce 派生自
 * originMessageId + toolCallId，redrive 后重试同键，不双弹窗、不双执行）。
 * 包内工具（in-box）自由、不过闸；host 工具按需包 gated()。
 */
import type { ToolCall } from '@openbot/llm'
import { approvalDenied } from '../approval/index.js'
import type { ApprovalGate, ApprovalRequest } from '../approval/index.js'
import type { Tool, ToolContext } from '../tools/index.js'

export interface GatedToolDeps {
  gate: ApprovalGate
  /** 审批理由（进 v1.approval 事件，帮用户决策） */
  reason?: (ctx: ToolContext, args: unknown) => string | undefined
}

/** 把任意工具包成「先过闸」：拒绝时以 APPROVAL_DENIED 文本回喂模型，不执行 */
export function gated(tool: Tool, deps: GatedToolDeps): Tool {
  return {
    spec: tool.spec,
    async execute(ctx: ToolContext, args: unknown): Promise<string> {
      const call: ToolCall = { id: ctx.toolCallId, name: tool.spec.name, args }
      const request: ApprovalRequest = {
        runId: ctx.runId,
        agentId: ctx.agentId,
        tool: tool.spec.name,
        reason: deps.reason?.(ctx, args),
        nonce: `${ctx.originMessageId}:${call.id}`,
      }
      const approved = await deps.gate.request(request)
      if (!approved) {
        const err = approvalDenied(request)
        return `错误 ${err.code}: ${err.message}`
      }
      return tool.execute(ctx, args)
    },
  }
}
