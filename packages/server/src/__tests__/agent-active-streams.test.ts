import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listActiveStreams,
  registerActiveStream,
  unregisterActiveStream,
} from '../services/agent/agent-service'

const PREFIX = 'test-running-'

describe('listActiveStreams', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists only sessions with live streams and reports the earliest start', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-23T10:00:00.000Z'))
    const firstA = registerActiveStream(`${PREFIX}a`, () => {})
    vi.setSystemTime(new Date('2026-10-23T10:00:01.000Z'))
    const firstB = registerActiveStream(`${PREFIX}b`, () => {})
    const secondB = registerActiveStream(`${PREFIX}b`, () => {})

    try {
      const list = listActiveStreams().filter((item) => item.sessionId.startsWith(PREFIX))
      expect(list.map((item) => item.sessionId)).toEqual([`${PREFIX}b`, `${PREFIX}a`])
      expect(list[0].streamCount).toBe(2)
      expect(new Date(list[0].startedAt).toISOString()).toBe('2026-10-23T10:00:01.000Z')
    } finally {
      unregisterActiveStream(`${PREFIX}a`, firstA)
      unregisterActiveStream(`${PREFIX}b`, firstB)
      unregisterActiveStream(`${PREFIX}b`, secondB)
    }
  })

  it('drops sessions once their last stream unregisters', () => {
    const stream = registerActiveStream(`${PREFIX}c`, () => {})
    expect(listActiveStreams().some((item) => item.sessionId === `${PREFIX}c`)).toBe(true)
    unregisterActiveStream(`${PREFIX}c`, stream)
    expect(listActiveStreams().some((item) => item.sessionId === `${PREFIX}c`)).toBe(false)
  })
})
