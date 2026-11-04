import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk } from '../types'
import { ClaudeSDKProvider, buildToolCaptureHooks } from '../claude/provider'

const mockQuery = vi.fn()
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

async function* makeEvents(events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

function subagentEvents(): unknown[] {
  return [
    { type: 'system', subtype: 'init', session_id: 'sdk-1', tools: [], mcp_servers: [], agents: [], skills: [], plugins: [], slash_commands: [] },
    {
      type: 'system', subtype: 'task_started', session_id: 'sdk-1',
      task_id: 'agent-1', tool_use_id: 'tu-1', subagent_type: 'general-purpose',
      task_type: 'local_agent', description: '审查登录模块', prompt: '审查登录模块的鉴权边界',
    },
    // 第一条 user 文本 = 指令回显，应被吞掉（指令走 prompt 卡）。
    { type: 'user', session_id: 'sdk-1', parent_tool_use_id: 'tu-1', message: { content: [{ type: 'text', text: '审查登录模块的鉴权边界' }] } },
    {
      type: 'assistant', session_id: 'sdk-1', parent_tool_use_id: 'tu-1',
      message: { model: 'claude-test', content: [
        { type: 'thinking', thinking: '先看鉴权入口' },
        { type: 'tool_use', id: 'tool-1', name: 'Grep', input: { pattern: 'auth' } },
      ] },
    },
    { type: 'user', session_id: 'sdk-1', parent_tool_use_id: 'tu-1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'src/auth.ts' },
    ] } },
    // 子代理正文绝不能漏进主对话。
    { type: 'assistant', session_id: 'sdk-1', parent_tool_use_id: 'tu-1', message: { content: [{ type: 'text', text: 'SUBAGENT_ONLY_TEXT' }] } },
    {
      type: 'system', subtype: 'task_progress', session_id: 'sdk-1',
      task_id: 'agent-1', subagent_type: 'general-purpose', description: '正在审查',
      last_tool_name: 'Grep',
      usage: { total_tokens: 0, tool_uses: 1, duration_ms: 1000 },
    },
    { type: 'system', subtype: 'task_updated', session_id: 'sdk-1', task_id: 'agent-1', patch: { status: 'completed' } },
    {
      type: 'system', subtype: 'task_notification', session_id: 'sdk-1',
      task_id: 'agent-1', status: 'completed', summary: '鉴权边界正常',
      usage: { total_tokens: 0, tool_uses: 1, duration_ms: 2600 },
    },
    {
      type: 'result', subtype: 'success', session_id: 'sdk-1', result: 'ok',
      usage: { input_tokens: 5, output_tokens: 6 },
      modelUsage: { 'claude-test': { inputTokens: 5, outputTokens: 6 } },
    },
  ]
}

async function collect(events: unknown[]): Promise<MessageChunk[]> {
  mockQuery.mockReturnValue(makeEvents(events))
  const provider = new ClaudeSDKProvider()
  const chunks: MessageChunk[] = []
  for await (const chunk of provider.sendQuery('hi', '/tmp')) chunks.push(chunk)
  return chunks
}

describe('ClaudeSDKProvider · subagents', () => {
  beforeEach(() => mockQuery.mockReset())

  it('forwards subagent lifecycle + logs and keeps them out of the main transcript', async () => {
    const chunks = await collect(subagentEvents())
    const subagents = chunks
      .filter((c): c is Extract<MessageChunk, { type: 'subagent' }> => c.type === 'subagent')
      .map((c) => c.event)

    const started = subagents.find((e) => e.phase === 'started')!
    expect(started).toMatchObject({
      id: 'agent-1',
      parentToolUseId: 'tu-1',
      agentType: 'general-purpose',
      description: '审查登录模块',
      prompt: '审查登录模块的鉴权边界',
      sdkSessionId: 'sdk-1',
    })

    // 指令回显不重复成日志；thinking / tool_use / tool_result / text 各就位。
    const logBlocks = subagents.filter((e) => e.phase === 'log').flatMap((e) => e.blocks ?? [])
    expect(logBlocks.map((b) => b.kind)).toEqual(['thinking', 'tool_use', 'tool_result', 'text'])
    expect(logBlocks[3].text).toBe('SUBAGENT_ONLY_TEXT')

    // 进度事件不覆盖人话描述（SDK 的 task_progress.description 是「Running …」短语）。
    expect(subagents.find((e) => e.phase === 'progress')).toMatchObject({
      description: '审查登录模块',
      lastToolName: 'Grep',
      toolUses: 1,
    })

    const completed = subagents.filter((e) => e.phase === 'completed')
    expect(completed.length).toBeGreaterThanOrEqual(1)
    expect(completed.some((e) => e.summary === '鉴权边界正常')).toBe(true)

    // 子代理正文不能作为主对话 text_delta 出现。
    expect(chunks.some((c) => c.type === 'text_delta' && c.content.includes('SUBAGENT_ONLY_TEXT'))).toBe(false)
  })

  it('never registers a foreground subagent as a background task', async () => {
    const chunks = await collect(subagentEvents())
    const background = chunks
      .filter((c): c is Extract<MessageChunk, { type: 'background_tasks' }> => c.type === 'background_tasks')
    expect(background.some((b) => b.tasks.some((t) => t.id === 'agent-1'))).toBe(false)
  })

  it('enables forwardSubagentText so subagent text/thinking reaches the host', async () => {
    await collect(subagentEvents())
    expect(mockQuery.mock.calls[0][0].options.forwardSubagentText).toBe(true)
  })

  it('keeps subagent tool results out of the main tool-result queue', async () => {
    const queue: Array<{ toolCallId?: string; content: string }> = []
    const hooks = buildToolCaptureHooks(queue as never, [], [])!
    const post = hooks.PostToolUse![0].hooks[0] as unknown as (input: unknown) => Promise<unknown>

    // 子代理内部工具 —— 必须被过滤（否则会污染主对话时间线）。
    await post({ tool_name: 'Bash', tool_use_id: 't1', tool_response: 'sub-out', agent_id: 'agent-1' })
    expect(queue).toHaveLength(0)

    // 主对话工具 —— 照常入队。
    await post({ tool_name: 'Bash', tool_use_id: 't2', tool_response: 'main-out' })
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ toolCallId: 't2', content: 'main-out' })
  })
})
