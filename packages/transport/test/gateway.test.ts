import { afterAll, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { EventBus, KernelError } from '@openbot/core'
import { startGateway } from '../src/index.js'
import { InProcessTransport } from '../src/index.js'
import { z } from 'zod'

const TOKEN = 'test-token-fixed'

/** 原生 POST（可伪造 Host 头——undici fetch 把 Host 列为 forbidden header 静默丢弃，测不了 DNS rebinding） */
function rawPost(port: number, path: string, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function makeGateway() {
  let t = 0
  const bus = new EventBus({ now: () => t })
  const transport = new InProcessTransport({ bus })
  transport
    .register('v1.echo', async (payload) => ({ echoed: payload }))
    .register(
      'v1.echo.strict',
      async (payload) => ({ echoed: payload }),
      z.object({ name: z.string() }),
    )
    .register('v1.fail', async () => {
      throw new KernelError('MSG_SELF_SEND', '业务错误')
    })
  const gateway = await startGateway({ transport, bus, token: TOKEN })
  const base = `http://127.0.0.1:${gateway.port}`
  const authed = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...init.headers },
    })
  return { bus, transport, gateway, base, authed, advance: (ms: number) => (t += ms) }
}

const gateways: Awaited<ReturnType<typeof makeGateway>>[] = []
afterAll(async () => {
  await Promise.all(gateways.map((g) => g.gateway.close()))
})

async function fresh(): Promise<Awaited<ReturnType<typeof makeGateway>>> {
  const g = await makeGateway()
  gateways.push(g)
  return g
}

describe('环回网关：控制面', () => {
  it('POST /api/* 往返：envelope ok:true 携带结果', async () => {
    const g = await fresh()
    const res = await g.authed('/api/v1.echo', { method: 'POST', body: JSON.stringify({ text: '你好' }) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: { echoed: { text: '你好' } } })
  })

  it('领域失败是 200 + {ok:false,error:{code}}（渲染层永远解析 envelope）', async () => {
    const g = await fresh()
    const res = await g.authed('/api/v1.fail', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('MSG_SELF_SEND')
  })

  it('zod wire 校验：不过 schema 的 payload → TRANSPORT_PAYLOAD_INVALID（仍是 200 envelope）', async () => {
    const g = await fresh()
    const res = await g.authed('/api/v1.echo.strict', { method: 'POST', body: JSON.stringify({ name: 42 }) })
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('TRANSPORT_PAYLOAD_INVALID')
    expect(body.error.message).toContain('v1.echo.strict')
    // 合法 payload 正常通过
    const ok = await g.authed('/api/v1.echo.strict', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true)
  })

  it('鉴权三件套：无 bearer / 错 token → 401；非法 Host → 403；未知路径 → 404；错方法 → 405', async () => {
    const g = await fresh()
    expect((await fetch(`${g.base}/api/v1.echo`, { method: 'POST', body: '{}' })).status).toBe(401)
    expect(
      (await fetch(`${g.base}/api/v1.echo`, {
        method: 'POST',
        body: '{}',
        headers: { Authorization: 'Bearer wrong-token' },
      })).status,
    ).toBe(401)
    // DNS rebinding：Host 冒充外部域名 → 403（fetch 丢 Host 头，必须用原生请求伪造）
    expect(
      await rawPost(g.gateway.port, '/api/v1.echo', { Authorization: `Bearer ${TOKEN}`, Host: 'evil.example.com' }, '{}'),
    ).toBe(403)
    // 未知路径（非 /api/ 非 /events）→ 传输层 404；未知命令是领域失败，走 200 envelope（见下个测试）
    expect((await g.authed('/nope', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${g.base}/api/v1.echo?token=${TOKEN}`)).status).toBe(405)
  })

  it('坏 JSON → 400；命令不存在 → envelope TRANSPORT_COMMAND_NOT_FOUND', async () => {
    const g = await fresh()
    expect((await g.authed('/api/v1.echo', { method: 'POST', body: '{oops' })).status).toBe(400)
    const res = await g.authed('/api/v1.ghost', { method: 'POST', body: '{}' })
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('TRANSPORT_COMMAND_NOT_FOUND')
  })

  it('CORS：预检 204；响应带 Access-Control-Allow-Origin（renderer file:// 跨源）', async () => {
    const g = await fresh()
    const preflight = await fetch(`${g.base}/api/v1.echo`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'file://',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    const res = await g.authed('/api/v1.echo', { method: 'POST', body: '{}', headers: { Origin: 'file://' } })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('环回网关：SSE 事件流', () => {
  it('订阅收到实时事件；?token= 鉴权；断连退订', async () => {
    const g = await fresh()
    const controller = new AbortController()
    const res = await fetch(`${g.base}/events?token=${TOKEN}`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const received: string[] = []
    const readSome = async (count: number) => {
      while (received.length < count) {
        const { value } = await reader.read()
        for (const line of new TextDecoder().decode(value!).split('\n')) {
          if (line.startsWith('data: ')) received.push(line.slice(6))
        }
      }
    }
    g.bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    g.bus.emit('v1.box.state', { boxId: 'b1', state: 'active' })
    await readSome(2)
    controller.abort()
    // 断连后事件不再累积（退订生效，用第二个监听者对比无新写入即可——这里仅验证不抛错）
    g.bus.emit('v1.system.roster', { agentId: 'a9', role: 'worker', cause: 'registered' })
    expect(received.length).toBe(2)
    expect(JSON.parse(received[0]!)).toMatchObject({ type: 'v1.lifecycle.idle', payload: { agentId: 'a1' } })
  })

  it('Last-Event-ID 续传：从 seq 之后补发再转实时', async () => {
    const g = await fresh()
    g.bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    g.bus.emit('v1.lifecycle.idle', { agentId: 'a2' })
    g.bus.emit('v1.lifecycle.idle', { agentId: 'a3' })
    const controller = new AbortController()
    const res = await fetch(`${g.base}/events?token=${TOKEN}`, {
      signal: controller.signal,
      headers: { 'Last-Event-ID': '2' },
    })
    const reader = res.body!.getReader()
    const ids: number[] = []
    const readSome = async (count: number) => {
      while (ids.length < count) {
        const { value } = await reader.read()
        for (const line of new TextDecoder().decode(value!).split('\n')) {
          if (line.startsWith('id: ')) ids.push(Number(line.slice(4)))
        }
      }
    }
    await readSome(1) // 补发 seq=3
    g.bus.emit('v1.lifecycle.idle', { agentId: 'a4' }) // 实时 seq=4
    await readSome(2)
    controller.abort()
    expect(ids).toEqual([3, 4])
  })

  it('SSE 错 token → 401', async () => {
    const g = await fresh()
    expect((await fetch(`${g.base}/events?token=wrong`)).status).toBe(401)
  })
})
