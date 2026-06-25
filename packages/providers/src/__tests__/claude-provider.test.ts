import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk } from '../types'
import { ClaudeSDKProvider } from '../claude/provider'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

async function* makeMessageChunks(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) {
    yield event
  }
}

describe('ClaudeSDKProvider', () => {
  let provider: ClaudeSDKProvider

  beforeEach(() => {
    provider = new ClaudeSDKProvider()
    mockQuery.mockReset()
  })

  it('getType returns claude', () => {
    expect(provider.getType()).toBe('claude')
  })

  it('streams text delta and done chunks', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-1' } },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello world' },
          },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          usage: { input_tokens: 10, output_tokens: 5 },
        }
      })()
    )

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp')) {
      chunks.push(chunk)
    }

    expect(chunks.map(c => c.type)).toEqual([
      'message_start',
      'text_delta',
      'text_done',
      'result',
    ])
  })

  it('streams tool call start and tool call chunks', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-2' } },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
          },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"file":"test.txt"}' },
          },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-2',
          usage: { input_tokens: 20, output_tokens: 10 },
        }
      })()
    )

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('read file', '/tmp')) {
      chunks.push(chunk)
    }

    const toolCall = chunks.find(c => c.type === 'tool_call')
    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'tool_call') {
      expect(toolCall.toolName).toBe('Read')
      expect(toolCall.toolInput).toEqual({ file: 'test.txt' })
    }
  })

  it('streams tool call and text chunks in sequence', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-3' } },
        }
        // tool_use block (index 0)
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tool-3', name: 'Bash' },
          },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' },
          },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 0 },
        }
        // text block (index 1)
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '' },
          },
        }
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'Done' },
          },
        }
        yield {
          type: 'stream_event',
          event: { type: 'content_block_stop', index: 1 },
        }
        yield {
          type: 'result',
          subtype: 'success',
        }
      })()
    )

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('ls', '/tmp')) {
      chunks.push(chunk)
    }

    const types = chunks.map(c => c.type)
    expect(types).toContain('tool_call_start')
    expect(types).toContain('tool_call')
    expect(types).toContain('text_delta')
    expect(types).toContain('text_done')
    expect(types).toContain('result')
  })

  it('uses provided model in SDK options', async () => {
    mockQuery.mockReturnValue(
      makeMessageChunks([{ type: 'result', subtype: 'success' }])
    )

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of provider.sendQuery('hi', '/tmp', undefined, { model: 'opus' })) {}

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.model).toBe('opus')
  })

  it('passes resume session to SDK', async () => {
    mockQuery.mockReturnValue(
      makeMessageChunks([{ type: 'result', subtype: 'success' }])
    )

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of provider.sendQuery('continue', '/tmp', 'prev-session')) {}

    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.resume).toBe('prev-session')
  })

  it('merges ~/.claude/settings.json env into subprocess env', async () => {
    mockQuery.mockReturnValue(makeMessageChunks([{ type: 'result', subtype: 'success' }]))
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of provider.sendQuery('hi', '/tmp')) {}
    const callArgs = mockQuery.mock.calls[0][0]
    const env = callArgs.options.env as Record<string, string>
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeDefined()
    expect(env.ANTHROPIC_BASE_URL).toBeDefined()
  })

  it('does not set CLAUDE_USE_GLOBAL_AUTH when settings.json has auth token', async () => {
    const origApiKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.CLAUDE_USE_GLOBAL_AUTH

    mockQuery.mockReturnValue(makeMessageChunks([{ type: 'result', subtype: 'success' }]))
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of provider.sendQuery('hi', '/tmp')) {}
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.env.CLAUDE_USE_GLOBAL_AUTH).toBeUndefined()

    process.env.ANTHROPIC_API_KEY = origApiKey
  })

  it('does not override CLAUDE_USE_GLOBAL_AUTH when explicit tokens present', async () => {
    const origApiKey = process.env.ANTHROPIC_API_KEY
    const origGlobalAuth = process.env.CLAUDE_USE_GLOBAL_AUTH
    process.env.ANTHROPIC_API_KEY = 'test-key'
    delete process.env.CLAUDE_USE_GLOBAL_AUTH

    mockQuery.mockReturnValue(makeMessageChunks([{ type: 'result', subtype: 'success' }]))
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of provider.sendQuery('hi', '/tmp')) {}
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.env.CLAUDE_USE_GLOBAL_AUTH).toBeUndefined()

    process.env.ANTHROPIC_API_KEY = origApiKey
    process.env.CLAUDE_USE_GLOBAL_AUTH = origGlobalAuth
  })
})