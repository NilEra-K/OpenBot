import { describe, expect, it } from 'vitest'
import { DEFAULT_RETRY_POLICY, nextRetryDelayMs, shouldRetry } from '../src/index.js'
import type { RunOutcome } from '../src/index.js'

function outcome(state: RunOutcome['state'], attempts = 1): RunOutcome {
  return { runId: 'run-1', agentId: 'a1', state, attempts, finishedAt: 0 }
}

describe('RunLifecycle 策略纯函数', () => {
  it('仅 failed 可重试；aborted 的续命是 messaging 重驱，不叫重试', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxRetries: 2 }
    expect(shouldRetry(outcome('failed'), policy)).toBe(true)
    expect(shouldRetry(outcome('aborted'), policy)).toBe(false)
    expect(shouldRetry(outcome('escaped'), policy)).toBe(false)
    expect(shouldRetry(outcome('succeeded'), policy)).toBe(false)
  })

  it('attempts 超过 maxRetries 不再重试', () => {
    const policy = { maxRetries: 2, backoffMs: [] }
    expect(shouldRetry(outcome('failed', 1), policy)).toBe(true)
    expect(shouldRetry(outcome('failed', 2), policy)).toBe(true)
    expect(shouldRetry(outcome('failed', 3), policy)).toBe(false)
  })

  it('nextRetryDelayMs：1 起计数，越界取末位，空表为 0', () => {
    const policy = { maxRetries: 5, backoffMs: [10, 20, 40] }
    expect(nextRetryDelayMs(1, policy)).toBe(10)
    expect(nextRetryDelayMs(2, policy)).toBe(20)
    expect(nextRetryDelayMs(3, policy)).toBe(40)
    expect(nextRetryDelayMs(99, policy)).toBe(40)
    expect(nextRetryDelayMs(1, { maxRetries: 0, backoffMs: [] })).toBe(0)
  })
})
