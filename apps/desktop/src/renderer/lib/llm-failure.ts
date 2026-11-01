/**
 * LLM/运行失败的人话文案（v0.1.113 用户报障「只知道报错不知道原因」）：
 * 稳定 code → 一句人话 + 端点原文摘录（原文来自 run.abortReason——llm abort 流的
 * err.message，含端点诊断如 `HTTP 400: ...`；协议只传 code 的裁定不变，原文走
 * WS /stream 实况通道，文案与翻译归渲染层）。
 */

/** 常见失败 code → 人话（未知 code 原样展示） */
const HUMAN: Record<string, string> = {
  // 400 归因细分见 failureText 内（v0.1.115：图片类拒绝与超窗是不同根因——曾一律归因超窗误导报障）
  LLM_HTTP_400: '请求被模型端点拒绝——见端点原文定位（常见：图片不被支持 / 上下文超窗 / 消息格式）',
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

/** 400 按端点原文细分（v0.1.115 用户报障链：messages[N].image 被拒被误归因超窗） */
const detail400 = (detail: string | undefined): string | null => {
  if (detail === undefined) return null
  if (/image|photo|图片/i.test(detail)) return '图片不被端点支持（尺寸/格式限制）——压缩或换格式后重发'
  if (/context|token|length|maximum/i.test(detail)) return '上下文超窗口——大文件已自动转预览+分段读取，或 /compact 压缩会话后重发'
  return null
}

const briefOf = (detail: string | undefined): string =>
  // v0.1.117b：原文上限 80 → 400 字（用户报障链取证需要——"unsupported" 后的定音词
  // 在截断处之后；m-fail 可换行不撑 UI）
  detail !== undefined && detail !== '' ? `｜端点原文：${detail.slice(0, 400)}${detail.length > 400 ? '…' : ''}` : ''

/**
 * 失败原因一句话。code 人话优先；400 按原文细分；detail（abortReason 原文，如 `HTTP 400: {...}`）
 * 摘前 80 字附后——人话定位类别、原文补端点细节。
 */
export function failureText(code: string | undefined, detail?: string): string {
  if (code === 'LLM_HTTP_400') {
    const fine = detail400(detail)
    if (fine !== null) return `${fine}${briefOf(detail)}`
  }
  const human = code !== undefined ? HUMAN[code] : undefined
  if (human !== undefined) return `${human}${briefOf(detail)}`
  return `${code ?? '未知原因'}${briefOf(detail)}`
}
