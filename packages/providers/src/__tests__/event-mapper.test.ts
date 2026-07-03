import { describe, it, expect } from 'vitest'
import { mapPiEventToChunks, createMapperContext } from '../pi/event-mapper'

describe('EventMapper', () => {
  it('message_start produces message_start with generated messageId', () => {
    const ctx = createMapperContext()
    const chunk = mapPiEventToChunks({ type: 'message_start' }, ctx)
    expect(chunk).toEqual({ type: 'message_start', messageId: expect.any(String) })
  })

  it('text_delta produces text_delta', () => {
    const ctx = createMapperContext()
    mapPiEventToChunks({ type: 'message_start' }, ctx)
    const chunk = mapPiEventToChunks({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    }, ctx)
    expect(chunk).toEqual({ type: 'text_delta', content: 'hello', messageId: ctx.messageId })
  })

  it('message_end produces text_done + message_stop', () => {
    const ctx = createMapperContext()
    mapPiEventToChunks({ type: 'message_start' }, ctx)
    const chunks = mapPiEventToChunks({ type: 'message_end' }, ctx) as any[]
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ type: 'text_done' })
    expect(chunks[1]).toMatchObject({ type: 'message_stop' })
  })

  it('thinking events map correctly', () => {
    const ctx = createMapperContext()
    mapPiEventToChunks({ type: 'message_start' }, ctx)
    expect(mapPiEventToChunks({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } }, ctx))
      .toEqual({ type: 'thinking_start', messageId: ctx.messageId })
    expect(mapPiEventToChunks({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning' } }, ctx))
      .toEqual({ type: 'thinking', content: 'reasoning', messageId: ctx.messageId })
    expect(mapPiEventToChunks({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } }, ctx))
      .toEqual({ type: 'thinking_done', messageId: ctx.messageId })
  })

  it('tool_execution_start produces tool_call_start + tool_call', () => {
    const ctx = createMapperContext()
    mapPiEventToChunks({ type: 'message_start' }, ctx)
    const chunks = mapPiEventToChunks({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'Read', input: { path: '/tmp' } }, ctx) as any[]
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ type: 'tool_call_start', toolCallId: 'tc-1' })
    expect(chunks[1]).toMatchObject({ type: 'tool_call', toolCallId: 'tc-1' })
  })

  it('tool_execution_end produces tool_result', () => {
    const ctx = createMapperContext()
    mapPiEventToChunks({ type: 'message_start' }, ctx)
    mapPiEventToChunks({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'Read' }, ctx)
    const chunk = mapPiEventToChunks({ type: 'tool_execution_end', toolCallId: 'tc-1', result: { content: 'data' } }, ctx)
    expect(chunk).toMatchObject({ type: 'tool_result', toolCallId: 'tc-1', content: 'data' })
  })

  it('agent_end produces result with tokens', () => {
    const ctx = createMapperContext()
    ctx.tokenAggregator.add('model-a', { input: 100, output: 50, cost: 0.001 })
    const chunk = mapPiEventToChunks({ type: 'agent_end', messages: [] }, ctx)
    expect(chunk).toMatchObject({ type: 'result', tokens: { input: 100, output: 50, total: 150 } })
  })

  it('discarded events return null', () => {
    const ctx = createMapperContext()
    for (const type of ['agent_start', 'turn_start', 'turn_end', 'queue_update']) {
      expect(mapPiEventToChunks({ type }, ctx)).toBeNull()
    }
  })

  it('compaction/retry status mapping', () => {
    const ctx = createMapperContext()
    expect(mapPiEventToChunks({ type: 'compaction_start' }, ctx)).toEqual({ type: 'status', status: 'compacting' })
    expect(mapPiEventToChunks({ type: 'compaction_end' }, ctx)).toEqual({ type: 'status', status: null })
    expect(mapPiEventToChunks({ type: 'auto_retry_start' }, ctx)).toEqual({ type: 'status', status: 'requesting' })
    expect(mapPiEventToChunks({ type: 'auto_retry_end' }, ctx)).toEqual({ type: 'status', status: null })
  })

  it('message_end without message_start does not crash', () => {
    const ctx = createMapperContext()
    const chunks = mapPiEventToChunks({ type: 'message_end' }, ctx) as any[]
    expect(chunks).toHaveLength(2)
  })
})
