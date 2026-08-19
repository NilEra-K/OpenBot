import { describe, expect, it } from 'vitest'
import { KernelError } from '@openbot/core'
import { digestOf, IdempotencyLedger, InMemoryFs } from '../src/index.js'

function makeLedger() {
  let t = 0
  const fs = new InMemoryFs()
  const ledger = new IdempotencyLedger({ fs, root: 'data', now: () => t })
  return {
    fs,
    ledger,
    advance(ms: number): void {
      t += ms
    },
  }
}

describe('IdempotencyLedger', () => {
  it('begin 首次受理 first:true；同 nonce 同 digest 重试 first:false（零双发）', async () => {
    const { ledger } = makeLedger()
    const digest = digestOf({ text: 'hi' })
    const first = await ledger.begin('msg:1', digest)
    const retry = await ledger.begin('msg:1', digest)
    expect(first.first).toBe(true)
    expect(first.entry.status).toBe('pending')
    expect(retry.first).toBe(false)
    expect(retry.entry.status).toBe('pending')
  })

  it('同 nonce 不同 digest：LEDGER_DIGEST_MISMATCH（重放错配防御）', async () => {
    const { ledger } = makeLedger()
    await ledger.begin('msg:1', digestOf({ text: 'hi' }))
    await expect(ledger.begin('msg:1', digestOf({ text: 'changed' }))).rejects.toMatchObject({
      code: 'LEDGER_DIGEST_MISMATCH',
    })
  })

  it('commit 记录首次结局；重复 commit 幂等不改写', async () => {
    const { ledger } = makeLedger()
    await ledger.begin('msg:1', digestOf({ text: 'hi' }))
    const done = await ledger.commit('msg:1', { delivered: true })
    expect(done.status).toBe('done')
    expect(done.outcome).toEqual({ delivered: true })
    const again = await ledger.commit('msg:1', { delivered: '第二次提交被忽略' })
    expect(again.outcome).toEqual({ delivered: true })
  })

  it('commit 未知 nonce：LEDGER_NONCE_NOT_FOUND', async () => {
    const { ledger } = makeLedger()
    await expect(ledger.commit('msg:ghost', null)).rejects.toMatchObject({
      code: 'LEDGER_NONCE_NOT_FOUND',
    })
  })

  it('重试方在 commit 后再 begin：first:false 且可取回首次结局（durable acceptance）', async () => {
    const { ledger } = makeLedger()
    const digest = digestOf({ text: 'hi' })
    await ledger.begin('msg:1', digest)
    await ledger.commit('msg:1', { ok: true })
    const retry = await ledger.begin('msg:1', digest)
    expect(retry.first).toBe(false)
    expect(retry.entry.outcome).toEqual({ ok: true })
    expect((await ledger.lookup('msg:1'))?.status).toBe('done')
  })

  it('崩溃后重开：JSONL 重放恢复 pending→done 状态（后行覆盖前行）', async () => {
    const { fs } = makeLedger()
    let t = 0
    const first = new IdempotencyLedger({ fs, root: 'data', now: () => t })
    t = 1
    await first.begin('msg:1', 'd1')
    await first.commit('msg:1', { ok: 1 })
    await first.begin('msg:2', 'd2') // 仍 pending
    t = 50
    const second = new IdempotencyLedger({ fs, root: 'data', now: () => t })
    expect((await second.lookup('msg:1'))?.status).toBe('done')
    expect((await second.lookup('msg:1'))?.outcome).toEqual({ ok: 1 })
    expect((await second.lookup('msg:2'))?.status).toBe('pending')
    expect(await second.lookup('msg:3')).toBeNull()
  })

  it('KernelError 携带稳定 code 与诊断 message', async () => {
    const { ledger } = makeLedger()
    try {
      await ledger.begin('msg:1', 'a')
      await ledger.begin('msg:1', 'b')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(KernelError)
      const ke = err as KernelError
      expect(ke.code).toBe('LEDGER_DIGEST_MISMATCH')
      expect(ke.message).toContain('msg:1')
    }
  })

  it('listPending：前缀过滤 + 只返回挂起项（崩溃恢复扫描入口）', async () => {
    const { ledger } = makeLedger()
    await ledger.begin('approval:n1', 'd1')
    await ledger.begin('approval:n2', 'd2')
    await ledger.begin('msg:m1', 'd3')
    await ledger.commit('approval:n2', true)
    expect(await ledger.listPending('approval:')).toHaveLength(1)
    expect((await ledger.listPending('approval:'))[0]!.nonce).toBe('approval:n1')
    expect(await ledger.listPending()).toHaveLength(2) // approval:n1 + msg:m1（无前缀全量）
    expect(await ledger.listPending('task:')).toEqual([])
  })
})
