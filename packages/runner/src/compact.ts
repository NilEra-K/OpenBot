/**
 * 会话压缩器（会话引擎 v2 · P2/P3，docs/session-engine.md）：把会话活动段早期轮次压成
 * 结构化摘要，落 compact 记录（append-only——组装侧按记录位置切活动层，同 /clear 模式）。
 * 近期轮保留原文（keptRounds）——摘要层承接长期记忆，活动层保近期细节。
 * 触发：手动 /compact（v1.session.compact）+ 自动（runner 级③压力信号 → 装配异步调用）。
 */
import { LlmError } from '@openbot/llm'
import type { ChatProvider } from '@openbot/llm'
import type { TranscriptStore } from '@openbot/state'
import { sessionView } from './turn/session-view.js'
import type { SessionRecord } from './turn/session-view.js'

/** 压缩请求参数 */
export interface CompactOptions {
  /** 保留近期轮数（原文不动；只压之前的段） */
  keptRounds?: number
  /** 触发方式（记录溯源） */
  trigger: 'manual' | 'auto'
  /** 可选焦点指令（/compact 保留 XX 相关） */
  focus?: string
}

/** 压缩产物（coveredSeq 供审计/UI 注记——组装侧按记录位置切） */
export interface CompactResult {
  coveredSeq: number
  keptRecords: number
  summary: string
}

const SUMMARY_PROMPT = `把以下对话历史压缩为结构化摘要（Markdown），供后续对话作为长期记忆。必须包含四节：
## 决定与约定（用户拍板过的规则/偏好/方案取舍）
## 关键事实（人物/环境/文件路径/数据结论——后续会引用的具体信息）
## 未完事项（进行中任务/待确认问题）
## 有效附件（讨论过的关键文件与其要点）
要求：只保留对后续工作有用的信息；保留具体名词与路径；不加评论。`

/** 会话记录 → 纯文本对话（压缩输入；thinking/exec 等过程记录不进摘要——只压领域消息） */
function renderConvo(records: SessionRecord[]): string {
  const lines: string[] = []
  for (const r of records) {
    const text = (r.payload as { text?: unknown }).text
    if (typeof text !== 'string' || text === '') continue
    const who = r.kind === 'user' ? '用户' : r.kind === 'agent' ? '助手' : '系统'
    lines.push(`${who}：${text}`)
  }
  return lines.join('\n\n')
}

/**
 * 压缩一个会话（sessionKey = agentId 私聊 / groupId 群聊——同一实现通吃）。
 * 活动段过短（不足以留下 keptRounds 后还有余量）时返回 null（无事可压——诚实跳过）。
 */
export async function compactSession(
  deps: {
    transcript: TranscriptStore
    llmOf: (agentId: string) => ChatProvider
    nextRunId: () => string
  },
  agentId: string,
  sessionKey: string,
  options: CompactOptions,
): Promise<CompactResult | null> {
  const keptRounds = options.keptRounds ?? 6
  const records = sessionView(await deps.transcript.readAll(sessionKey)).records
  // 轮 = user 起；从尾往前找第 keptRounds 个 user 的位置——其后保留
  let keptFrom = records.length
  let rounds = 0
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i]!.kind === 'user') {
      rounds += 1
      if (rounds >= keptRounds) {
        keptFrom = i
        break
      }
    }
  }
  if (rounds < keptRounds) return null // 会话不足 keptRounds 轮——无事可压
  const toCover = records.slice(0, keptFrom).filter((r: SessionRecord) => r.kind === 'user' || r.kind === 'agent')
  if (toCover.length === 0) return null
  const convo = renderConvo(toCover)
  if (convo === '') return null
  const focusLine = options.focus !== undefined && options.focus !== '' ? `\n\n用户焦点指令（优先保留相关内容）：${options.focus}` : ''
  let summary: string
  const runId = deps.nextRunId()
  try {
    const resp = await deps.llmOf(agentId).chat(
      {
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: `${convo.slice(0, 200_000)}${focusLine}` },
        ],
      },
      undefined,
    )
    summary = resp.text ?? ''
  } catch (err) {
    if (err instanceof LlmError || err instanceof Error) {
      throw new Error(`压缩摘要生成失败：${err.message}`)
    }
    throw new Error('压缩摘要生成失败：未知错误')
  }
  if (summary.trim() === '') return null
  const coveredSeq = toCover.at(-1)!.seq ?? -1
  await deps.transcript.append(sessionKey, 'compact', {
    summary,
    coveredSeq,
    keptRounds,
    trigger: options.trigger,
    ...(options.focus !== undefined ? { focus: options.focus } : {}),
    byRun: runId,
  })
  return { coveredSeq, keptRecords: records.length - keptFrom, summary }
}
