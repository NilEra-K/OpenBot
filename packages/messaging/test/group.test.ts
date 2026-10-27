import { describe, expect, it } from 'vitest'
import { AgentScheduler, EventBus, KernelError } from '@openbot/core'
import type { ActiveRun, KernelEvent } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs, TranscriptStore } from '@openbot/state'
import { GroupService, MAX_GROUP_RECORDS } from '../src/index.js'

/** 成员 turn 门：挂起模拟执行中；resolve 值即 RunOutcome.result（turn 终答 { text }） */
interface Gate {
  run: ActiveRun
  resolve: (result?: unknown) => void
}

function makeHarness(nameOf?: (agentId: string) => string | undefined) {
  let t = 0
  let msgCounter = 0
  let runCounter = 0
  const fs = new InMemoryFs()
  const bus = new EventBus({ now: () => t })
  const events: KernelEvent[] = []
  bus.on('*', (e) => events.push(e))
  const transcript = new TranscriptStore({ fs, root: 'data', now: () => t })
  const ledger = new IdempotencyLedger({ fs, root: 'data', now: () => t })
  const gates: Gate[] = []
  const schedulers = new Map<string, AgentScheduler>()
  const makeScheduler = (agentId: string): AgentScheduler =>
    new AgentScheduler({
      agentId,
      now: () => t,
      nextRunId: () => `${agentId}-run-${++runCounter}`,
      bus,
      execute: (run) =>
        new Promise((resolve) => {
          gates.push({ run, resolve })
          run.signal.addEventListener('abort', () => resolve(undefined))
        }),
    })
  const service = new GroupService({
    bus,
    now: () => t,
    nextMessageId: () => `msg-${++msgCounter}`,
    transcript,
    ledger,
    fs,
    root: 'data',
    schedulerOf: (agentId) => {
      const s = schedulers.get(agentId)
      if (!s) throw new KernelError('STATE_AGENT_NOT_FOUND', `未注册 agent：${agentId}`)
      return s
    },
    ...(nameOf !== undefined ? { nameOf } : {}),
  })
  return {
    service,
    events,
    gates,
    transcript,
    fs,
    register: (agentId: string) => {
      const s = makeScheduler(agentId)
      schedulers.set(agentId, s)
      return s
    },
    flush: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  }
}

const kinds = (events: KernelEvent[], type: string): number => events.filter((e) => e.type === type).length

describe('GroupService 建群', () => {
  it('建群：sysnote 落群流 + v1.group.state 事件 + 群清单持久化（load 恢复）', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: '项目组', memberAgentIds: ['a1', 'a2'] })
    expect(group.groupId).toBe('group-1')
    expect(group.members).toEqual(['a1', 'a2'])
    const records = await h.transcript.readAll('group-1')
    expect(records[0]?.kind).toBe('group-sys')
    expect((records[0]?.payload as { text: string }).text).toContain('项目组')
    expect(kinds(h.events, 'v1.group.state')).toBe(1)
    // 重启恢复：新实例同一 fs load 群清单
    const reborn = new GroupService({
      bus: new EventBus({ now: () => 0 }),
      now: () => 0,
      nextMessageId: () => 'msg-x',
      transcript: h.transcript,
      ledger: new IdempotencyLedger({ fs: h.fs, root: 'data', now: () => 0 }),
      fs: h.fs,
      root: 'data',
      schedulerOf: (id) => {
        throw new Error(`未注册 agent：${id}`)
      },
    })
    await reborn.load()
    expect((await reborn.list()).map((g) => g.groupId)).toEqual(['group-1'])
  })

  it('成员不在名册：建群按稳定码拒绝', async () => {
    const h = makeHarness()
    h.register('a1')
    await expect(h.service.createGroup({ name: 'x', memberAgentIds: ['a1', 'ghost'] })).rejects.toMatchObject({
      code: 'STATE_AGENT_NOT_FOUND',
    })
  })
})

describe('GroupService 有界轮转', () => {
  // 群终答落群流（kind=group-agent）由 runner 的 turn session 写——messaging 层只测编排：
  // 成员依序、上下文传递、pass/失败路径、supersede 代际、收敛边界（群流笔迹归 runner 测试）

  it('用户消息 → 成员依序 turn（顺序保证）→ 上下文随发言传递 → 收敛不再入队', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    const acc = await h.service.sendUserMessage({ groupId: 'group-1', text: '各自说说', nonce: 'n1' })
    expect(acc.messageId).not.toBe('')
    // 第一个成员 turn 在队（顺序：成员序；lane=agent、kind=group）
    expect(h.gates[0]?.run.agentId).toBe('a1')
    expect(h.gates[0]?.run.kind).toBe('group')
    h.gates[0]?.resolve({ text: '我先说' })
    await h.flush()
    // a1 发言后 a2 接棒，且 a2 的 turn 上下文含 a1 发言（轮转传递）
    expect(h.gates[1]?.run.agentId).toBe('a2')
    const payload = h.gates[1]!.run.payload as { context: string[] }
    expect(payload.context).toEqual(['a1：我先说'])
    h.gates[1]?.resolve({ text: '我补充' })
    await h.flush()
    // 全员结算完毕：收敛，不再有新 turn 入队
    expect(h.gates).toHaveLength(2)
    // 用户消息进群流（受理侧写——这个属 messaging）；agent 私聊流零污染
    expect((await h.transcript.readAll('group-1')).some((r) => r.kind === 'group-user')).toBe(true)
    expect(await h.transcript.readAll('a1')).toHaveLength(0)
    expect(kinds(h.events, 'v1.group.message')).toBe(2) // sys(建群) + user；agent 发言归 runner
  })

  it('[pass] 收敛：全员 pass 记 sysnote、群流不增发言', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: 'group-1', text: '有补充吗', nonce: 'n1' })
    h.gates[0]?.resolve({ text: '[pass]' })
    await h.flush()
    h.gates[1]?.resolve({ text: '[pass] ' }) // trim 后判定
    await h.flush()
    const records = await h.transcript.readAll('group-1')
    expect(records.filter((r) => r.kind === 'group-agent')).toHaveLength(0)
    expect(records.at(-1)?.kind).toBe('group-sys')
    expect((records.at(-1)?.payload as { text: string }).text).toContain('全员 pass')
  })

  it('成员 turn 失败：sysnote 如实记缺席，轮转继续下一员', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: 'group-1', text: 'x', nonce: 'n1' })
    h.gates[0]?.resolve(undefined) // outcome.result=undefined → 文本空 → 缺席路径
    await h.flush()
    const records = await h.transcript.readAll('group-1')
    expect(records.some((r) => r.kind === 'group-agent')).toBe(false)
    expect(h.gates[1]?.run.agentId).toBe('a2') // 轮转继续
    h.gates[1]?.resolve({ text: '我说两句' })
    await h.flush()
    expect(h.gates).toHaveLength(2) // 收敛
  })

  it('supersede：轮转中用户插话 → 旧轮成员 settle 后静默丢弃（不推进），新轮接管', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: 'group-1', text: '第一问', nonce: 'n1' })
    // a1 挂起中（gates[0] 未 resolve）——用户插话（supersede sysnote 如实入群流）
    await h.service.sendUserMessage({ groupId: 'group-1', text: '改问这个', nonce: 'n2' })
    expect((await h.transcript.readAll('group-1')).some((r) => (r.payload as { text?: string }).text === '用户插话，本轮重新开始（supersede）')).toBe(true)
    // 旧 a1 turn 结算（gen 已不匹配）——静默丢弃：不推进 a2、不重复入队
    h.gates[0]?.resolve({ text: '旧轮回复' })
    await h.flush()
    expect(h.gates).toHaveLength(2) // 只有旧 a1 + 新轮 a1——旧轮未把 a2 拉进来
    // 新轮接管：新 a1 turn 在队（同成员新一轮，round=2、新文本）
    const newPayload = h.gates[1]!.run.payload as { text: string; round: number }
    expect(newPayload.text).toBe('改问这个')
    expect(newPayload.round).toBe(2)
    h.gates[1]?.resolve({ text: '新轮回复' })
    await h.flush()
    // 新轮 a2 接棒（旧轮永远不会再推进）
    expect(h.gates[2]?.run.agentId).toBe('a2')
    h.gates[2]?.resolve({ text: '[pass]' })
    await h.flush()
  })

  it('群上下文清空（/clear 群语义）：清空点落群流（marker）+ v1.group.cleared 事件 + 在途轮作废', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: 'group-1', text: '第一问', nonce: 'n1' })
    // a1 挂起中执行清空——在途轮作废（代际 bump，同 supersede 语义）
    const { messageId } = await h.service.clearContext({ groupId: 'group-1' })
    expect(messageId).not.toBe('')
    const records = await h.transcript.readAll('group-1')
    const clearRec = records.find((r) => (r.payload as { marker?: string }).marker === 'context-clear')
    expect(clearRec?.kind).toBe('group-sys')
    expect(kinds(h.events, 'v1.group.cleared')).toBe(1)
    // 旧 a1 turn 结算（gen 不匹配）静默丢弃：不推进 a2
    h.gates[0]?.resolve({ text: '旧轮回复' })
    await h.flush()
    expect(h.gates).toHaveLength(1)
    // 清空后再发消息：新轮从 a1 起（round 递进；spoken 已清）
    await h.service.sendUserMessage({ groupId: 'group-1', text: '新话题', nonce: 'n2' })
    expect(h.gates[1]?.run.agentId).toBe('a1')
    const payload = h.gates[1]!.run.payload as { text: string; round: number; context: string[] }
    expect(payload.text).toBe('新话题')
    expect(payload.round).toBe(2)
    expect(payload.context).toEqual([])
    h.gates[1]?.resolve({ text: '新答' })
    await h.flush()
  })

  it('单成员 pass 可见化：pass 即记轻量 sysnote；部分 pass 不触发收敛注记', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: 'group-1', text: '各自说说', nonce: 'n1' })
    h.gates[0]?.resolve({ text: '我先说' })
    await h.flush()
    h.gates[1]?.resolve({ text: '[pass]' }) // a2 pass——部分 pass（非全员）
    await h.flush()
    const records = await h.transcript.readAll('group-1')
    expect(records.some((r) => (r.payload as { text?: string }).text === 'a2 本轮 pass')).toBe(true)
    expect(records.some((r) => (r.payload as { text?: string }).text?.includes('全员 pass'))).toBe(false)
  })

  it('@提及双命中面（2026-10-19）：@显示名 与 @agentId 都命中；边界防误（@欧米茄们不命中）', async () => {
    const h = makeHarness((id) => (id === 'a1' ? '欧米茄' : undefined))
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    // 显示名命中 → 提及优先（首 gate 即 a1 且 mentioned 标注）
    await h.service.sendUserMessage({ groupId: group.groupId, text: '@欧米茄 说说', nonce: 'm1' })
    expect((h.gates[0]!.run.payload as { mentioned: string[] }).mentioned).toEqual(['a1'])
    h.gates[0]!.resolve({ text: '到' }) // a1 发言 → 轮转推进 a2
    await h.flush()
    h.gates[1]!.resolve({ text: '到' }) // a2 结算 → 本轮收敛
    await h.flush()
    // id 命中（原路径不回归）：@a2 提及优先
    await h.service.sendUserMessage({ groupId: group.groupId, text: '@a2 说说', nonce: 'm2' })
    expect((h.gates[2]!.run.payload as { mentioned: string[] }).mentioned).toEqual(['a2'])
    h.gates[2]!.resolve({ text: '到' })
    await h.flush()
    h.gates[3]!.resolve({ text: '到' })
    await h.flush()
    // 边界防误：后缀续字不命中（轮转常态）
    await h.service.sendUserMessage({ groupId: group.groupId, text: '@欧米茄们 说说', nonce: 'm3' })
    expect((h.gates[4]!.run.payload as { mentioned: string[] }).mentioned).toEqual([])
  })

  it('@提及优先：点名成员先发言', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: 'group-1', text: '@a2 你来说', nonce: 'n1' })
    expect(h.gates[0]?.run.agentId).toBe('a2')
    h.gates[0]?.resolve({ text: '好' })
    await h.flush()
    expect(h.gates[1]?.run.agentId).toBe('a1')
    h.gates[1]?.resolve({ text: '[pass]' })
    await h.flush()
  })

  it('幂等：同 nonce 重试回放（零新事件零新 run）', async () => {
    const h = makeHarness()
    h.register('a1')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1'] })
    await h.service.sendUserMessage({ groupId: 'group-1', text: 'x', nonce: 'n1' })
    h.gates[0]?.resolve({ text: '回复' })
    await h.flush()
    const before = { events: h.events.length, gates: h.gates.length }
    const retry = await h.service.sendUserMessage({ groupId: 'group-1', text: 'x', nonce: 'n1' })
    expect(retry.messageId).not.toBe('')
    expect(h.events.length).toBe(before.events)
    expect(h.gates.length).toBe(before.gates)
  })

  it('群消息上限：GROUP_LIMIT 稳定码拒绝', async () => {
    const h = makeHarness()
    h.register('a1')
    await h.service.createGroup({ name: 'g', memberAgentIds: ['a1'] })
    // 预填至上限（建群 sys 已 1 条——补 MAX-1 达到上限）
    for (let i = 0; i < MAX_GROUP_RECORDS - 1; i++) {
      await h.transcript.append('group-1', 'group-sys', { messageId: `m${i}`, from: 'system', text: 'x', at: 0 })
    }
    await expect(h.service.sendUserMessage({ groupId: 'group-1', text: 'y', nonce: 'n1' })).rejects.toMatchObject({
      code: 'GROUP_LIMIT',
    })
  })
})

describe('GroupService 独立作答（2026-10-18：#讨论 前缀——各抒己见互不可见）', () => {
  it('#讨论：全员并发入队（不等首员 settle）、context 恒空、mode 留痕与事件携带、前缀剥离', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: '评审组', memberAgentIds: ['a1', 'a2'] })
    const { runIds } = await h.service.sendUserMessage({ groupId: group.groupId, text: '#讨论 各自说说看法', nonce: 'n1' })

    // 并发实证：sendUserMessage 返回即两员 gate 全部在场（轮转模式此时只有首员）
    expect(runIds).toHaveLength(2)
    expect(h.gates).toHaveLength(2)
    const payloads = h.gates.map((g) => g.run.payload as { context: string[]; mode?: string; memberIds?: string[]; text: string })
    for (const p of payloads) {
      expect(p.context).toEqual([]) // 互不可见——不注入「本轮已发言」
      expect(p.mode).toBe('independent')
      expect(p.memberIds).toEqual(['a1', 'a2'])
      expect(p.text).toBe('各自说说看法') // 前缀剥离
    }
    // 记录与事件留痕：group-user 带 mode、文本已剥前缀
    const rec = (await h.transcript.readAll(group.groupId)).find((r) => r.kind === 'group-user')
    expect((rec?.payload as { mode?: string; text: string }).mode).toBe('independent')
    expect((rec?.payload as { text: string }).text).toBe('各自说说看法')
    expect(h.events.find((e) => e.type === 'v1.group.message' && (e.payload as { kind: string }).kind === 'user')?.payload).toMatchObject({ mode: 'independent' })
  })

  it('独立 settle 不推进新员；全员结算即收敛（各自一次，互不引用）', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#独立 谈谈', nonce: 'n1' })
    h.gates[0]!.resolve({ text: 'a1 的独立观点' })
    await h.flush()
    expect(h.gates).toHaveLength(2) // settle 后不推进（全员已入队）
    h.gates[1]!.resolve({ text: 'a2 的独立观点' })
    await h.flush()
    // settle 不再入队（全员已入队——本 harness 无 runner，发言落盘由 turn 引擎测试覆盖）
    expect(h.gates).toHaveLength(2)
    // 有实质发言不触发收敛注记
    expect((await h.transcript.readAll(group.groupId)).some((r) => r.kind === 'group-sys' && (r.payload as { text: string }).text.includes('收敛'))).toBe(false)
  })

  it('独立模式 pass：记 sysnote + 全员 pass 收敛', async () => {
    const h = makeHarness()
    h.register('a1')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#讨论 说说', nonce: 'n1' })
    h.gates[0]!.resolve({ text: '[pass]' })
    await h.flush()
    const notes = (await h.transcript.readAll(group.groupId))
      .filter((r) => r.kind === 'group-sys')
      .map((r) => (r.payload as { text: string }).text)
    expect(notes.some((n) => n.includes('a1 本轮 pass'))).toBe(true)
    expect(notes.some((n) => n.includes('全员 pass，本轮收敛'))).toBe(true)
  })

  it('supersede 对独立在途轮生效：插话后旧轮成员 settle 静默丢弃', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#讨论 第一问', nonce: 'n1' })
    const staleGates = [...h.gates]
    await h.service.sendUserMessage({ groupId: group.groupId, text: '第二问', nonce: 'n2' })
    for (const g of staleGates) g.resolve({ text: '旧轮发言不该出现' })
    await h.flush()
    expect((await h.transcript.readAll(group.groupId)).some((r) => (r.payload as { text?: string }).text === '旧轮发言不该出现')).toBe(false)
  })
})

describe('GroupService 汇总与点名模式（2026-10-18 模式体系扩展）', () => {
  it('#汇总：盲答全员 → 汇总轮（首位发言成员兜底）带全量观点 context；settle 收敛不续轮', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#汇总 评估方案', nonce: 'n1' })
    expect(h.gates).toHaveLength(2) // 阶段一：全员盲答
    h.gates[0]!.resolve({ text: '观点一' })
    h.gates[1]!.resolve({ text: '观点二' })
    await h.flush()
    // 阶段二：汇总人入队（roleOf 未注入——首位发言成员兜底；管家优先注入由装配/E2E 覆盖）
    expect(h.gates).toHaveLength(3)
    const summaryPayload = h.gates[2]!.run.payload as { mode?: string; context: string[]; memberIds?: string[] }
    expect(summaryPayload.mode).toBe('summary')
    expect(summaryPayload.context).toEqual(['a1：观点一', 'a2：观点二'])
    expect(summaryPayload.memberIds).toEqual(['a1', 'a2'])
    h.gates[2]!.resolve({ text: '汇总结论' })
    await h.flush()
    expect(h.gates).toHaveLength(3) // 汇总 settle 即收敛——不续轮
    // group-user 留 mode 痕
    const rec = (await h.transcript.readAll(group.groupId)).find((r) => r.kind === 'group-user')
    expect((rec?.payload as { mode?: string }).mode).toBe('summary')
  })

  it('#点名：仅被 @ 的成员入队（轮转语义保留）；未点名任何成员回退轮转并注记', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#点名 @a2 说说看', nonce: 'n1' })
    expect(h.gates).toHaveLength(1) // 门控：仅 a2
    expect((h.gates[0]!.run.payload as { mentioned: string[] }).mentioned).toEqual(['a2'])
    h.gates[0]!.resolve({ text: '被点名的回答' })
    await h.flush()
    expect(h.gates).toHaveLength(1) // a2 结算后 a1 不被叫起

    // 空点名：回退轮转 + sysnote 如实注记
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#点名 无人被点名', nonce: 'n2' })
    expect(h.gates).toHaveLength(2) // 回退轮转（首员）
    const notes = (await h.transcript.readAll(group.groupId))
      .filter((r) => r.kind === 'group-sys')
      .map((r) => (r.payload as { text: string }).text)
    expect(notes.some((n) => n.includes('未点名任何成员'))).toBe(true)
    const rec = (await h.transcript.readAll(group.groupId))
      .filter((r) => r.kind === 'group-user')
      .map((r) => (r.payload as { mode?: string }).mode)
    expect(rec).toEqual(['mention', undefined]) // 回退轮转的消息无 mode 痕
  })
})

describe('GroupService #辩论（2026-10-27 v0.1.93：立场 → 驳斥 ×4 → 中立汇总）', () => {
  it('全流程：双方并发盲答亮立场 → 反方先驳交替 ×4（靶点=对方最近发言）→ 未参辩成员中立汇总 → 收敛', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    h.register('a3')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2', 'a3'] })
    const acc = await h.service.sendUserMessage({ groupId: group.groupId, text: '#辩论 @a1 @a2 用 Rust 还是 Go', nonce: 'n1' })
    // 立场轮：正（a1）反（a2）并发盲答——context 恒空、前缀剥离进话题
    expect(acc.runIds).toHaveLength(2)
    expect(h.gates.map((g) => g.run.agentId)).toEqual(['a1', 'a2'])
    const opening = (i: number): { mode: string; debate: { phase: string; stance: string; opponent: string }; context: string[]; text: string } =>
      h.gates[i]!.run.payload as never
    expect(opening(0).mode).toBe('debate')
    expect(opening(0).debate).toEqual({ phase: 'opening', stance: 'pro', opponent: 'a2' })
    expect(opening(1).debate).toEqual({ phase: 'opening', stance: 'con', opponent: 'a1' })
    expect(opening(0).context).toEqual([]) // 盲答互不可见
    expect(opening(0).text).toBe('@a1 @a2 用 Rust 还是 Go') // 前缀剥离，@提及留在话题文本（同 #点名 语义）
    h.gates[0]!.resolve({ text: '正方：Rust 安全' })
    await h.flush()
    expect(h.gates).toHaveLength(2) // 并发——一方 settle 不推进
    h.gates[1]!.resolve({ text: '反方：Go 简单' })
    await h.flush()
    // 驳斥 ×4：反方先驳（con→pro→con→pro），靶点=对方最近发言
    const expectRebuttal = (gateIdx: number, speaker: string, targetCtx: string): void => {
      expect(h.gates[gateIdx]?.run.agentId).toBe(speaker)
      const p = h.gates[gateIdx]!.run.payload as { debate: { phase: string; stance: string; opponent: string }; context: string[] }
      expect(p.debate.phase).toBe('rebuttal')
      expect(p.context).toEqual([targetCtx])
    }
    expectRebuttal(2, 'a2', 'a1：正方：Rust 安全')
    h.gates[2]!.resolve({ text: '驳：学习曲线陡' })
    await h.flush()
    expectRebuttal(3, 'a1', 'a2：驳：学习曲线陡')
    h.gates[3]!.resolve({ text: '驳：编译器兜底' })
    await h.flush()
    expectRebuttal(4, 'a2', 'a1：驳：编译器兜底')
    h.gates[4]!.resolve({ text: '再驳：生态慢' })
    await h.flush()
    expectRebuttal(5, 'a1', 'a2：再驳：生态慢')
    h.gates[5]!.resolve({ text: '终驳：值回票价' })
    await h.flush()
    // 汇总轮：无管家注入 → 次选未参辩成员 a3（旁观者清）；context = 全部六段发言
    expect(h.gates[6]?.run.agentId).toBe('a3')
    const sum = h.gates[6]!.run.payload as { mode: string; debate: { phase: string }; context: string[] }
    expect(sum.mode).toBe('debate')
    expect(sum.debate).toEqual({ phase: 'summary' })
    expect(sum.context).toEqual([
      'a1：正方：Rust 安全',
      'a2：反方：Go 简单',
      'a2：驳：学习曲线陡',
      'a1：驳：编译器兜底',
      'a2：再驳：生态慢',
      'a1：终驳：值回票价',
    ])
    h.gates[6]!.resolve({ text: '分歧在安全预算 vs 交付速度' })
    await h.flush()
    expect(h.gates).toHaveLength(7) // 收敛——不再入队
  })

  it('提及顺序定正反（文本出现序——@反 在前则其为正方；提及表序不干扰）', async () => {
    const h = makeHarness((id) => (id === 'a1' ? '甲' : id === 'a2' ? '乙' : undefined))
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#辩论 @乙 @甲 今晚吃啥', nonce: 'n1' })
    // 文本里 @乙（a2）在前 → a2 为正方（成员表序 a1,a2 不干扰）
    expect(h.gates.map((g) => g.run.agentId)).toEqual(['a2', 'a1'])
    const p0 = h.gates[0]!.run.payload as { debate: { stance: string } }
    expect(p0.debate.stance).toBe('pro')
    const p1 = h.gates[1]!.run.payload as { debate: { stance: string } }
    expect(p1.debate.stance).toBe('con')
  })

  it('不足两方：回退轮转并注记（同 #点名 空点名式样）——mode 痕不落', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#辩论 就我一个人', nonce: 'n1' })
    expect(h.gates).toHaveLength(1) // 回退轮转（首员依序）
    expect((h.gates[0]!.run.payload as { mode?: string }).mode).toBeUndefined()
    const notes = (await h.transcript.readAll(group.groupId))
      .filter((r) => r.kind === 'group-sys')
      .map((r) => (r.payload as { text: string }).text)
    expect(notes.some((n) => n.includes('需 @ 点名正反两方'))).toBe(true)
  })

  it('一方未亮立场（opening pass）：辩论终止——另一方观点已在群流如实呈现', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#辩论 @a1 @a2 话题', nonce: 'n1' })
    h.gates[0]!.resolve({ text: '[pass]' })
    await h.flush()
    h.gates[1]!.resolve({ text: '反方立场' })
    await h.flush()
    // 双方结算完毕但正方缺席 → 终止注记 + 收敛（无驳斥轮入队）
    expect(h.gates).toHaveLength(2)
    const notes = (await h.transcript.readAll(group.groupId))
      .filter((r) => r.kind === 'group-sys')
      .map((r) => (r.payload as { text: string }).text)
    expect(notes.some((n) => n.includes('一方未亮立场——辩论终止'))).toBe(true)
  })

  it('supersede 对辩论在途轮生效：驳斥中插话 → 旧轮结算静默丢弃、新轮开始', async () => {
    const h = makeHarness()
    h.register('a1')
    h.register('a2')
    const group = await h.service.createGroup({ name: 'g', memberAgentIds: ['a1', 'a2'] })
    await h.service.sendUserMessage({ groupId: group.groupId, text: '#辩论 @a1 @a2 话题', nonce: 'n1' })
    h.gates[0]!.resolve({ text: '正方立场' })
    await h.flush()
    h.gates[1]!.resolve({ text: '反方立场' })
    await h.flush()
    expect(h.gates[2]?.run.agentId).toBe('a2') // 驳斥轮在队
    // 插话（supersede：gen bump——在途驳斥结算时静默丢弃）
    await h.service.sendUserMessage({ groupId: group.groupId, text: '换话题了', nonce: 'n2' })
    expect(h.gates[3]?.run.agentId).toBe('a1') // 新轮轮转已入队
    h.gates[2]!.resolve({ text: '迟到的驳斥' })
    await h.flush()
    expect(h.gates).toHaveLength(4) // 旧轮结算不推进任何新入队
    expect((h.gates[3]!.run.payload as { text: string }).text).toBe('换话题了')
  })
})
