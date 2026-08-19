import { describe, expect, it } from 'vitest'
import { EventBus, KernelError } from '@openbot/core'
import { InProcessTransport, TransportErrorCodes } from '../src/index.js'

function makeTransport() {
  let t = 0
  const bus = new EventBus({ now: () => t })
  const transport = new InProcessTransport({ bus })
  return { bus, transport, advance: (ms: number) => (t += ms) }
}

describe('InProcessTransport 命令面', () => {
  it('注册与调用往返：payload 进、结果出', async () => {
    const { transport } = makeTransport()
    transport.register('v1.message.sendUser', async (payload) => ({
      echoed: (payload as { text: string }).text,
    }))
    const client = transport.createClient()
    const res = await client.call<{ echoed: string }>('v1.message.sendUser', { text: '你好' })
    expect(res.echoed).toBe('你好')
  })

  it('未知命令：TRANSPORT_COMMAND_NOT_FOUND', async () => {
    const { transport } = makeTransport()
    const client = transport.createClient()
    await expect(client.call('v1.nope')).rejects.toMatchObject({
      code: 'TRANSPORT_COMMAND_NOT_FOUND',
    })
  })

  it('KernelError 按 code 透传拒绝；非 Error 拒绝值兜底归类', async () => {
    const { transport } = makeTransport()
    transport.register('v1.fail.kerr', async () => {
      throw new KernelError('MSG_SELF_SEND', '业务错误')
    })
    transport.register('v1.fail.weird', async () => {
      throw '裸字符串' // eslint-disable-line no-throw-literal -- 故意构造非 Error 拒绝
    })
    const client = transport.createClient()
    await expect(client.call('v1.fail.kerr')).rejects.toMatchObject({ code: 'MSG_SELF_SEND' })
    await expect(client.call('v1.fail.weird')).rejects.toMatchObject({
      code: 'TRANSPORT_COMMAND_FAILED',
    })
  })

  it('重复注册同名命令：装配期直接拒绝', () => {
    const { transport } = makeTransport()
    transport.register('v1.x', async () => 1)
    expect(() => transport.register('v1.x', async () => 2)).toThrowError(
      expect.objectContaining({ code: TransportErrorCodes.TRANSPORT_COMMAND_DUPLICATE }),
    )
    expect(transport.has('v1.x')).toBe(true)
    expect(transport.listCommands()).toEqual(['v1.x'])
  })
})

describe('InProcessTransport 事件面', () => {
  it('订阅收到内核事件；退订后不再收；eventsSince 按 seq 重放', async () => {
    const { bus, transport, advance } = makeTransport()
    const client = transport.createClient()
    const seen: string[] = []
    const off = client.subscribe((e) => seen.push(e.type))
    advance(1)
    bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    bus.emit('v1.box.state', { boxId: 'b1', state: 'active' })
    off()
    bus.emit('v1.lifecycle.idle', { agentId: 'a1' })
    expect(seen).toEqual(['v1.lifecycle.idle', 'v1.box.state'])
    expect(client.eventsSince(1).map((e) => e.seq)).toEqual([2, 3])
  })
})
