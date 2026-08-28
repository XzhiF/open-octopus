import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk } from '../types'
import { ClaudeSDKProvider } from '../claude/provider'

// Live-path mapping for the /goal evaluator evidence (ticket-03 finding):
// claude CLI 2.1.250 headless NEVER emits the top-level `active_goal`
// StdoutMessage (filtered in the binary). The only headless exit is a
// synthetic isMeta `user` message whose text is
//   "Stop hook feedback:\n[<condition>]: <reason>"
// emitted once per not-met (blocked) iteration. The provider maps it to the
// SAME ActiveGoalChunk shape ticket 02 defined, consumed by
// engine/executors/agent-runner.ts unchanged.

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

async function collect(provider: ClaudeSDKProvider): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = []
  for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {})) {
    chunks.push(chunk)
  }
  return chunks
}

/** Real transcript shape (verified against ~/.claude/projects/... jsonl):
 *  type:'user', isMeta:true, message.content = plain string. */
function stopHookUserMessage(text: string): unknown {
  return {
    type: 'user',
    isMeta: true,
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
    uuid: 'u-meta',
    session_id: 'sess-1',
  }
}

const RESULT_OK = { type: 'result', subtype: 'success', result: 'done', session_id: 'sess-1' }

function activeGoals(chunks: MessageChunk[]): Extract<MessageChunk, { type: 'active_goal' }>[] {
  return chunks.filter((c): c is Extract<MessageChunk, { type: 'active_goal' }> => c.type === 'active_goal')
}

describe('Claude provider — stop-hook-feedback → active_goal mapping (headless live path)', () => {
  let provider: ClaudeSDKProvider

  beforeEach(() => {
    provider = new ClaudeSDKProvider()
    mockQuery.mockReset()
  })

  it('maps a basic not-met message to an ActiveGoalChunk', async () => {
    mockSdkStream([
      stopHookUserMessage('Stop hook feedback:\n[hello.txt contains GTD_OK]: file not created yet'),
      RESULT_OK,
    ])
    const goals = activeGoals(await collect(provider))
    expect(goals).toHaveLength(1)
    expect(goals[0]).toEqual({
      type: 'active_goal',
      condition: 'hello.txt contains GTD_OK',
      iterations: 1,
      last_reason: 'file not created yet',
      set_at: expect.any(Number),
    })
  })

  it('condition may contain colons — split on the FIRST "]: " after the leading "["', async () => {
    mockSdkStream([
      stopHookUserMessage('Stop hook feedback:\n[step 1: run build: exit code 0]: build still failing at step 1'),
      RESULT_OK,
    ])
    const goals = activeGoals(await collect(provider))
    expect(goals[0].condition).toBe('step 1: run build: exit code 0')
    expect(goals[0].last_reason).toBe('build still failing at step 1')
  })

  it('reason may itself contain "]: " — first split wins', async () => {
    mockSdkStream([
      stopHookUserMessage('Stop hook feedback:\n[real condition]: evaluator quoted [x]: nested text'),
      RESULT_OK,
    ])
    const goals = activeGoals(await collect(provider))
    expect(goals[0].condition).toBe('real condition')
    expect(goals[0].last_reason).toBe('evaluator quoted [x]: nested text')
  })

  it('reason may span multiple lines (and the condition too)', async () => {
    const text = 'Stop hook feedback:\n[goal line1:\ngoal line2]: reason line one\nreason line two\nreason line three'
    mockSdkStream([stopHookUserMessage(text), RESULT_OK])
    const goals = activeGoals(await collect(provider))
    expect(goals[0].condition).toBe('goal line1:\ngoal line2')
    expect(goals[0].last_reason).toBe('reason line one\nreason line two\nreason line three')
  })

  it('unparsable stop-hook-feedback text is skipped (prior behavior kept)', async () => {
    mockSdkStream([
      stopHookUserMessage('Stop hook feedback:\nbroken, no bracket at all'),
      stopHookUserMessage('Stop hook feedback:\n[unclosed condition with no closing bracket'),
      stopHookUserMessage('Stop hook feedback:\n[cond]:missing space after colon'),
      RESULT_OK,
    ])
    const chunks = await collect(provider)
    expect(activeGoals(chunks)).toHaveLength(0)
    // stream itself is unaffected — result chunk still arrives
    expect(chunks.some(c => c.type === 'result')).toBe(true)
  })

  it('iterations counts up across two blocks in one session (1-based, shared set_at)', async () => {
    mockSdkStream([
      stopHookUserMessage('Stop hook feedback:\n[c]: first block reason'),
      stopHookUserMessage('Stop hook feedback:\n[c]: second block reason'),
      RESULT_OK,
    ])
    const goals = activeGoals(await collect(provider))
    expect(goals.map(g => g.iterations)).toEqual([1, 2])
    expect(goals[1].last_reason).toBe('second block reason')
    expect(goals[1].set_at).toBe(goals[0].set_at)
  })

  it('non-goal user messages stay untouched (no chunk, stream continues)', async () => {
    mockSdkStream([
      { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'plain user text' } },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
      RESULT_OK,
    ])
    const chunks = await collect(provider)
    expect(activeGoals(chunks)).toHaveLength(0)
    expect(chunks.map(c => c.type)).toEqual(['result'])
  })

  it('accepts array-form content with a text block', async () => {
    mockSdkStream([
      {
        type: 'user',
        isMeta: true,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Stop hook feedback:\n[c2]: r2' }],
        },
      },
      RESULT_OK,
    ])
    const goals = activeGoals(await collect(provider))
    expect(goals).toHaveLength(1)
    expect(goals[0].condition).toBe('c2')
    expect(goals[0].last_reason).toBe('r2')
  })

  it('the top-level active_goal StdoutMessage branch still works (forward-compat)', async () => {
    mockSdkStream([
      {
        type: 'active_goal',
        value: { condition: 'future cli', iterations: 7, set_at: 111, tokens_at_start: 0, last_reason: 'lr' },
        uuid: 'u-top',
        session_id: 'sess-1',
      },
      RESULT_OK,
    ])
    const goals = activeGoals(await collect(provider))
    expect(goals[0]).toEqual({
      type: 'active_goal',
      condition: 'future cli',
      iterations: 7,
      last_reason: 'lr',
      set_at: 111,
    })
  })
})
