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

  // 2026-11-03 事故回归：streaming input 下 CLI 会为内部排队消息（后台任务通知）
  // 先吐一个 num_turns=0、无正文、无 usage 的 result。把它当收轮会让宿主提前断开，
  // 真正的模型轮次（回复 + 工具调用）全部丢失。
  it('empty result ack (num_turns=0) does not end the turn — the real turn is still consumed', async () => {
    mockQuery.mockReturnValue(
      (async function* () {
        yield { type: 'result', subtype: 'success', num_turns: 0, session_id: 'sess-1' }
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-real' } },
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
            delta: { type: 'text_delta', text: '真正的回复' },
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
          num_turns: 1,
          usage: { input_tokens: 5, output_tokens: 2 },
        }
      })()
    )

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('通过', '/tmp', 'prev-session')) {
      chunks.push(chunk)
    }

    const results = chunks.filter(c => c.type === 'result')
    expect(results).toHaveLength(1)
    expect((results[0] as { numTurns?: number }).numTurns).toBe(1)
    expect(
      chunks.some(c => c.type === 'text_delta' && (c as { content?: string }).content === '真正的回复'),
    ).toBe(true)
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

  // 知识中心票 08 AC5（保留注入面零改动断言之四）：SDK settingSources 是技能文件
  // 物化后经 SDK 原生发现进模型的唯一通道（ADR-0006「skills 永不以 prompt 文本
  // 下发」的另一半）。注入链物理删除不得触碰它 —— 期望值来自保留面契约
  // （spec「注入链与旧库硬废·保留的注入面不动」），非实现反推。
  it('settingSources stays [project,user] — SDK native discovery channel untouched by 票08', async () => {
    mockQuery.mockReturnValue(makeMessageChunks([{ type: 'result', subtype: 'success' }]))
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of provider.sendQuery('hi', '/tmp')) {}
    const callArgs = mockQuery.mock.calls[0][0]
    expect(callArgs.options.settingSources).toEqual(['project', 'user'])
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

// 2026-11-04 事故回归：chat 用 Bash `run_in_background` 起服务就绪轮询，模型
// 收轮说「就绪后我直接跑」，宿主却在首轮 result 处 break → query 被关掉 →
// 后台任务完成后的唤醒永远到不了，用户必须再发一条消息才「激活」会话。
function makeControlledQuery(
  gen: AsyncGenerator<unknown>,
  controls?: { stopTask?: (taskId: string) => Promise<void> },
) {
  const q = gen as AsyncGenerator<unknown> & {
    interrupt: () => Promise<void>
    stopTask: (taskId: string) => Promise<void>
  }
  q.interrupt = async () => {}
  q.stopTask = controls?.stopTask ?? (async () => {})
  return q
}

const bgChanged = (tasks: Array<{ task_id: string; task_type?: string; description?: string }>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
})

const textTurn = (id: string, text: string) => [
  { type: 'stream_event', event: { type: 'message_start', message: { id } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
]

describe('ClaudeSDKProvider — background tasks', () => {
  let provider: ClaudeSDKProvider

  beforeEach(() => {
    provider = new ClaudeSDKProvider()
    mockQuery.mockReset()
  })

  it('awaitBackgroundTasks 持续消费：首个 result 后等到后台任务结束并接住唤醒轮', async () => {
    mockQuery.mockReturnValue(
      makeControlledQuery(
        makeMessageChunks([
          bgChanged([{ task_id: 'bg-1', task_type: 'local_bash', description: 'sleep 20 && echo done' }]),
          ...textTurn('m-1', '服务启动中'),
          {
            type: 'result', subtype: 'success', session_id: 's-1', num_turns: 2,
            result: '服务启动中', usage: { input_tokens: 10, output_tokens: 5 },
          },
          // 后台任务结束 → CLI 唤醒模型跑第二轮
          bgChanged([]),
          { type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed', summary: 'done' },
          ...textTurn('m-2', '服务就绪，开始跑场景 1'),
          {
            type: 'result', subtype: 'success', session_id: 's-1', num_turns: 1,
            result: '服务就绪，开始跑场景 1', usage: { input_tokens: 20, output_tokens: 8 },
          },
        ]),
      ),
    )

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('起服务', '/tmp', undefined, {
      interruptible: true,
      awaitBackgroundTasks: true,
    })) {
      chunks.push(chunk)
    }

    const bg = chunks.filter((c) => c.type === 'background_tasks') as Array<{
      type: 'background_tasks'
      tasks: Array<{ id: string; description: string }>
    }>
    expect(bg).toHaveLength(2)
    expect(bg[0].tasks[0]).toMatchObject({ id: 'bg-1', description: 'sleep 20 && echo done' })
    expect(bg[1].tasks).toEqual([])

    expect(
      chunks.filter((c) => c.type === 'text_delta').map((c) => (c as { content: string }).content),
    ).toEqual(['服务启动中', '服务就绪，开始跑场景 1'])
    expect(chunks.filter((c) => c.type === 'result')).toHaveLength(2)
  })

  it('未开 awaitBackgroundTasks 时仍在首个 result 收轮（workflow/engine 行为不变）', async () => {
    mockQuery.mockReturnValue(
      makeControlledQuery(
        makeMessageChunks([
          bgChanged([{ task_id: 'bg-1', task_type: 'local_bash', description: 'sleep 20' }]),
          ...textTurn('m-1', '服务启动中'),
          {
            type: 'result', subtype: 'success', session_id: 's-1', num_turns: 2,
            result: '服务启动中', usage: { input_tokens: 10, output_tokens: 5 },
          },
          ...textTurn('m-2', '这轮不该被消费'),
          {
            type: 'result', subtype: 'success', session_id: 's-1', num_turns: 1,
            result: '这轮不该被消费', usage: { input_tokens: 1, output_tokens: 1 },
          },
        ]),
      ),
    )

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('起服务', '/tmp', undefined, {
      interruptible: true,
    })) {
      chunks.push(chunk)
    }

    expect(
      chunks.filter((c) => c.type === 'text_delta').map((c) => (c as { content: string }).content),
    ).toEqual(['服务启动中'])
    expect(chunks.filter((c) => c.type === 'result')).toHaveLength(1)
  })

  it('abort 时先 stopTask 收掉后台任务，再中断当前轮', async () => {
    const stopTask = vi.fn(async () => {})
    const abort = new AbortController()
    mockQuery.mockReturnValue(
      makeControlledQuery(
        makeMessageChunks([
          bgChanged([{ task_id: 'bg-1', task_type: 'local_bash', description: 'sleep 999' }]),
          {
            type: 'result', subtype: 'success', session_id: 's-1', num_turns: 1,
            result: '等待中', usage: { input_tokens: 1, output_tokens: 1 },
          },
        ]),
        { stopTask },
      ),
    )

    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      interruptible: true,
      awaitBackgroundTasks: true,
      abortSignal: abort.signal,
    })) {
      if (chunk.type === 'background_tasks' && chunk.tasks.length > 0) abort.abort()
    }

    expect(stopTask).toHaveBeenCalledWith('bg-1')
  })
})