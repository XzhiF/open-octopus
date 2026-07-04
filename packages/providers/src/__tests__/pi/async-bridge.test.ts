import { describe, it, expect } from 'vitest'
import { AsyncEventBridge } from '../../pi/async-bridge'

describe('AsyncEventBridge', () => {
  it('push 3 events + end → consumer receives 3 values (TC-004)', async () => {
    const bridge = new AsyncEventBridge<string, string>((e) => e)
    bridge.push('a')
    bridge.push('b')
    bridge.push('c')
    bridge.end()

    const results: string[] = []
    for await (const chunk of bridge.generator()) {
      results.push(chunk)
    }
    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('fail → consumer throws (TC-005)', async () => {
    const bridge = new AsyncEventBridge<string, string>((e) => e)
    bridge.fail(new Error('timeout'))

    await expect(async () => {
      for await (const _ of bridge.generator()) { /* drain */ }
    }).rejects.toThrow('timeout')
  })

  it('mapper return null → filtered out', async () => {
    const bridge = new AsyncEventBridge<string, string>((e) => e === 'keep' ? e : null)
    bridge.push('keep')
    bridge.push('drop')
    bridge.push('keep')
    bridge.end()

    const results: string[] = []
    for await (const chunk of bridge.generator()) {
      results.push(chunk)
    }
    expect(results).toEqual(['keep', 'keep'])
  })

  it('mapper return array → expanded', async () => {
    const bridge = new AsyncEventBridge<string, string>((e) => e === 'multi' ? ['x', 'y'] : [e])
    bridge.push('multi')
    bridge.push('single')
    bridge.end()

    const results: string[] = []
    for await (const chunk of bridge.generator()) {
      results.push(chunk)
    }
    expect(results).toEqual(['x', 'y', 'single'])
  })

  it('push after end is discarded (I7)', async () => {
    const bridge = new AsyncEventBridge<string, string>((e) => e)
    bridge.end()
    bridge.push('ignored')

    const results: string[] = []
    for await (const chunk of bridge.generator()) {
      results.push(chunk)
    }
    expect(results).toEqual([])
  })

  it('end is idempotent', () => {
    const bridge = new AsyncEventBridge<string, string>((e) => e)
    bridge.end()
    bridge.end()
  })
})
