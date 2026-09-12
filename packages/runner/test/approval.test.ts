import { describe, expect, it } from 'vitest'
import { EventBus } from '@openbot/core'
import { IdempotencyLedger, InMemoryFs } from '@openbot/state'
import { AutoApprovalGate, gated, hostFetchTool, StaticApprovalGate, SwitchableApprovalGate, ToolRegistry } from '../src/index.js'
import type { ToolContext } from '../src/index.js'

function makeGate() {
  let t = 0
  let counter = 0
  const fs = new InMemoryFs()
  const bus = new EventBus({ now: () => t })
  const events: string[] = []
  bus.on('*', (e) => events.push(e.type))
  const ledger = new IdempotencyLedger({ fs, root: 'data', now: () => t })
  const gate = new AutoApprovalGate({ bus, ledger, now: () => t, nextApprovalId: () => `appr-${++counter}` })
  return { gate, ledger, events, bus }
}

const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  agentId: 'a1',
  runId: 'run-1',
  originMessageId: 'msg-9',
  toolCallId: 'c1',
  boxId: null,
  signal: new AbortController().signal,
  ...overrides,
})

describe('AutoApprovalGate（CLI 自动批准，账本照记）', () => {
  it('自动批准：requested+resolved 事件对、账本 done；重试同 nonce 回放决定、不双发事件', async () => {
    const { gate, ledger, events } = makeGate()
    const first = await gate.request({ runId: 'run-1', agentId: 'a1', tool: 'host_fetch', nonce: 'msg-9:c1' })
    expect(first).toBe(true)
    expect(events).toEqual(['v1.approval.requested', 'v1.approval.resolved'])
    const entry = await ledger.lookup('approval:msg-9:c1')
    expect(entry?.status).toBe('done')
    expect(entry?.outcome).toBe(true)
    const retry = await gate.request({ runId: 'run-1', agentId: 'a1', tool: 'host_fetch', nonce: 'msg-9:c1' })
    expect(retry).toBe(true)
    expect(events).toEqual(['v1.approval.requested', 'v1.approval.resolved']) // 无新事件
  })

  it('同 nonce 不同操作：账本拒绝（不双执行防线的另一半）', async () => {
    const { gate } = makeGate()
    await gate.request({ runId: 'run-1', agentId: 'a1', tool: 'host_fetch', nonce: 'n' })
    await expect(
      gate.request({ runId: 'run-2', agentId: 'a1', tool: 'host_exec', nonce: 'n' }),
    ).rejects.toMatchObject({ code: 'LEDGER_DIGEST_MISMATCH' })
  })
})

describe('gated() 闸门包装', () => {
  it('拒绝：不执行工具，回喂 APPROVAL_DENIED 文本', async () => {
    const tool = gated(hostFetchTool(), { gate: new StaticApprovalGate(false) })
    const result = await tool.execute(ctx(), { url: 'https://example.com' })
    expect(result).toContain('错误 APPROVAL_DENIED')
    expect(result).not.toContain('example.com')
  })

  it('放行：工具正常执行', async () => {
    const tool = gated(hostFetchTool(), { gate: new StaticApprovalGate(true) })
    const result = await tool.execute(ctx(), { url: 'https://example.com' })
    expect(result).toContain('宿主网络桩')
    expect(result).toContain('example.com')
  })

  it('经 ToolRegistry 执行同样过闸（组装路径验证）', async () => {
    const registry = new ToolRegistry().register(
      gated(hostFetchTool(), { gate: new StaticApprovalGate(false) }),
    )
    const result = await registry.execute(ctx(), { id: 'c1', name: 'host_fetch', args: { url: 'https://x' } })
    expect(result).toContain('APPROVAL_DENIED')
  })

  it('幂等键派生自 originMessageId + toolCallId（redrive 后稳定）', async () => {
    const requests: string[] = []
    const gate = {
      async request(req: { nonce: string }): Promise<boolean> {
        requests.push(req.nonce)
        return true
      },
    }
    const tool = gated(hostFetchTool(), { gate })
    await tool.execute(ctx(), { url: 'https://x' })
    await tool.execute(ctx({ runId: 'run-重驱后的新run' }), { url: 'https://x' })
    expect(requests).toEqual(['msg-9:c1', 'msg-9:c1'])
  })

  it('审批挂起中 run 中止：抛 APPROVAL_RUN_ABORTED（不再等决议）', async () => {
    // 永不决议的闸门——审批挂起（真实对应：用户弹窗未答）
    const gate = { request: () => new Promise<boolean>(() => {}) }
    const tool = gated(hostFetchTool(), { gate })
    const controller = new AbortController()
    const pending = tool.execute(ctx({ signal: controller.signal }), { url: 'https://x' })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'APPROVAL_RUN_ABORTED' })
  })

  it('已中止的 run 请求过闸：立即作废（不进闸门请求）', async () => {
    let requested = false
    const gate = {
      async request(): Promise<boolean> {
        requested = true
        return true
      },
    }
    const tool = gated(hostFetchTool(), { gate })
    const controller = new AbortController()
    controller.abort()
    await expect(
      tool.execute(ctx({ signal: controller.signal }), { url: 'https://x' }),
    ).rejects.toMatchObject({ code: 'APPROVAL_RUN_ABORTED' })
    expect(requested).toBe(false)
  })
})


// ---- 可切换闸门（2026-09-06 预算打穿问用户 + composer 审批模式下拉） ----
describe('SwitchableApprovalGate', () => {
  /** 内件替身：manual 侧——记录请求、返回指定决定（不测 Manual 本体，测委托与切换） */
  const stubGate = (verdict: boolean) => {
    const calls: string[] = []
    let revoked = 0
    return {
      calls,
      revoked: () => revoked,
      gate: {
        async request(req: { nonce: string }): Promise<boolean> {
          calls.push(req.nonce)
          return verdict
        },
        async revokeRun(_runId: string): Promise<number> {
          revoked += 1
          return 1
        },
      } as unknown as import('../src/index.js').ApprovalGate,
    }
  }

  it('manual 模式：request 委托手动内件（替身收到请求）', async () => {
    const stub = stubGate(true)
    const gate = new SwitchableApprovalGate({
      manual: stub.gate,
      auto: new AutoApprovalGate({ bus: new EventBus({ now: () => 0 }), ledger: new IdempotencyLedger({ fs: new InMemoryFs(), root: 'd', now: () => 0 }), now: () => 0, nextApprovalId: () => 'a' }),
      bus: new EventBus({ now: () => 0 }),
    })
    expect(gate.mode).toBe('manual')
    expect(await gate.request({ runId: 'r', agentId: 'a', tool: 't', nonce: 'n1' })).toBe(true)
    expect(stub.calls).toEqual(['n1'])
  })

  it('setMode 热切换：切到 auto 后委托自动内件（返回 true——自动批准）', async () => {
    const stub = stubGate(false) // 手动替身拒绝——若委托错误会收到
    const bus = new EventBus({ now: () => 0 })
    const gate = new SwitchableApprovalGate({
      manual: stub.gate,
      auto: new AutoApprovalGate({ bus, ledger: new IdempotencyLedger({ fs: new InMemoryFs(), root: 'd', now: () => 0 }), now: () => 0, nextApprovalId: () => 'a' }),
      bus,
    })
    gate.setMode('auto')
    expect(gate.mode).toBe('auto')
    expect(await gate.request({ runId: 'r', agentId: 'a', tool: 't', nonce: 'n2' })).toBe(true)
    expect(stub.calls).toEqual([]) // 手动内件零委托
  })

  it('revokeRun：两个内件都善后（挂起请求可能散在切换两侧）', async () => {
    const manualStub = stubGate(true)
    const revokedAuto = { n: 0 }
    const autoStub = {
      async request(): Promise<boolean> {
        return true
      },
      async revokeRun(): Promise<number> {
        revokedAuto.n += 1
        return 1
      },
    } as unknown as import('../src/index.js').ApprovalGate
    const gate = new SwitchableApprovalGate({ manual: manualStub.gate, auto: autoStub, bus: new EventBus({ now: () => 0 }) })
    expect(await gate.revokeRun('r-1')).toBe(2)
    expect(manualStub.revoked()).toBe(1)
    expect(revokedAuto.n).toBe(1)
  })
})
