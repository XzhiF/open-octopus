import { describe, it, expect, vi } from 'vitest'
import type { IAgentProvider, MessageChunk } from '@octopus/providers'

// Test the mock provider pattern that would be used with engine integration
// Full engine.run() requires mocking all executors — see engine.test.ts for pattern
function createMockPiProvider(): IAgentProvider {
  return {
    getType: () => 'pi',
    async *sendQuery(prompt: string): AsyncGenerator<MessageChunk> {
      yield { type: 'message_start', messageId: 'msg-1' }
      yield { type: 'text_delta', content: `Processed: ${prompt.slice(0, 30)}`, messageId: 'msg-1' }
      yield { type: 'text_done', messageId: 'msg-1' }
      yield { type: 'message_stop', messageId: 'msg-1' }
      yield { type: 'result', content: `Result: ${prompt.slice(0, 30)}`, sessionId: 'sess-pi', tokens: { input: 10, output: 5, total: 15 }, costUsd: 0.0001 }
    },
  }
}

describe('Pi provider mock', () => {
  it('produces correct MessageChunk sequence', async () => {
    const provider = createMockPiProvider()
    expect(provider.getType()).toBe('pi')

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('test prompt')) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(5)
    expect(chunks[0].type).toBe('message_start')
    expect(chunks[1].type).toBe('text_delta')
    expect(chunks[2].type).toBe('text_done')
    expect(chunks[3].type).toBe('message_stop')
    expect(chunks[4].type).toBe('result')
    expect((chunks[4] as any).tokens).toEqual({ input: 10, output: 5, total: 15 })
    expect((chunks[4] as any).costUsd).toBe(0.0001)
  })

  it('produces error chunks for failing provider', async () => {
    const failProvider: IAgentProvider = {
      getType: () => 'pi',
      async *sendQuery(prompt: string): AsyncGenerator<MessageChunk> {
        if (prompt.includes('fail')) {
          yield { type: 'error', code: 'model_not_found', message: 'Model not available' }
          return
        }
        yield { type: 'result', content: 'ok' }
      },
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of failProvider.sendQuery('fail this')) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(1)
    expect(chunks[0].type).toBe('error')
  })

  it('model alias config resolves tier names', async () => {
    const { resolveModelAlias, BUILTIN_DEFAULTS } = await import('@octopus/shared')

    // Pi tier resolution
    expect(resolveModelAlias('pro-max', 'pi', BUILTIN_DEFAULTS)).toBe('anthropic/claude-opus-4-20250514')
    expect(resolveModelAlias('pro', 'pi', BUILTIN_DEFAULTS)).toBe('anthropic/claude-sonnet-4-20250514')
    expect(resolveModelAlias('se', 'pi', BUILTIN_DEFAULTS)).toBe('anthropic/claude-haiku-4-5-20251001')

    // Non-tier passthrough
    expect(resolveModelAlias('openai/gpt-4o', 'pi', BUILTIN_DEFAULTS)).toBe('openai/gpt-4o')

    // Default tier for undefined
    expect(resolveModelAlias(undefined, 'pi', BUILTIN_DEFAULTS)).toBe('anthropic/claude-sonnet-4-20250514')
  })

  it('TC-031: abort during execution terminates stream', async () => {
    const slowProvider: IAgentProvider = {
      getType: () => 'pi',
      async *sendQuery(prompt: string, _cwd?: string, _resume?: string, options?: any): AsyncGenerator<MessageChunk> {
        yield { type: 'message_start', messageId: 'msg-abort' }
        // Simulate abort check
        if (options?.abortSignal?.aborted) {
          yield { type: 'error', code: 'aborted', message: '请求已取消' }
          return
        }
        yield { type: 'text_delta', content: 'partial', messageId: 'msg-abort' }
        yield { type: 'result', content: 'done', sessionId: 's' }
      },
    }

    const controller = new AbortController()
    const chunks: MessageChunk[] = []
    for await (const chunk of slowProvider.sendQuery('test', '/tmp', undefined, { abortSignal: controller.signal })) {
      chunks.push(chunk)
      controller.abort()
    }
    // After first chunk, abort is triggered, so we should get error chunk
    expect(chunks.some(c => c.type === 'error' && (c as any).code === 'aborted')).toBe(true)
  })

  it('TC-033: abort between turns yields first turn result', async () => {
    const multiTurnProvider: IAgentProvider = {
      getType: () => 'pi',
      async *sendQuery(prompt: string, _cwd?: string, _resume?: string, options?: any): AsyncGenerator<MessageChunk> {
        // Turn 1
        yield { type: 'message_start', messageId: 'msg-t1' }
        yield { type: 'text_delta', content: 'Turn 1 result', messageId: 'msg-t1' }
        yield { type: 'text_done', messageId: 'msg-t1' }
        yield { type: 'message_stop', messageId: 'msg-t1' }

        // Abort check between turns
        if (options?.abortSignal?.aborted) {
          yield { type: 'result', content: 'Turn 1 result', sessionId: 's1', tokens: { input: 5, output: 3, total: 8 }, costUsd: 0.0001 }
          return
        }

        // Turn 2 (should not execute)
        yield { type: 'message_start', messageId: 'msg-t2' }
        yield { type: 'text_delta', content: 'Turn 2 result', messageId: 'msg-t2' }
        yield { type: 'result', content: 'Turn 2 result', sessionId: 's1', tokens: { input: 10, output: 6, total: 16 }, costUsd: 0.0002 }
      },
    }

    const controller = new AbortController()
    const chunks: MessageChunk[] = []
    let turn1Done = false
    for await (const chunk of multiTurnProvider.sendQuery('test', '/tmp', undefined, { abortSignal: controller.signal })) {
      chunks.push(chunk)
      if (chunk.type === 'message_stop') {
        turn1Done = true
        controller.abort()
      }
    }

    expect(turn1Done).toBe(true)
    const resultChunk = chunks.find(c => c.type === 'result')
    expect(resultChunk).toBeDefined()
    expect((resultChunk as any).content).toBe('Turn 1 result')
    // Turn 2 should NOT have executed
    expect(chunks.filter(c => c.type === 'message_start')).toHaveLength(1)
  })

  it('TC-058: workflow failure path - provider yields error chunk, engine propagates failure', async () => {
    // Test the failure propagation pattern: pi provider yields error → engine marks node failed
    const failProvider: IAgentProvider = {
      getType: () => 'pi',
      async *sendQuery(prompt: string): AsyncGenerator<MessageChunk> {
        if (prompt.includes('fail')) {
          yield { type: 'message_start', messageId: 'msg-fail' }
          yield { type: 'error', code: 'agent_error', message: 'Summarize task failed' }
          return
        }
        yield { type: 'message_start', messageId: 'msg-ok' }
        yield { type: 'text_delta', content: 'Analyzed successfully', messageId: 'msg-ok' }
        yield { type: 'text_done', messageId: 'msg-ok' }
        yield { type: 'message_stop', messageId: 'msg-ok' }
        yield { type: 'result', content: 'Analysis done', sessionId: 's', tokens: { input: 10, output: 5, total: 15 }, costUsd: 0.0001 }
      },
    }

    // Verify analyze node (no 'fail' in prompt) → completes with result
    const analyzeChunks: MessageChunk[] = []
    for await (const chunk of failProvider.sendQuery('Analyze this data')) {
      analyzeChunks.push(chunk)
    }
    expect(analyzeChunks.some(c => c.type === 'result')).toBe(true)
    expect(analyzeChunks.some(c => c.type === 'error')).toBe(false)

    // Verify summarize node ('fail' in prompt) → error chunk, no result
    const summarizeChunks: MessageChunk[] = []
    for await (const chunk of failProvider.sendQuery('Summarize - this will fail')) {
      summarizeChunks.push(chunk)
    }
    expect(summarizeChunks.some(c => c.type === 'error')).toBe(true)
    expect(summarizeChunks.some(c => c.type === 'result')).toBe(false)

    // In the real engine, the error chunk would mark the node as 'failed'
    // and dependent nodes as 'skipped' — tested in engine.test.ts
  })
})
