/**
 * automations 测试（backlog ②）：store CRUD/上限/损坏降级 + cron 纯函数矩阵
 * （解析语法/日周 OR 语义/nextAfter 逐场景/永不触发规则）。
 */
import { describe, expect, it } from 'vitest'
import { InMemoryFs } from '../src/fs/index.js'
import {
  AutomationStore,
  AUTOMATION_LIMIT,
  nextAfter,
  parseCron,
} from '../src/automations/index.js'

const make = () => {
  const fs = new InMemoryFs()
  let seq = 0
  const store = new AutomationStore({
    fs,
    root: 'data',
    nextId: () => `a-${++seq}`,
    now: () => 1_000,
  })
  return { fs, store }
}

/** 2026-09-01 是周二；基准取该日 08:00 本机时区无关（Date 用本地时区构造） */
const T = (s: string): number => new Date(s).getTime()

describe('AutomationStore', () => {
  it('add/list 往返 + 重启恢复（同根新实例）', async () => {
    const { fs, store } = make()
    const a = await store.add({ name: '早报', cron: '0 9 * * *', agentId: 'steward', prompt: '汇总昨日', enabled: true })
    expect(await store.list()).toEqual([a])
    const raw = JSON.parse(fs.snapshot()['data/automations.json'] as string)
    expect(raw.version).toBe(1)
    const reborn = new AutomationStore({ fs, root: 'data' })
    expect(await reborn.list()).toEqual([a])
  })

  it('cron 非法拒绝（段数/字符/越界）——稳定码；name/prompt 空超长拒绝', async () => {
    const { store } = make()
    const bad = ['0 9 * *', '* * * * * *', '60 * * * *', '* 24 * * *', 'a * * * *', '*/0 * * * *', '5-1 * * * *']
    for (const cron of bad) {
      await expect(store.add({ name: 'x', cron, agentId: 's', prompt: 'p', enabled: true })).rejects.toMatchObject({
        code: 'STATE_AUTOMATION_INVALID',
      })
    }
    await expect(store.add({ name: '', cron: '* * * * *', agentId: 's', prompt: 'p', enabled: true })).rejects.toMatchObject({
      code: 'STATE_AUTOMATION_INVALID',
    })
    await expect(store.add({ name: 'x', cron: '* * * * *', agentId: 's', prompt: '  ', enabled: true })).rejects.toMatchObject({
      code: 'STATE_AUTOMATION_INVALID',
    })
  })

  it('上限 16（裁定 C）；update/remove/markRun；不存在稳定码', async () => {
    const { store } = make()
    for (let i = 0; i < AUTOMATION_LIMIT; i++) {
      await store.add({ name: `r${i}`, cron: '* * * * *', agentId: 's', prompt: 'p', enabled: true })
    }
    await expect(store.add({ name: 'over', cron: '* * * * *', agentId: 's', prompt: 'p', enabled: true })).rejects.toMatchObject({
      code: 'STATE_AUTOMATION_LIMIT',
    })
    const first = (await store.list())[0]!
    const updated = await store.update(first.id, { enabled: false, name: '改名' })
    expect(updated.enabled).toBe(false)
    expect(updated.name).toBe('改名')
    await store.markRun(first.id, 1_234)
    expect((await store.list()).find((a) => a.id === first.id)?.lastRunAt).toBe(1_234)
    await store.remove(first.id)
    expect((await store.list()).some((a) => a.id === first.id)).toBe(false)
    await expect(store.update('nope', { enabled: true })).rejects.toMatchObject({ code: 'STATE_AUTOMATION_NOT_FOUND' })
    await expect(store.remove('nope')).rejects.toMatchObject({ code: 'STATE_AUTOMATION_NOT_FOUND' })
    await expect(store.markRun('nope', 1)).resolves.toBeUndefined() // 删除在途的触发静默收敛
  })

  it('损坏文件降级空表', async () => {
    const { fs } = make()
    await fs.write('data/automations.json', '{broken')
    const store = new AutomationStore({ fs, root: 'data' })
    expect(await store.list()).toEqual([])
  })
})

describe('cron 纯函数', () => {
  it('parseCron：合法形状通过；非法返回 null', () => {
    expect(parseCron('*/15 * * * 1-5')).not.toBeNull()
    expect(parseCron('0,30 9-18 1 1 0')).not.toBeNull()
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('99 * * * *')).toBeNull()
  })

  it('nextAfter：每天 9 点——当天 8 点取当天 9 点；当天 10 点取次日 9 点', () => {
    expect(nextAfter('0 9 * * *', T('2026-09-01T08:00:00'))).toBe(T('2026-09-01T09:00:00'))
    expect(nextAfter('0 9 * * *', T('2026-09-01T10:00:00'))).toBe(T('2026-09-02T09:00:00'))
    // 边界：9 点整本身不算（从 from 之后一分钟起）——取次日
    expect(nextAfter('0 9 * * *', T('2026-09-01T09:00:00'))).toBe(T('2026-09-02T09:00:00'))
  })

  it('nextAfter：每 15 分钟（*/15）与工作日 dow 范围（周二在/周日不在）', () => {
    expect(nextAfter('*/15 * * * *', T('2026-09-01T08:01:00'))).toBe(T('2026-09-01T08:15:00'))
    // 2026-09-01 周二：0 9 * * 1-5 → 当天；2026-09-06 周日 → 跳到周一 09-07
    expect(nextAfter('0 9 * * 1-5', T('2026-09-01T08:00:00'))).toBe(T('2026-09-01T09:00:00'))
    expect(nextAfter('0 9 * * 1-5', T('2026-09-06T10:00:00'))).toBe(T('2026-09-07T09:00:00'))
  })

  it('nextAfter：永不触发的规则返回 null（2 月 30 日）', () => {
    expect(nextAfter('0 0 30 2 *', T('2026-09-01T00:00:00'))).toBeNull()
  })
})
