import { describe, it, expect } from 'vitest'
import { AsyncEventBridge } from '../pi/async-event-bridge'

// ═══════════════════════════════════════════════════
// Basic push / pull
// ═══════════════════════════════════════════════════

describe('AsyncEventBridge - basic push/pull', () => {
  it('yields pushed events in order', async () => {
    const bridge = new AsyncEventBridge<string>()

    // Push events, then close — all before consuming
    bridge.push('a')
    bridge.push('b')
    bridge.push('c')
    bridge.close()

    const received: string[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toEqual(['a', 'b', 'c'])
  })

  it('yields events pushed after iteration starts', async () => {
    const bridge = new AsyncEventBridge<number>()
    const received: number[] = []

    const consumer = (async () => {
      for await (const event of bridge) {
        received.push(event)
      }
    })()

    // Give the consumer time to start waiting
    await delay(10)

    bridge.push(1)
    bridge.push(2)
    bridge.close()

    await consumer

    expect(received).toEqual([1, 2])
  })

  it('handles empty stream (close with no events)', async () => {
    const bridge = new AsyncEventBridge<string>()
    bridge.close()

    const received: string[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toEqual([])
  })
})

// ═══════════════════════════════════════════════════
// Async iteration protocol
// ═══════════════════════════════════════════════════

describe('AsyncEventBridge - async iteration protocol', () => {
  it('implements Symbol.asyncIterator', () => {
    const bridge = new AsyncEventBridge<string>()
    bridge.close()

    expect(bridge[Symbol.asyncIterator]).toBeDefined()
    expect(typeof bridge[Symbol.asyncIterator]).toBe('function')
  })

  it('returns an AsyncIterator from Symbol.asyncIterator', () => {
    const bridge = new AsyncEventBridge<string>()
    bridge.close()

    const iterator = bridge[Symbol.asyncIterator]()
    expect(iterator).toBeDefined()
    expect(typeof iterator.next).toBe('function')
  })

  it('supports manual async iteration via next()', async () => {
    const bridge = new AsyncEventBridge<string>()
    bridge.push('hello')
    bridge.close()

    const iterator = bridge[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first).toEqual({ value: 'hello', done: false })

    const second = await iterator.next()
    expect(second.done).toBe(true)
  })

  it('works with for-await-of', async () => {
    const bridge = new AsyncEventBridge<number>()
    bridge.push(10)
    bridge.push(20)
    bridge.close()

    const received: number[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toEqual([10, 20])
  })
})

// ═══════════════════════════════════════════════════
// Concurrent push operations
// ═══════════════════════════════════════════════════

describe('AsyncEventBridge - concurrent operations', () => {
  it('handles rapid sequential pushes', async () => {
    const bridge = new AsyncEventBridge<number>()
    const count = 100

    for (let i = 0; i < count; i++) {
      bridge.push(i)
    }
    bridge.close()

    const received: number[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toHaveLength(count)
    expect(received).toEqual(Array.from({ length: count }, (_, i) => i))
  })

  it('handles multiple producers pushing concurrently', async () => {
    const bridge = new AsyncEventBridge<string>()
    const received: string[] = []

    const consumer = (async () => {
      for await (const event of bridge) {
        received.push(event)
      }
    })()

    await delay(10)

    // Simulate two producers pushing concurrently
    const producer1 = async () => {
      for (let i = 0; i < 5; i++) {
        bridge.push(`p1-${i}`)
        await delay(1)
      }
    }

    const producer2 = async () => {
      for (let i = 0; i < 5; i++) {
        bridge.push(`p2-${i}`)
        await delay(1)
      }
    }

    await Promise.all([producer1(), producer2()])
    bridge.close()
    await consumer

    // All 10 events should be received
    expect(received).toHaveLength(10)
    // Both producers' events should be present
    const p1Events = received.filter(e => e.startsWith('p1-'))
    const p2Events = received.filter(e => e.startsWith('p2-'))
    expect(p1Events).toHaveLength(5)
    expect(p2Events).toHaveLength(5)
  })

  it('preserves per-producer ordering', async () => {
    const bridge = new AsyncEventBridge<string>()
    const received: string[] = []

    const consumer = (async () => {
      for await (const event of bridge) {
        received.push(event)
      }
    })()

    await delay(10)

    // Producer A pushes a0..a4, Producer B pushes b0..b4
    bridge.push('a0')
    bridge.push('b0')
    bridge.push('a1')
    bridge.push('b1')
    bridge.push('a2')
    bridge.push('b2')
    bridge.close()

    await consumer

    // Verify a-events appear in order relative to each other
    const aEvents = received.filter(e => e.startsWith('a'))
    expect(aEvents).toEqual(['a0', 'a1', 'a2'])

    // Verify b-events appear in order relative to each other
    const bEvents = received.filter(e => e.startsWith('b'))
    expect(bEvents).toEqual(['b0', 'b1', 'b2'])
  })
})

// ═══════════════════════════════════════════════════
// Graceful shutdown (close method)
// ═══════════════════════════════════════════════════

describe('AsyncEventBridge - graceful shutdown', () => {
  it('drains buffered events after close', async () => {
    const bridge = new AsyncEventBridge<string>()

    bridge.push('buffered-1')
    bridge.push('buffered-2')
    bridge.close()

    const received: string[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toEqual(['buffered-1', 'buffered-2'])
  })

  it('close is idempotent', async () => {
    const bridge = new AsyncEventBridge<string>()

    bridge.push('event')
    bridge.close()
    bridge.close() // Should not throw or cause issues
    bridge.close()

    const received: string[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toEqual(['event'])
  })

  it('ignores pushes after close', async () => {
    const bridge = new AsyncEventBridge<string>()

    bridge.push('before')
    bridge.close()
    bridge.push('after') // Should be silently ignored

    const received: string[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toEqual(['before'])
  })

  it('reports isClosed state', () => {
    const bridge = new AsyncEventBridge<string>()

    expect(bridge.isClosed).toBe(false)
    bridge.close()
    expect(bridge.isClosed).toBe(true)
  })

  it('close wakes a waiting consumer', async () => {
    const bridge = new AsyncEventBridge<string>()
    const received: string[] = []

    const consumer = (async () => {
      for await (const event of bridge) {
        received.push(event)
      }
    })()

    // Consumer is waiting for events
    await delay(20)

    bridge.close()
    await consumer

    // Consumer should have exited cleanly
    expect(received).toEqual([])
  })
})

// ═══════════════════════════════════════════════════
// Error propagation
// ═══════════════════════════════════════════════════

describe('AsyncEventBridge - error propagation', () => {
  it('throws pushed error during iteration', async () => {
    const bridge = new AsyncEventBridge<string>()

    bridge.push('ok')
    bridge.pushError(new Error('boom'))

    const received: string[] = []
    let caughtError: unknown

    try {
      for await (const event of bridge) {
        received.push(event)
      }
    } catch (err) {
      caughtError = err
    }

    expect(received).toEqual(['ok'])
    expect(caughtError).toBeInstanceOf(Error)
    expect((caughtError as Error).message).toBe('boom')
  })

  it('error before any events', async () => {
    const bridge = new AsyncEventBridge<string>()

    bridge.pushError(new Error('immediate failure'))

    let caughtError: unknown
    try {
      for await (const _event of bridge) {
        // Should not reach here
      }
    } catch (err) {
      caughtError = err
    }

    expect(caughtError).toBeInstanceOf(Error)
    expect((caughtError as Error).message).toBe('immediate failure')
  })

  it('error pushed while consumer is waiting', async () => {
    const bridge = new AsyncEventBridge<string>()

    const consumerPromise = (async () => {
      const received: string[] = []
      let caughtError: unknown

      try {
        for await (const event of bridge) {
          received.push(event)
        }
      } catch (err) {
        caughtError = err
      }

      return { received, caughtError }
    })()

    await delay(10)

    bridge.push('late-event')
    await delay(5)
    bridge.pushError(new Error('late error'))

    const result = await consumerPromise

    expect(result.received).toEqual(['late-event'])
    expect(result.caughtError).toBeInstanceOf(Error)
    expect((result.caughtError as Error).message).toBe('late error')
  })

  it('pushError after close is silently ignored', async () => {
    const bridge = new AsyncEventBridge<string>()

    bridge.push('event')
    bridge.close()
    bridge.pushError(new Error('should be ignored'))

    const received: string[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toEqual(['event'])
  })
})

// ═══════════════════════════════════════════════════
// Integration: real-world usage pattern
// ═══════════════════════════════════════════════════

describe('AsyncEventBridge - integration', () => {
  it('simulates Pi SDK event flow', async () => {
    interface PiEvent {
      type: string
      data?: unknown
    }

    const bridge = new AsyncEventBridge<PiEvent>()

    // Simulate Pi SDK callbacks
    const simulateSdk = async () => {
      await delay(5)
      bridge.push({ type: 'text_delta', data: 'Hello' })
      await delay(5)
      bridge.push({ type: 'text_delta', data: ' World' })
      await delay(5)
      bridge.push({ type: 'result', data: { tokens: 42 } })
      bridge.close()
    }

    simulateSdk() // Fire and forget — producer runs in background

    const received: PiEvent[] = []
    for await (const event of bridge) {
      received.push(event)
    }

    expect(received).toHaveLength(3)
    expect(received[0]).toEqual({ type: 'text_delta', data: 'Hello' })
    expect(received[1]).toEqual({ type: 'text_delta', data: ' World' })
    expect(received[2]).toEqual({ type: 'result', data: { tokens: 42 } })
  })

  it('simulates SDK error mid-stream', async () => {
    const bridge = new AsyncEventBridge<string>()

    const simulateSdk = async () => {
      bridge.push('chunk-1')
      await delay(5)
      bridge.push('chunk-2')
      await delay(5)
      bridge.pushError(new Error('connection reset'))
    }

    simulateSdk()

    const received: string[] = []
    let caughtError: unknown

    try {
      for await (const event of bridge) {
        received.push(event)
      }
    } catch (err) {
      caughtError = err
    }

    expect(received).toEqual(['chunk-1', 'chunk-2'])
    expect((caughtError as Error).message).toBe('connection reset')
  })
})

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
