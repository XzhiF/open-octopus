import { describe, it, expect } from 'vitest'
import { PiAgentProvider } from '../../pi/provider'

describe('PiAgentProvider', () => {
  it('getType returns "pi"', () => {
    const provider = new PiAgentProvider()
    expect(provider.getType()).toBe('pi')
  })

  it('API key missing yields auth_missing error (TC-019)', async () => {
    const provider = new PiAgentProvider()
    const original = process.env.DASHSCOPE_API_KEY
    delete process.env.DASHSCOPE_API_KEY

    const chunks: any[] = []
    for await (const chunk of provider.sendQuery('test', '/tmp', undefined, {
      model: 'dashscope/qwen3-max',
    })) {
      chunks.push(chunk)
    }

    expect(chunks[0].type).toBe('error')
    expect(chunks[0].code).toBe('auth_missing')
    expect(chunks[0].message).toContain('DASHSCOPE_API_KEY')

    if (original) process.env.DASHSCOPE_API_KEY = original
  })

  it('pre-aborted signal yields error without creating session (TC-028)', async () => {
    const provider = new PiAgentProvider()
    const controller = new AbortController()
    controller.abort()

    const chunks: any[] = []
    for await (const chunk of provider.sendQuery('test', '/tmp', undefined, {
      model: 'openai/gpt-4o',
      abortSignal: controller.signal,
      env: { OPENAI_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    expect(chunks[0].type).toBe('error')
    expect(chunks[0].code).toBe('aborted')
  })

  it('abort produces no chunks after bridge.end (P1-5, I7)', async () => {
    const { AsyncEventBridge } = await import('../../pi/async-bridge')
    const bridge = new AsyncEventBridge<string, string>((e) => e)
    const controller = new AbortController()

    controller.signal.addEventListener('abort', () => bridge.end(), { once: true })
    controller.abort()
    bridge.push('should-be-discarded')

    const results: string[] = []
    for await (const chunk of bridge.generator()) {
      results.push(chunk)
    }
    expect(results).toEqual([])
  })
})
