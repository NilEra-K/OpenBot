/**
 * 确定性 mock——测试地基，与 boxes/backend-mock 对称（接口完全一致）。
 * 脚本顺序消费：每次 chat() 取下一步；脚本耗尽显式抛错（不兜底）。
 * requests 记录收到的每个请求，供断言「runner 喂了什么」。
 * 参考：ARCHITECTURE.md §3.3 —— P1 实现。
 */
import { LlmError, LlmErrorCodes } from '../provider/index.js'
import type { ChatProvider, ChatRequest, ChatResponse, ToolCall } from '../provider/index.js'

/** 脚本一步：text 与 toolCalls 可任意组合 */
export interface MockStep {
  text?: string | null
  toolCalls?: ToolCall[]
}

export interface MockChatProviderOptions {
  steps: readonly MockStep[]
  model?: string
}

export class MockChatProvider implements ChatProvider {
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
    // 深拷贝留痕：调用方（turn 引擎）会在请求后继续原数组，引用会让观察失真
    this.requests.push(structuredClone(request))
    const step = this.#steps[this.#cursor]
    if (!step) {
      throw new LlmError(
        LlmErrorCodes.LLM_MOCK_SCRIPT_EXHAUSTED,
        `第 ${this.#cursor + 1} 次 chat() 无脚本步（脚本共 ${this.#steps.length} 步）`,
      )
    }
    this.#cursor += 1
    return {
      text: step.text ?? null,
      toolCalls: step.toolCalls ? [...step.toolCalls] : [],
      meta: { model: this.#model },
    }
  }

  /** 已消费步数（断言用） */
  get consumed(): number {
    return this.#cursor
  }
}
