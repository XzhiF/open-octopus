import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk } from '../types'
import { ClaudeSDKProvider } from '../claude/provider'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

function mockSdkStream(events: unknown[]) {
  mockQuery.mockReturnValue(
    (async function* () {
      for (const e of events) yield e
    })(),
  )
}

async function collect(provider: ClaudeSDKProvider, options?: Parameters<ClaudeSDKProvider['sendQuery']>[3]): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = []
  for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, options)) {
    chunks.push(chunk)
  }
  return chunks
}

function sdkOptions(): Record<string, unknown> {
  return mockQuery.mock.calls[0][0].options
}

describe('Claude provider — goal plumbing (ticket 02)', () => {
  let provider: ClaudeSDKProvider

  beforeEach(() => {
    provider = new ClaudeSDKProvider()
    mockQuery.mockReset()
  })

  describe('AC1: SendQueryOptions.maxTurns + maxBudgetUsd → sdkOptions', () => {
    it('maps maxTurns and maxBudgetUsd into SDK query options', async () => {
      mockSdkStream([{ type: 'result', subtype: 'success' }])
      await collect(provider, { maxTurns: 12, maxBudgetUsd: 0.5 })
      expect(sdkOptions().maxTurns).toBe(12)
      expect(sdkOptions().maxBudgetUsd).toBe(0.5)
    })

    it('leaves both undefined when not provided', async () => {
      mockSdkStream([{ type: 'result', subtype: 'success' }])
      await collect(provider, {})
      expect(sdkOptions().maxTurns).toBeUndefined()
      expect(sdkOptions().maxBudgetUsd).toBeUndefined()
    })
  })

  describe('AC2: toClaudeAgentDef stops silently dropping fields', () => {
    it('forwards maxTurns and background to the SDK AgentDefinition', async () => {
      mockSdkStream([{ type: 'result', subtype: 'success' }])
      await collect(provider, {
        agents: {
          helper: {
            description: 'A helper agent',
            prompt: 'Help me',
            maxTurns: 5,
            background: true,
          },
        },
      })
      const agents = sdkOptions().agents as Record<string, Record<string, unknown>>
      expect(agents.helper.maxTurns).toBe(5)
      expect(agents.helper.background).toBe(true)
    })

    it('forwards skills array to the SDK AgentDefinition', async () => {
      mockSdkStream([{ type: 'result', subtype: 'success' }])
      await collect(provider, {
        agents: {
          helper: {
            description: 'A helper agent',
            prompt: 'Help me',
            skills: ['octo-resource-manager'],
          },
        },
      })
      const agents = sdkOptions().agents as Record<string, Record<string, unknown>>
      expect(agents.helper.skills).toEqual(['octo-resource-manager'])
    })

    it('keeps existing fields (description/prompt/tools/model/effort) intact', async () => {
      mockSdkStream([{ type: 'result', subtype: 'success' }])
      await collect(provider, {
        agents: {
          helper: {
            description: 'd',
            prompt: 'p',
            tools: ['Read'],
            model: 'haiku',
            effort: 'low',
          },
        },
      })
      const agents = sdkOptions().agents as Record<string, Record<string, unknown>>
      expect(agents.helper).toMatchObject({ description: 'd', prompt: 'p', tools: ['Read'], model: 'haiku', effort: 'low' })
    })
  })

  describe('AC3: active_goal StdoutMessage → MessageChunk', () => {
    it('converts a top-level SDKActiveGoalMessage into an active_goal chunk', async () => {
      mockSdkStream([
        {
          type: 'active_goal',
          value: {
            condition: 'create hello.txt with content X',
            iterations: 3,
            set_at: 1755000000000,
            tokens_at_start: 12000,
            last_reason: 'file not yet created',
          },
          uuid: 'u-1',
          session_id: 'sess-1',
        },
        { type: 'result', subtype: 'success' },
      ])
      const chunks = await collect(provider)
      const ag = chunks.find(c => c.type === 'active_goal')
      expect(ag).toEqual({
        type: 'active_goal',
        condition: 'create hello.txt with content X',
        iterations: 3,
        last_reason: 'file not yet created',
        set_at: 1755000000000,
      })
    })

    it('omits last_reason when the SDK does not carry it', async () => {
      mockSdkStream([
        {
          type: 'active_goal',
          value: { condition: 'c', iterations: 1, set_at: 1, tokens_at_start: 0 },
          uuid: 'u-2',
          session_id: 'sess-1',
        },
        { type: 'result', subtype: 'success' },
      ])
      const chunks = await collect(provider)
      const ag = chunks.find(c => c.type === 'active_goal')
      expect(ag).toBeDefined()
      if (ag?.type === 'active_goal') {
        expect(ag.last_reason).toBeUndefined()
        expect(ag.condition).toBe('c')
        expect(ag.iterations).toBe(1)
      }
    })

    it('emits condition: null when the goal is cleared (value === null)', async () => {
      mockSdkStream([
        { type: 'active_goal', value: null, uuid: 'u-3', session_id: 'sess-1' },
        { type: 'result', subtype: 'success' },
      ])
      const chunks = await collect(provider)
      const ag = chunks.find(c => c.type === 'active_goal')
      expect(ag).toEqual({ type: 'active_goal', condition: null, iterations: 0 })
    })
  })

  describe('AC4: error terminal fidelity (result non-success)', () => {
    it('error_max_turns preserves numTurns/costUsd/sessionId + terminalReason=max_turns (modelUsage path)', async () => {
      mockSdkStream([
        {
          type: 'result',
          subtype: 'error_max_turns',
          num_turns: 4,
          total_cost_usd: 0.42,
          session_id: 'sess-fuse',
          errors: [],
          modelUsage: {
            'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 50 },
          },
        },
      ])
      const chunks = await collect(provider)
      const err = chunks.find(c => c.type === 'error')
      expect(err).toEqual(
        expect.objectContaining({
          type: 'error',
          code: 'error_max_turns',
          terminalReason: 'max_turns',
          numTurns: 4,
          costUsd: 0.42,
          sessionId: 'sess-fuse',
        }),
      )
    })

    it('error_max_budget_usd carries terminalReason=max_budget_usd even without modelUsage (fallback path)', async () => {
      mockSdkStream([
        {
          type: 'result',
          subtype: 'error_max_budget_usd',
          num_turns: 9,
          total_cost_usd: 1.25,
          session_id: 'sess-budget',
          errors: ['Budget limit reached'],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ])
      const chunks = await collect(provider)
      const err = chunks.find(c => c.type === 'error')
      expect(err).toEqual(
        expect.objectContaining({
          type: 'error',
          code: 'error_max_budget_usd',
          message: 'Budget limit reached',
          terminalReason: 'max_budget_usd',
          numTurns: 9,
          costUsd: 1.25,
          sessionId: 'sess-budget',
        }),
      )
    })

    it('error_during_execution stays an error chunk without terminalReason', async () => {
      mockSdkStream([
        {
          type: 'result',
          subtype: 'error_during_execution',
          num_turns: 2,
          total_cost_usd: 0.1,
          session_id: 'sess-x',
          errors: ['boom'],
        },
      ])
      const chunks = await collect(provider)
      const err = chunks.find(c => c.type === 'error')
      expect(err).toBeDefined()
      if (err?.type === 'error') {
        expect(err.code).toBe('error_during_execution')
        expect(err.terminalReason).toBeUndefined()
        expect(err.message).toBe('boom')
        expect(err.numTurns).toBe(2)
      }
    })

    it('does not throw on error terminal subtypes', async () => {
      mockSdkStream([
        { type: 'result', subtype: 'error_max_turns', num_turns: 4, total_cost_usd: 0.4, session_id: 's' },
      ])
      await expect(collect(provider)).resolves.toBeInstanceOf(Array)
    })
  })

  describe('regression: success paths unchanged', () => {
    it('success result with modelUsage yields a result chunk (no error chunk)', async () => {
      mockSdkStream([
        {
          type: 'result',
          subtype: 'success',
          result: 'done',
          session_id: 'sess-ok',
          total_cost_usd: 0.03,
          modelUsage: {
            'claude-sonnet-4-5': { inputTokens: 100, outputTokens: 20 },
          },
        },
      ])
      const chunks = await collect(provider)
      expect(chunks.some(c => c.type === 'error')).toBe(false)
      const res = chunks.find(c => c.type === 'result')
      expect(res).toEqual(
        expect.objectContaining({ type: 'result', content: 'done', sessionId: 'sess-ok', costUsd: 0.03 }),
      )
    })

    it('success result without modelUsage still yields a result chunk (fallback path)', async () => {
      mockSdkStream([
        {
          type: 'result',
          subtype: 'success',
          result: 'ok',
          session_id: 'sess-ok2',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ])
      const chunks = await collect(provider)
      expect(chunks.map(c => c.type)).toEqual(['result'])
    })
  })
})
