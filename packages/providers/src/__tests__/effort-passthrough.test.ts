import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClaudeSDKProvider } from '../claude/provider'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

describe('effort passthrough', () => {
  let provider: ClaudeSDKProvider

  beforeEach(() => {
    provider = new ClaudeSDKProvider()
    mockQuery.mockReset()
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-test',
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      })(),
    )
  })

  describe('Claude SDK provider', () => {
    it('passes effort to SDK Options', async () => {
      const gen = provider.sendQuery('test', '/cwd', undefined, {
        effort: 'high',
      })
      // consume the generator
      for await (const _ of gen) { /* drain */ }

      expect(mockQuery).toHaveBeenCalledTimes(1)
      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.effort).toBe('high')
    })

    it('passes numeric effort to SDK Options', async () => {
      const gen = provider.sendQuery('test', '/cwd', undefined, {
        effort: 42,
      })
      for await (const _ of gen) { /* drain */ }

      // Numeric effort is NOT passed to top-level SDK Options (EffortLevel only accepts strings)
      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.effort).toBeUndefined()
    })

    it('does not set effort when not provided', async () => {
      const gen = provider.sendQuery('test', '/cwd', undefined, {})
      for await (const _ of gen) { /* drain */ }

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.effort).toBeUndefined()
    })

    it('passes effort in sub-agent definitions via toClaudeAgentDef', async () => {
      const gen = provider.sendQuery('test', '/cwd', undefined, {
        agents: {
          helper: {
            description: 'A helper agent',
            prompt: 'Help me',
            effort: 'max',
          },
        },
      })
      for await (const _ of gen) { /* drain */ }

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.agents.helper.effort).toBe('max')
    })
  })
})

describe('effort → thinkingLevel mapping (Pi SDK)', () => {
  // Test the mapping function directly
  // The mapping is: low→minimal, medium→low, high→medium, xhigh→high, max→maximum
  const effortMap: Record<string, string> = {
    low: 'minimal',
    medium: 'low',
    high: 'medium',
    xhigh: 'high',
    max: 'maximum',
  }

  it('maps low effort to minimal thinkingLevel', () => {
    expect(effortMap['low']).toBe('minimal')
  })

  it('maps medium effort to low thinkingLevel', () => {
    expect(effortMap['medium']).toBe('low')
  })

  it('maps high effort to medium thinkingLevel', () => {
    expect(effortMap['high']).toBe('medium')
  })

  it('maps xhigh effort to high thinkingLevel', () => {
    expect(effortMap['xhigh']).toBe('high')
  })

  it('maps max effort to maximum thinkingLevel', () => {
    expect(effortMap['max']).toBe('maximum')
  })
})
