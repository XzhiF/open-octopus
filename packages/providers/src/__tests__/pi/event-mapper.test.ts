import { describe, it, expect } from 'vitest'
import { mapPiEventToChunks, MapperState } from '../../pi/event-mapper'

describe('EventMapper', () => {
  it('message_start generates messageId', () => {
    const ctx = new MapperState()
    const chunks = mapPiEventToChunks({ type: 'message_start' }, ctx)
    expect(chunks).not.toBeNull()
    if (Array.isArray(chunks)) {
      expect(chunks[0].type).toBe('message_start')
      expect((chunks[0] as any).messageId).toBeTruthy()
    } else {
      expect(chunks!.type).toBe('message_start')
    }
    expect(ctx.messageId).toBeTruthy()
  })

  it('text_delta passes through text (TC-007)', () => {
    const ctx = new MapperState()
    ctx.messageId = 'msg-1'
    const chunks = mapPiEventToChunks({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    }, ctx)
    expect(chunks).toEqual({
      type: 'text_delta', content: 'Hello', messageId: 'msg-1',
    })
  })

  it('tool_execution chain: start → update → end (TC-008)', () => {
    const ctx = new MapperState()
    ctx.messageId = 'msg-1'

    const start = mapPiEventToChunks({
      type: 'tool_execution_start', id: 'tool-1', toolName: 'Bash', input: { command: 'ls' },
    }, ctx)
    expect(Array.isArray(start)).toBe(true)
    const startArr = start as any[]
    expect(startArr[0].type).toBe('tool_call_start')
    expect(startArr[1].type).toBe('tool_call')

    const progress = mapPiEventToChunks({
      type: 'tool_execution_update', id: 'tool-1', elapsedSeconds: 2,
    }, ctx)
    expect((progress as any).type).toBe('tool_progress')

    const result = mapPiEventToChunks({
      type: 'tool_execution_end', id: 'tool-1', output: 'file1\nfile2', isError: false,
    }, ctx)
    expect((result as any).type).toBe('tool_result')
    expect((result as any).content).toBe('file1\nfile2')
  })

  it('tool_execution_end without start → best-effort (TC-009)', () => {
    const ctx = new MapperState()
    ctx.messageId = 'msg-1'
    const result = mapPiEventToChunks({
      type: 'tool_execution_end', id: 'orphan-tool', output: 'ok', isError: false,
    }, ctx)
    expect(result).not.toBeNull()
    expect((result as any).type).toBe('tool_result')
    expect((result as any).toolDuration).toBeUndefined()
  })

  it('discarded events return null', () => {
    const ctx = new MapperState()
    expect(mapPiEventToChunks({ type: 'agent_start' }, ctx)).toBeNull()
    expect(mapPiEventToChunks({ type: 'turn_start' }, ctx)).toBeNull()
    expect(mapPiEventToChunks({ type: 'turn_end' }, ctx)).toBeNull()
    expect(mapPiEventToChunks({ type: 'queue_update' }, ctx)).toBeNull()
  })

  it('agent_end produces result chunk', () => {
    const ctx = new MapperState()
    ctx.messageId = 'msg-1'
    const chunks = mapPiEventToChunks({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }],
    }, ctx)
    const arr = Array.isArray(chunks) ? chunks : [chunks]
    const types = arr.map((c: any) => c.type)
    expect(types).toContain('result')
  })
})
