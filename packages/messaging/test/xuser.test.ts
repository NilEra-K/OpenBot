/**
 * xuser 协议层测试（P7 Step 1）：纯函数/纯类直测——预算滚动窗口与方向独立、幂等重放回缓存、
 * 退避指数封顶与抖动界、schema 对公网输入的拒收面。host 侧（apps/relay）的房间隔离/fanout/
 * 认证见 relay 侧套件（Step 2）——本套只锁协议语义。
 */
import { describe, expect, it } from 'vitest'
import {
  TurnBudgetLedger,
  TurnIdempotency,
  XUSER_DEFAULT_BUDGET,
  backoffDelay,
  envelopeSchema,
} from '../src/xuser/index.js'

describe('TurnBudgetLedger（滚动窗口预算——host 单一事实源）', () => {
  it('缺省 10 分钟窗口 30 turn（§3.5 原文承诺）；admit 扣减与余量如实', () => {
    expect(XUSER_DEFAULT_BUDGET).toEqual({ windowMs: 600_000, maxTurns: 30 })
    const ledger = new TurnBudgetLedger({ windowMs: 1_000, maxTurns: 2 })
    expect(ledger.admit('a->b', 100)).toEqual({ ok: true, remaining: 1 })
    expect(ledger.admit('a->b', 200)).toEqual({ ok: true, remaining: 0 })
    expect(ledger.admit('a->b', 300)).toEqual({ ok: false, remaining: 0 }) // 耗尽
    // 拒绝不占预算：耗尽后 peek 仍 0 余量；窗口滚出后恢复（t=100/200 均出窗）
    expect(ledger.peek('a->b', 400)).toEqual({ ok: false, remaining: 0 })
    expect(ledger.admit('a->b', 1_201)).toEqual({ ok: true, remaining: 1 })
  })

  it('方向独立（a->b 与 b->a 互不挤占）；窗口滚动按 host 时钟', () => {
    const ledger = new TurnBudgetLedger({ windowMs: 1_000, maxTurns: 1 })
    expect(ledger.admit('a->b', 100).ok).toBe(true)
    expect(ledger.admit('b->a', 100).ok).toBe(true) // 反向独立
    expect(ledger.admit('a->b', 500).ok).toBe(false)
    expect(ledger.admit('a->b', 1_100).ok).toBe(true) // 首条滚出
  })
})

describe('TurnIdempotency（nonce 重放不双花）', () => {
  it('start 首见占位、重放 false；settle 后重放拿同一缓存应答', () => {
    const table = new TurnIdempotency(1_000)
    expect(table.start('n1', 100)).toBe(true)
    expect(table.start('n1', 150)).toBe(false) // 进行中重放
    table.settle('n1', 200, { status: 'ok', text: 'done' })
    expect(table.start('n1', 300)).toBe(false) // 已结算重放
    expect(table.get('n1')).toEqual({ status: 'ok', text: 'done' })
  })

  it('保留期滚出后释放（悬空占位不永久阻塞；结算缓存同窗清理）', () => {
    const table = new TurnIdempotency(1_000)
    expect(table.start('n1', 100)).toBe(true) // 未 settle（执行端崩溃模拟）
    expect(table.start('n1', 1_200)).toBe(true) // 占位已随窗口清理——可重新受理
    table.settle('n2', 100, { status: 'ok', text: 'x' })
    expect(table.get('n2')).toBeDefined()
    table.sweep(1_200)
    expect(table.get('n2')).toBeUndefined()
  })
})

describe('backoffDelay（指数 + jitter——纯函数注入随机源可测）', () => {
  it('指数爬升、封顶 maxMs；jitter=0 时确定性序列', () => {
    const opts = { baseMs: 1_000, maxMs: 10_000, jitterRatio: 0, rand: () => 0.5 }
    expect(backoffDelay(1, opts)).toBe(1_000)
    expect(backoffDelay(2, opts)).toBe(2_000)
    expect(backoffDelay(3, opts)).toBe(4_000)
    expect(backoffDelay(10, opts)).toBe(10_000) // 2^9*1000=512s 封顶
  })

  it('对称乘性抖动界 [step*(1-r), step*(1+r)]——多客户端同时断连不打挂 host 的关键', () => {
    const lo = backoffDelay(1, { baseMs: 1_000, jitterRatio: 0.2, rand: () => 0 })
    const hi = backoffDelay(1, { baseMs: 1_000, jitterRatio: 0.2, rand: () => 1 })
    expect(lo).toBe(800)
    expect(hi).toBe(1_200)
  })
})

describe('envelopeSchema（公网输入不可信的第一道防线）', () => {
  const request = {
    kind: 'turn-request',
    nonce: 'm-1:1',
    requestId: 'req-1',
    fromMemberId: 'm-1',
    toMemberId: 'm-2',
    prompt: '帮我总结这份报告',
    sentAt: 1_000,
  }

  it('三种信封合法形状解析通过（strict）', () => {
    expect(envelopeSchema.parse(request)).toEqual(request)
    expect(
      envelopeSchema.parse({
        kind: 'mirror-message',
        nonce: 'm-1:2',
        fromMemberId: 'm-1',
        speakerKind: 'agent',
        speakerName: '管家',
        text: '已完成',
        sentAt: 1_100,
      }),
    ).toBeDefined()
    expect(
      envelopeSchema.parse({
        kind: 'turn-result',
        requestId: 'req-1',
        fromMemberId: 'm-2',
        status: 'ok',
        text: '摘要如下…',
        remaining: 29,
      }),
    ).toBeDefined()
    expect(
      envelopeSchema.parse({
        kind: 'turn-result',
        requestId: 'req-2',
        fromMemberId: 'm-2',
        status: 'unreachable',
        text: '目标成员不在场',
      }),
    ).toBeDefined()
  })

  it('拒未知字段/非法 kind/超长文本/畸形 id（注入面收缩）', () => {
    expect(envelopeSchema.safeParse({ ...request, extra: 1 }).success).toBe(false) // strict
    expect(envelopeSchema.safeParse({ ...request, kind: 'evil' }).success).toBe(false)
    expect(envelopeSchema.safeParse({ ...request, prompt: 'x'.repeat(8_001) }).success).toBe(false)
    expect(envelopeSchema.safeParse({ ...request, nonce: 'bad id!' }).success).toBe(false)
    expect(envelopeSchema.safeParse({ ...request, prompt: '' }).success).toBe(false)
  })
})
