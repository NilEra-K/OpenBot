/**
 * 环回网关客户端（renderer 内存版）：fetch 控制面 + EventSource 事件流。
 * 业务面零内核 import——只有 type import（编译期擦除）；错误永远解析 envelope（ARCHITECTURE.md §5：
 * 领域失败是正常结果，code 稳定、文案归渲染层）。
 * 测试对称：endpoint 与实现都可注入替换（E2E/单测喂 mock 网关）。
 */
import type { KernelEvent } from '@openbot/transport'

/** 命令的领域失败（envelope {ok:false}）：code 稳定，渲染层据此分流文案 */
export class GatewayCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GatewayCommandError'
  }
}

/** 传输层失败（非 200 / 网络断）：重连或提示级 */
export class GatewayTransportError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'GatewayTransportError'
  }
}

export interface GatewayEndpoint {
  port: number
  token: string
}

export interface GatewayClient {
  call<T = unknown>(command: string, payload?: unknown): Promise<T>
  subscribe(handler: (event: KernelEvent) => void): () => void
}

export function createGatewayClient(endpoint: GatewayEndpoint): GatewayClient {
  const base = `http://127.0.0.1:${endpoint.port}`
  return {
    async call<T = unknown>(command: string, payload: unknown = {}): Promise<T> {
      let res: Response
      try {
        res = await fetch(`${base}/api/${command}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${endpoint.token}`,
          },
          body: JSON.stringify(payload),
        })
      } catch (err) {
        throw new GatewayTransportError(0, `网关不可达：${err instanceof Error ? err.message : String(err)}`)
      }
      if (res.status !== 200) {
        throw new GatewayTransportError(res.status, `网关传输错误：HTTP ${res.status}`)
      }
      const envelope = (await res.json()) as
        | { ok: true; result: T }
        | { ok: false; error: { code: string; message: string } }
      if (!envelope.ok) {
        throw new GatewayCommandError(envelope.error.code, envelope.error.message)
      }
      return envelope.result
    },
    subscribe(handler: (event: KernelEvent) => void): () => void {
      // EventSource 无法自定义 header——token 走查询参数（网关侧约定）；
      // 断线自动重连由浏览器承担，Last-Event-ID 自动续传
      const es = new EventSource(`${base}/events?token=${endpoint.token}`)
      es.onmessage = (message) => handler(JSON.parse(message.data) as KernelEvent)
      return () => es.close()
    },
  }
}
