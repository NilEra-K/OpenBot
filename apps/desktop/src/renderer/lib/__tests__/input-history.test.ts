/**
 * 输入历史（分桶持久）单测：round-trip、上限 100、连续去重、桶间隔离、坏 JSON 降级、
 * 空文本不入。storage 内存替身（HistoryStore 注入面）。
 */
import { describe, expect, it } from 'vitest'
import { loadBucket, pushHistory, type HistoryStore } from '../input-history.js'

const memStore = (): HistoryStore & { dump(): Record<string, string> } => {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  }
}

describe('input-history（终端式输入历史——按对话对象分桶）', () => {
  it('round-trip：push 后 load 可读回（旧→新，末位 = 最近）', () => {
    const s = memStore()
    pushHistory(s, 'agent-a', '第一条')
    pushHistory(s, 'agent-a', '第二条')
    expect(loadBucket(s, 'agent-a')).toEqual(['第一条', '第二条'])
    expect(loadBucket(s, 'agent-a')?.at(-1)).toBe('第二条')
  })

  it('分桶隔离：agent 与群各自独立（用户裁定——不同 Agent 之间的历史要隔离）', () => {
    const s = memStore()
    pushHistory(s, 'agent-a', '给 A 的')
    pushHistory(s, 'group-g', '发到群的')
    pushHistory(s, 'agent-b', '给 B 的')
    expect(loadBucket(s, 'agent-a')).toEqual(['给 A 的'])
    expect(loadBucket(s, 'group-g')).toEqual(['发到群的'])
    expect(loadBucket(s, 'agent-b')).toEqual(['给 B 的'])
    expect(loadBucket(s, 'agent-c')).toEqual([]) // 陌生桶如实空
  })

  it('上限 100：超限丢最旧（保留最近 100 条）', () => {
    const s = memStore()
    for (let i = 1; i <= 105; i++) pushHistory(s, 'k', `msg-${i}`)
    const bucket = loadBucket(s, 'k')
    expect(bucket).toHaveLength(100)
    expect(bucket[0]).toBe('msg-6') // 前 5 条被丢
    expect(bucket[99]).toBe('msg-105')
  })

  it('连续去重：同文本连续 push 只留一条；非连续重复保留', () => {
    const s = memStore()
    pushHistory(s, 'k', '一样的话')
    pushHistory(s, 'k', '一样的话')
    expect(loadBucket(s, 'k')).toEqual(['一样的话'])
    pushHistory(s, 'k', '别的话')
    pushHistory(s, 'k', '一样的话') // 非连续——保留（真实重复发送场景）
    expect(loadBucket(s, 'k')).toEqual(['一样的话', '别的话', '一样的话'])
  })

  it('空文本不入（附件占位发送不产生空历史项）', () => {
    const s = memStore()
    pushHistory(s, 'k', '')
    pushHistory(s, 'k', '   ')
    expect(loadBucket(s, 'k')).toEqual([])
  })

  it('坏 JSON 降级空表（localStorage 损坏不炸输入框）；非字符串项剔除', () => {
    const s = memStore()
    s.setItem('openbot:input-history:v1', '{oops 不是 json')
    expect(loadBucket(s, 'k')).toEqual([])
    // 坏结构（数组/非串项）：整体形状不符即空；桶内混入非串剔除该桶
    s.setItem('openbot:input-history:v1', '["数组不是对象"]')
    expect(loadBucket(s, 'k')).toEqual([])
    s.setItem('openbot:input-history:v1', JSON.stringify({ k: ['ok', 42, 'also-ok'] }))
    expect(loadBucket(s, 'k')).toEqual([]) // 桶内出现非串 → 该桶弃用（诚实降级不部分采用）
    pushHistory(s, 'k', '修复后的第一条') // 下次写入自然覆盖修复
    expect(loadBucket(s, 'k')).toEqual(['修复后的第一条'])
  })
})
