/**
 * 输入历史（终端式 ↑/↓ 翻阅——2026-11-01 用户需求）：composer 发送过的文本按
 * **对话对象分桶**（私聊 agentId / 群 groupId）各自独立留存，最多 100 条/桶，连续重复
 * 不重复入。localStorage 持久（纯 UI 便利功能、非领域事实——不进内核协议/状态包）。
 *
 * storage 注入式（测试替身零依赖）；坏 JSON 降级空（localStorage 手改/损坏不炸输入框）。
 */

const STORAGE_KEY = 'openbot:input-history:v1'
const BUCKET_LIMIT = 100

/** 存储最小面（localStorage 结构化满足；测试注入内存替身） */
export interface HistoryStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 全量结构（单 key 原子读写）：{ [会话对象]: 旧→新文本数组 } */
type AllBuckets = Record<string, string[]>

function readAll(store: HistoryStore): AllBuckets {
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: AllBuckets = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = [...v]
    }
    return out
  } catch {
    return {} // 坏 JSON 如实降级空表（不清写——下次 setItem 自然覆盖修复）
  }
}

function writeAll(store: HistoryStore, all: AllBuckets): void {
  store.setItem(STORAGE_KEY, JSON.stringify(all))
}

/** 读指定会话对象的输入历史（旧→新；末位 = 最近发送） */
export function loadBucket(store: HistoryStore, sessionKey: string): string[] {
  return readAll(store)[sessionKey] ?? []
}

/** 追加一条（发送点调用）：连续重复跳过；超 100 丢最旧。空文本不入（附件占位场景） */
export function pushHistory(store: HistoryStore, sessionKey: string, text: string): void {
  if (text.trim() === '') return
  const all = readAll(store)
  const bucket = all[sessionKey] ?? []
  if (bucket[bucket.length - 1] === text) return // 连续去重（bash 同款——改发变体不受影响）
  bucket.push(text)
  if (bucket.length > BUCKET_LIMIT) bucket.splice(0, bucket.length - BUCKET_LIMIT)
  all[sessionKey] = bucket
  writeAll(store, all)
}
