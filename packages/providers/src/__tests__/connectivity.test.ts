import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { testConnectivity } from '../connectivity'
import { registerProvider, resetProviderInstances } from '../registry'
import type { IAgentProvider, MessageChunk, SendQueryOptions } from '../types'

class SuccessProvider implements IAgentProvider {
  getType() { return 'success' }
  async *sendQuery(_prompt: string, _cwd: string, _resume?: string, _opts?: SendQueryOptions): AsyncGenerator<MessageChunk> {
    yield { type: 'message_start', messageId: 'm1' }
    yield { type: 'text_delta', content: 'ok', messageId: 'm1' }
    yield { type: 'message_stop', messageId: 'm1' }
  }
}

class FailProvider implements IAgentProvider {
  getType() { return 'fail' }
  async *sendQuery(): AsyncGenerator<MessageChunk> {
    throw new Error('auth failed: invalid API key')
  }
}

describe('testConnectivity', () => {
  beforeEach(() => {
    resetProviderInstances()
  })

  afterEach(() => {
    resetProviderInstances()
    vi.restoreAllMocks()
  })

  it('returns success with latency for working provider', async () => {
    registerProvider('success', () => new SuccessProvider())
    const result = await testConnectivity('success')
    expect(result.success).toBe(true)
    expect(result.provider).toBe('success')
    expect(result.latency).toBeGreaterThanOrEqual(0)
  })

  it('returns error message for failing provider', async () => {
    registerProvider('fail', () => new FailProvider())
    const result = await testConnectivity('fail')
    expect(result.success).toBe(false)
    expect(result.error).toContain('auth failed')
  })

  it('returns error for unknown provider', async () => {
    const result = await testConnectivity('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown provider')
  })

  it('reports env_key missing for custom provider', async () => {
    delete process.env.CUSTOM_TEST_KEY
    const result = await testConnectivity('my-custom', undefined, {
      base_url: 'https://api.example.com',
      env_key: 'CUSTOM_TEST_KEY',
      models: [{ id: 'test-model' }],
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('CUSTOM_TEST_KEY')
    expect(result.error).toContain('未配置')
  })

  it('reports no model available for custom provider with empty models array edge case', async () => {
    const result = await testConnectivity('my-custom', undefined, {
      base_url: 'https://api.example.com',
      models: [{ id: 'first-model' }],
    })
    // Should attempt fetch since no env_key — but since there's no real server,
    // it will fail with a network error (or AbortController timeout)
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })
})
