/**
 * 确定性 mock——测试地基，与 boxes/backend-mock 对称（接口完全一致）。
 * 脚本顺序消费：每次 chat() 取下一步；脚本耗尽显式抛错（不兜底）。
 * requests 记录收到的每个请求，供断言「runner 喂了什么」。
 * 流式对称：请求带 onText 时把终态文本按定长拆块逐块回调（与 backend-mock 按行拆块同哲学，
 * 聚合结果不变——流是实况、聚合是事实）。
 * 参考：ARCHITECTURE.md §3.3 —— P1 实现。
 */
import { LlmError, LlmErrorCodes } from '../provider/index.js'
import type { ChatProvider, ChatRequest, ChatResponse, ToolCall } from '../provider/index.js'

/** 脚本一步：text 与 toolCalls 可任意组合；reasoning = 思考增量（v0.1.48 真思考持久化测试面） */
export interface MockStep {
  text?: string | null
  toolCalls?: ToolCall[]
  reasoning?: string
}

export interface MockChatProviderOptions {
  steps: readonly MockStep[]
  model?: string
}

/** mock 流式拆块长度（码元）：小到足以演示增量，大到不产生海量回调 */
const MOCK_CHUNK_CODE_UNITS = 3

export class MockChatProvider implements ChatProvider {
  // mock 模拟的是完整端点（含视觉——E2E wire 断言依赖 image part 通行）
  readonly capabilities = { supportsImages: true } as const

  readonly #steps: readonly MockStep[]
  readonly #model: string
  #cursor = 0
  readonly requests: ChatRequest[] = []

  constructor(options: MockChatProviderOptions) {
    this.#steps = options.steps
    this.#model = options.model ?? 'mock-1'
  }

  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    if (signal?.aborted) {
      throw new LlmError(LlmErrorCodes.LLM_ABORTED, '请求前已被中止')
    }
    // 深拷贝留痕：调用方（turn 引擎）会在请求后继续原数组，引用会让观察失真；
    // onText/onThinking 是回调函数不可克隆，留痕剥离（回调本身不参与断言——v0.1.43 补 onThinking）
    const { onText: _onText, onThinking: _onThinking, ...cloneable } = request
    this.requests.push(structuredClone(cloneable))
    const step = this.#steps[this.#cursor]
    if (!step) {
      throw new LlmError(
        LlmErrorCodes.LLM_MOCK_SCRIPT_EXHAUSTED,
        `第 ${this.#cursor + 1} 次 chat() 无脚本步（脚本共 ${this.#steps.length} 步）`,
      )
    }
    this.#cursor += 1
    const response: ChatResponse = {
      text: step.text ?? null,
      toolCalls: step.toolCalls ? [...step.toolCalls] : [],
      meta: { model: this.#model },
    }
    if (request.onText && response.text !== null) {
      for (let i = 0; i < response.text.length; i += MOCK_CHUNK_CODE_UNITS) {
        request.onText(response.text.slice(i, i + MOCK_CHUNK_CODE_UNITS))
      }
    }
    if (request.onThinking && step.reasoning !== undefined) {
      for (let i = 0; i < step.reasoning.length; i += MOCK_CHUNK_CODE_UNITS) {
        request.onThinking(step.reasoning.slice(i, i + MOCK_CHUNK_CODE_UNITS))
      }
    }
    return response
  }

  /** 已消费步数（断言用） */
  get consumed(): number {
    return this.#cursor
  }
}
