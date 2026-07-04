import { describe, it, expect } from 'vitest'
import { PiAgentProvider, resolveSystemPrompt } from '../../pi/provider'
import { classifyProviderError } from '../../errors'
import { TokenAggregator } from '../../pi/token-aggregator'

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

  it('S08-6: budget_exceeded error is classifiable and roundtrips through error classifier (TC-020)', () => {
    // Simulate the budget enforcement error message that provider.ts emits
    const agg = new TokenAggregator()
    agg.add('qwen-max', { input: 500, output: 200, cost: { total: 0.055 } })
    const maxBudgetUsd = 0.05

    // Verify the budget check logic works
    expect(agg.totalCost() >= maxBudgetUsd).toBe(true)

    // Simulate the error that provider.ts would throw
    const budgetError = new Error(
      `budget_exceeded: Budget limit exceeded. Accumulated cost $${agg.totalCost().toFixed(6)} >= maxBudgetUsd $${maxBudgetUsd}.`
    )

    // Verify the error classifier recognizes it
    const classified = classifyProviderError(budgetError, { provider: 'dashscope' })
    expect(classified.code).toBe('budget_exceeded')
    expect(classified.message).toContain('Budget limit exceeded')
  })

  it('S08-6: resolveSystemPrompt handles all input types correctly', () => {
    // string passthrough
    expect(resolveSystemPrompt('You are a helpful assistant')).toBe('You are a helpful assistant')
    // undefined returns undefined
    expect(resolveSystemPrompt(undefined)).toBeUndefined()
    // preset with append
    expect(resolveSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'extra' })).toBe('extra')
    // preset without append
    expect(resolveSystemPrompt({ type: 'preset', preset: 'claude_code' })).toBeUndefined()
  })
})
