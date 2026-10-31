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

/** 内容分段（plan-computer-use Step 2 多模态）：文本或图像（base64——内部规范形，
 *  wire 编码归各协议实现：openai-compat 的 image_url data URI / anthropic 的 source.base64） */
export interface ContentPart {
  type: 'text' | 'image'
  text?: string
  image?: { base64: string; mime: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 纯文本快路径（既有消息零变化）；多模态消息用分段数组 */
  content: string | ContentPart[]
  /** role=assistant 历史消息携带的命令 */
  toolCalls?: ToolCall[]
  /** role=tool 消息对应的 ToolCall.id */
  toolCallId?: string
}

/** provider 能力声明（plan-computer-use）：supportsImages=true 才注册 computer 工具族 */
export interface ProviderCapabilities {
  /** 图像输入（截图→多模态模型）——档案级声明，缺省 false（不放假能力） */
  supportsImages?: boolean
  /** 1M 上下文档位（v0.1.111 附件注入预算）：true=1M 档；缺省=128k 档（预算随窗口走） */
  context1M?: boolean
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
  /**
   * 流式文本增量回调（可选）：提供时 provider 走流式协议，逐块回调回复文本增量——
   * 聚合语义不变，chat() 仍返回完整 ChatResponse（流是实况、聚合是事实）。
   * 纯工具调用回合可能零次回调（无可视文本）。
   */
  onText?: (delta: string) => void
  /**
   * 思考增量回调（可选，v0.1.43）：与 onText 独立的推理流——anthropic 协议的
   * thinking_delta / openai-compat 的 reasoning_content（GLM、DeepSeek 系思考字段）。
   * 思考不进 ChatResponse（text 是正文事实——UI 实况分流用，见 runner 双通道 emit）。
   */
  onThinking?: (delta: string) => void
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
  /** 能力声明（P8-4 后 UI 优化）：supportsImages 决定截图回喂格式（图像 part / 文本降级）；缺省视为无 */
  readonly capabilities?: ProviderCapabilities
}
