/**
 * 协议事件目录（wire 侧）：版本前缀 + 七族 + payload zod schema。
 * P5 relay 时这就是线上协议，不二次发明；P2 起供壳侧/测试校验事件负载。
 * 参考：ARCHITECTURE.md §5、docs/protocol.md「七族事件」。
 *
 * 防漂移：schema 目录的 key 与 @openbot/core 的 KernelEventMap 做编译期双向断言；
 * 每个 schema 的 z.infer 与 core 侧 payload 接口互相 assignable（见文件尾 Assert* 类型）。
 */
import { z } from 'zod'
import type { KernelEventMap, KernelEventType } from '@openbot/core'

export const PROTOCOL_VERSION = 'v1'

export type VersionedEventFamily =
  | 'v1.lifecycle'
  | 'v1.message'
  | 'v1.task'
  | 'v1.box'
  | 'v1.approval'
  | 'v1.graph'
  | 'v1.system'

// ---- 事件 payload schema（v1；新增字段必须向后兼容：可选或带默认） ----

const laneSchema = z.enum(['user', 'agent', 'background'])
const outcomeStateSchema = z.enum(['succeeded', 'failed', 'aborted', 'escaped'])

export const EventPayloadSchemas = {
  'v1.lifecycle.queued': z.object({
    runId: z.string(),
    agentId: z.string(),
    lane: laneSchema,
    kind: z.string(),
    steer: z.boolean(),
    summary: z.string().optional(),
  }),
  'v1.lifecycle.started': z.object({
    runId: z.string(),
    agentId: z.string(),
    lane: laneSchema,
    kind: z.string(),
  }),
  'v1.lifecycle.finished': z.object({
    runId: z.string(),
    agentId: z.string(),
    state: outcomeStateSchema,
    code: z.string().optional(),
    attempts: z.number().int().nonnegative(),
  }),
  'v1.lifecycle.escaped': z.object({
    runId: z.string(),
    agentId: z.string(),
    graceMs: z.number().nonnegative(),
  }),
  'v1.lifecycle.reaped': z.object({
    runId: z.string(),
    agentId: z.string(),
  }),
  'v1.lifecycle.idle': z.object({
    agentId: z.string(),
  }),
  'v1.message.user': z.object({
    messageId: z.string(),
    toAgentId: z.string(),
    text: z.string(),
  }),
  'v1.message.agent': z.object({
    messageId: z.string(),
    agentId: z.string(),
    text: z.string(),
    runId: z.string().optional(),
  }),
  'v1.message.a2a': z.object({
    messageId: z.string(),
    fromAgentId: z.string(),
    toAgentId: z.string(),
    text: z.string(),
    priority: z.boolean(),
    isRedriven: z.boolean(),
  }),
  'v1.box.state': z.object({
    boxId: z.string(),
    state: z.enum(['active', 'sleeping', 'snapshot']),
  }),
  'v1.box.exec': z.object({
    boxId: z.string(),
    runId: z.string().optional(),
    phase: z.enum(['started', 'finished']),
    command: z.array(z.string()),
    exitCode: z.number().int().optional(),
  }),
  'v1.box.stats': z.object({
    boxId: z.string(),
    cpuPercent: z.number().min(0).optional(),
    memoryMb: z.number().min(0).optional(),
    diskMb: z.number().min(0).optional(),
  }),
  'v1.system.pressure': z.object({
    dimension: z.literal('disk'),
    level: z.enum(['ok', 'warn', 'critical']),
    freeBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  }),
  'v1.approval.requested': z.object({
    approvalId: z.string(),
    runId: z.string(),
    agentId: z.string(),
    tool: z.string(),
    reason: z.string().optional(),
    nonce: z.string(),
  }),
  'v1.approval.resolved': z.object({
    approvalId: z.string(),
    decision: z.enum(['approved', 'denied']),
    nonce: z.string(),
  }),
  'v1.approval.mode-changed': z.object({
    mode: z.enum(['manual', 'auto']),
  }),
  'v1.system.roster': z.object({
    agentId: z.string(),
    role: z.enum(['steward', 'worker']),
    cause: z.enum(['registered', 'removed', 'appointed', 'dismissed', 'transferred']),
  }),
  'v1.box.gui-takeover': z.object({
    held: z.boolean(),
  }),
  'v1.system.remote-members': z.object({
    roomId: z.string(),
    members: z.array(
      z.object({
        memberId: z.string(),
        displayName: z.string(),
        connected: z.boolean(),
      }),
    ),
  }),
  'v1.message.remote': z.object({
    messageId: z.string(),
    roomId: z.string(),
    fromMemberId: z.string(),
    speakerKind: z.enum(['user', 'agent']),
    speakerName: z.string(),
    text: z.string(),
  }),
} as const

export type EventPayloadSchemaName = keyof typeof EventPayloadSchemas

/** 校验事件负载；不过 schema 时返回 zod 错误（调用方决定处置——壳侧丢弃并告警） */
export function validateEventPayload(type: string, payload: unknown): z.ZodError | null {
  const schema = (EventPayloadSchemas as Record<string, z.ZodType | undefined>)[type]
  if (!schema) return null // 未登记的类型不校验（向前兼容：新内核 + 旧壳）
  const parsed = schema.safeParse(payload)
  return parsed.success ? null : parsed.error
}

// ---- 编译期防漂移断言（key 集合与 payload 形状与 core 单一来源对齐） ----

/** schema 目录的 key 必须与 KernelEventMap 完全一致 */
type AssertSameKeys =
  [EventPayloadSchemaName] extends [KernelEventType]
    ? [KernelEventType] extends [EventPayloadSchemaName]
      ? true
      : never
    : never
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SameKeys = AssertSameKeys

/** 每个 schema 的推断类型必须与 core 侧接口互相兼容（zod 可选字段带 undefined，单向足够暴露漂移） */
type InferOf<K extends EventPayloadSchemaName> = z.infer<(typeof EventPayloadSchemas)[K]>
type AssertPayloadMatch = {
  [K in EventPayloadSchemaName]: InferOf<K> extends KernelEventMap[K] ? KernelEventMap[K] extends InferOf<K> ? true : never : never
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _PayloadMatch = AssertPayloadMatch
