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
})
