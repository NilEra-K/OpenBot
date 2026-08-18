import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../src/events.js'

describe('@openbot/transport', () => {
  it('协议版本为 v1（P0 占位断言）', () => {
    expect(PROTOCOL_VERSION).toBe('v1')
  })
  it('P0 骨架占位——真实测试自 P1 起', () => {
    expect(true).toBe(true)
  })
})
