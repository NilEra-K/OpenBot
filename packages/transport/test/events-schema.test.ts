/**
 * 事件 payload zod 目录测试：合法负载全过、非法负载拒绝、未知类型放行（向前兼容）。
 * schema 与 core KernelEventMap 的对齐由 events.ts 内编译期断言保证（typecheck 即验证）。
 */
import { describe, expect, it } from 'vitest'
import { EventPayloadSchemas, validateEventPayload } from '../src/events.js'

describe('事件 payload schema 目录', () => {
  it('全部 14 个事件类型均有 schema', () => {
    expect(Object.keys(EventPayloadSchemas)).toHaveLength(14)
  })

  it('合法负载：全目录校验通过', () => {
    const samples: Record<string, unknown> = {
      'v1.lifecycle.queued': { runId: 'r1', agentId: 'a1', lane: 'user', kind: 'chat', steer: true },
      'v1.lifecycle.started': { runId: 'r1', agentId: 'a1', lane: 'agent', kind: 'chat' },
      'v1.lifecycle.finished': { runId: 'r1', agentId: 'a1', state: 'failed', code: 'X', attempts: 2 },
      'v1.lifecycle.finished.ok': { runId: 'r1', agentId: 'a1', state: 'succeeded', attempts: 1 }, // code 可选
      'v1.lifecycle.escaped': { runId: 'r1', agentId: 'a1', graceMs: 5000 },
      'v1.lifecycle.reaped': { runId: 'r1', agentId: 'a1' },
      'v1.lifecycle.idle': { agentId: 'a1' },
      'v1.message.user': { messageId: 'm1', toAgentId: 'a1', text: '你好' },
      'v1.message.agent': { messageId: 'm2', agentId: 'a1', text: '回复', runId: 'r1' },
      'v1.message.a2a': {
        messageId: 'm3',
        fromAgentId: 'a1',
        toAgentId: 'a2',
        text: '私聊',
        priority: true,
        isRedriven: false,
      },
      'v1.box.state': { boxId: 'b1', state: 'sleeping' },
      'v1.box.exec': { boxId: 'b1', phase: 'finished', command: ['ls', '-l'], exitCode: 0 },
      'v1.approval.requested': { approvalId: 'ap1', runId: 'r1', agentId: 'a1', tool: 'host_fetch', nonce: 'n1' },
      'v1.approval.resolved': { approvalId: 'ap1', decision: 'denied', nonce: 'n1' },
      'v1.system.roster': { agentId: 'a1', role: 'steward', cause: 'appointed' },
    }
    for (const [type, payload] of Object.entries(samples)) {
      const key = type.replace(/\.ok$/, '')
      expect(validateEventPayload(key, payload), `${type} 应通过`).toBeNull()
    }
  })

  it('非法负载：缺字段 / 错枚举 / 错类型 → ZodError', () => {
    expect(validateEventPayload('v1.message.user', { toAgentId: 'a1', text: '缺 messageId' })).not.toBeNull()
    expect(
      validateEventPayload('v1.lifecycle.queued', { runId: 'r1', agentId: 'a1', lane: 'fast', kind: 'chat', steer: true }),
    ).not.toBeNull() // lane 枚举外
    expect(
      validateEventPayload('v1.approval.resolved', { approvalId: 'ap1', decision: 'maybe', nonce: 'n1' }),
    ).not.toBeNull()
    expect(validateEventPayload('v1.lifecycle.finished', { runId: 'r1', agentId: 'a1', state: 'failed', attempts: '两次' })).not.toBeNull()
  })

  it('未登记类型：不校验（新内核 + 旧壳向前兼容）', () => {
    expect(validateEventPayload('v2.something.new', { any: 'thing' })).toBeNull()
  })
})
