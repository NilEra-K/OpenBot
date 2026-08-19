/**
 * ChatProvider 抽象：薄客户端的统一表面——runner 只认这个接口，不认任何厂商协议。
 * llm 是边界层（ARCHITECTURE.md §3.3）：不依赖任何包，错误自带稳定 code，
 * 上层（runner）负责转为内核 KernelError。
 */

/** 稳定错误 code（UPPER_SNAKE_CASE；文案归渲染层） */
export const LlmErrorCodes = {
  /** 请求开始前 signal 已中止 */
  LLM_ABORTED: 'LLM_ABORTED',
  /** 网络/请求层失败（fetch reject、DNS 等） */
  LLM_REQUEST_FAILED: 'LLM_REQUEST_FAILED',
  /** 请求超时（timeoutMs 或 signal 到期） */
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  /** 响应结构非法（缺 choices/消息体） */
  LLM_RESPONSE_INVALID: 'LLM_RESPONSE_INVALID',
  /** mock 脚本耗尽：显式失败，不许悄悄兜底——确定性测试要的是显式暴露 */
  LLM_MOCK_SCRIPT_EXHAUSTED: 'LLM_MOCK_SCRIPT_EXHAUSTED',
} as const

/** llm 边界层错误：携带稳定 code */
export class LlmError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'LlmError'
    this.code = code
  }
}

/** 模型发起的工具调用（协议中立：name + args，工具注册表归 runner） */
export interface ToolCall {
  /** 调用实例 id（回喂 role=tool 消息时对应） */
  id: string
  name: string
  args: unknown
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** role=assistant 历史消息携带的命令 */
  toolCalls?: ToolCall[]
  /** role=tool 消息对应的 ToolCall.id */
  toolCallId?: string
}

/** 工具描述（argsSchema 为 JSON Schema 形状的可选约束，openai-compat 映射为 parameters） */
export interface ToolSpec {
  name: string
  description: string
  argsSchema?: unknown
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolSpec[]
  system?: string
}

export interface ChatResponse {
  /** 回复文本；纯工具调用回合可为 null */
  text: string | null
  /** 要执行的工具命令；空数组 = turn 结束（无命令即完成） */
  toolCalls: ToolCall[]
  /** 诊断信息（模型标识等，不进协议） */
  meta?: { model?: string }
}

export interface ChatProvider {
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
}
