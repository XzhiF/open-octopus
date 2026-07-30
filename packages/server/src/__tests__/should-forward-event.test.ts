// packages/server/src/__tests__/should-forward-event.test.ts
//
// Tests for the SSE event forwarding filter used in delegation paths.

import { describe, it, expect } from 'vitest'
import { shouldForwardEvent } from '../routes/agent/main-agent-route'

describe('shouldForwardEvent', () => {
  // Events that MUST be forwarded
  const forwarded = [
    'text_delta',
    'tool_call_start',
    'tool_call',
    'tool_result',
    'error',
  ]

  for (const type of forwarded) {
    it(`forwards "${type}"`, () => {
      expect(shouldForwardEvent(type)).toBe(true)
    })
  }

  // Events that MUST be filtered out
  const filtered = [
    'thinking',
    'thinking_start',
    'thinking_done',
    'message_start',
    'message_stop',
    'message_delta',
    'text_done',
    'tool_progress',
    'tool_summary',
    'status',
    'result',
    'ask_user_question',
    'local_command_output',
  ]

  for (const type of filtered) {
    it(`filters out "${type}"`, () => {
      expect(shouldForwardEvent(type)).toBe(false)
    })
  }

  it('filters out unknown event types', () => {
    expect(shouldForwardEvent('unknown_event')).toBe(false)
    expect(shouldForwardEvent('')).toBe(false)
  })
})
