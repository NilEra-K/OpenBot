/**
 * LLM/运行失败的人话文案（v0.1.113 用户报障「只知道报错不知道原因」）：
 * 稳定 code → 一句人话 + 端点原文摘录（原文来自 run.abortReason——llm abort 流的
 * err.message，含端点诊断如 `HTTP 400: ...`；协议只传 code 的裁定不变，原文走
 * WS /stream 实况通道，文案与翻译归渲染层）。
 */

/** 常见失败 code → 人话（未知 code 原样展示） */
const HUMAN: Record<string, string> = {
  LLM_HTTP_400: '请求被模型端点拒绝——多为上下文超窗口（大文件已自动转预览+分段读取，重发即可）',
  LLM_HTTP_401: '鉴权失败——检查供应商 API Key',
  LLM_HTTP_403: '鉴权失败——检查 API Key 权限',
  LLM_HTTP_404: '接口地址或模型名不存在——检查 baseUrl 与模型 id',
  LLM_HTTP_429: '触发模型限流——稍等片刻再试',
  LLM_HTTP_500: '模型服务内部错误——稍后再试',
  LLM_HTTP_502: '模型服务网关错误——稍后再试',
  LLM_HTTP_503: '模型服务暂不可用——稍后再试',
  LLM_TIMEOUT: '模型响应超时',
  LLM_REQUEST_FAILED: '网络请求失败——检查网络与代理',
  LLM_RESPONSE_INVALID: '模型响应格式异常',
  RUN_DEADLINE: '本轮执行超时',
  RUN_GRACE_EXCEEDED: '本轮长时间无进展被回收',
}

/**
 * 失败原因一句话。code 人话优先；detail（abortReason 原文，如 `HTTP 400: {"error":...}`）
 * 摘前 80 字附后——人话定位类别、原文补端点细节。
 */
export function failureText(code: string | undefined, detail?: string): string {
  const human = code !== undefined ? HUMAN[code] : undefined
  const brief = detail !== undefined && detail !== '' ? `｜端点原文：${detail.slice(0, 80)}${detail.length > 80 ? '…' : ''}` : ''
  if (human !== undefined) return `${human}${brief}`
  return `${code ?? '未知原因'}${brief}`
}
