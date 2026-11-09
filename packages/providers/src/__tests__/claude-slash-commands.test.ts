// packages/providers/src/__tests__/claude-slash-commands.test.ts
//
// 斜杠命令（2026-10-31）：
//   真机实测（SDK 0.3.235）：CLI 本地执行的命令（/context /compact /usage …）
//   只产出「完整 assistant 消息 + result」，没有任何 stream_event 增量。
//   provider 旧逻辑把 assistant 事件整条丢掉 → 正文消失。
//   这里钉住：① 无增量时 assistant 正文只补发一次；② 有增量时不重复；
//   ③ system:init 的 slash_commands 透传（terminal 绑定命令剔除）；
//   ④ /clear 的 conversation_reset 透传。
//
// 压缩（2026-11-04 真机补测）：
//   手动 /compact 成功时 CLI 只发 system:compact_boundary（带 token 账），
//   没有 assistant 消息，result 正文为空 —— 旧逻辑整轮不可见，ctx 角标也停在
//   压缩前的数字。这里钉住：⑤ boundary 后立刻刷新 context_usage；
//   ⑥ 手动压缩补一条可见回执（auto 压缩不补）；⑦ 本地命令的空 result 正常收轮。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk } from '../types'
import { ClaudeSDKProvider } from '../claude/provider'

interface MockQuery extends AsyncGenerator<unknown> {
  interrupt: () => Promise<void>
  getContextUsage: () => Promise<unknown>
}

let mockQuery: ReturnType<typeof vi.fn>
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

const CTX = { categories: [], totalTokens: 0, maxTokens: 200000, rawMaxTokens: 200000, percentage: 0, model: 'test-model' }

function makeQuery(gen: AsyncGenerator<unknown>): MockQuery {
  const q = gen as MockQuery
  q.interrupt = async () => {}
  q.getContextUsage = async () => CTX
  return q
}

async function drain(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

const MODEL_USAGE = { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 }
const RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 'sdk-1',
  result: '',
  num_turns: 1,
  modelUsage: { 'claude-test': MODEL_USAGE },
}

beforeEach(() => {
  mockQuery = vi.fn()
})

describe('ClaudeSDKProvider slash commands', () => {
  it('system:init 透传 slash_commands，剔除 terminal 绑定命令', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-1',
        slash_commands: ['compact', 'context', 'user-skill', 'exit'],
        terminal_slash_commands: ['exit'],
      }
      yield RESULT
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('/context', '/tmp'))

    const advertised = chunks.find((c) => c.type === 'slash_commands')
    expect(advertised).toEqual({
      type: 'slash_commands',
      commands: ['compact', 'context', 'user-skill'],
    })
  })

  it('system:init 同时透传完整 init 快照（tools / MCP / skills / plugins）', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sdk-1',
        claude_code_version: '2.1.250',
        model: 'claude-test',
        cwd: '/tmp/ws',
        permissionMode: 'default',
        output_style: 'default',
        apiKeySource: 'none',
        effort: 'high',
        tools: ['Read', 'Bash'],
        mcp_servers: [{ name: 'octopus-workflow', status: 'connected' }],
        agents: ['workspace'],
        skills: ['octo-ui-review'],
        plugins: [{ name: 'task-author', path: '/tmp/task-author', version: '1.0.0' }],
        slash_commands: ['compact'],
        capabilities: ['interrupt_receipt_v1'],
      }
      yield RESULT
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('hi', '/tmp'))
    const init = chunks.find((c) => c.type === 'system_init')
    expect(init).toEqual({
      type: 'system_init',
      data: {
        claudeCodeVersion: '2.1.250',
        model: 'claude-test',
        cwd: '/tmp/ws',
        permissionMode: 'default',
        outputStyle: 'default',
        apiKeySource: 'none',
        effort: 'high',
        tools: ['Read', 'Bash'],
        mcpServers: [{ name: 'octopus-workflow', status: 'connected' }],
        agents: ['workspace'],
        skills: ['octo-ui-review'],
        plugins: [{ name: 'task-author', path: '/tmp/task-author', version: '1.0.0' }],
        slashCommands: ['compact'],
        capabilities: ['interrupt_receipt_v1'],
        betas: [],
      },
    })
    // existing command-menu chunk still works
    expect(chunks.find((c) => c.type === 'slash_commands')).toEqual({
      type: 'slash_commands', commands: ['compact'],
    })
  })

  it('无流式增量的 assistant 正文补发一次（/context 场景）', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield {
        type: 'assistant',
        message: { id: 'msg-slash', content: [{ type: 'text', text: '## Context Usage\n\n15%' }] },
      }
      yield { ...RESULT, result: '## Context Usage\n\n15%' }
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('/context', '/tmp'))

    const deltas = chunks.filter((c) => c.type === 'text_delta')
    expect(deltas).toEqual([
      { type: 'text_delta', content: '## Context Usage\n\n15%', messageId: 'msg-slash' },
    ])
    const result = chunks.find((c) => c.type === 'result')
    expect(result).toMatchObject({ content: '## Context Usage\n\n15%' })
  })

  it('有流式增量的消息不重复补发（正常回复不回归）', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1', model: 'claude-test' } } }
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      }
      yield { type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'hi' }] } }
      yield { ...RESULT, result: 'hi' }
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('hi', '/tmp'))

    const deltas = chunks.filter((c) => c.type === 'text_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]).toMatchObject({ content: 'hi', messageId: 'msg-1' })
  })

  it('/clear 的 conversation_reset 透传', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield { type: 'conversation_reset' }
      yield { type: 'system', subtype: 'init', session_id: 'sdk-2', slash_commands: ['compact'] }
      yield { ...RESULT, session_id: 'sdk-2' }
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('/clear', '/tmp'))

    expect(chunks.some((c) => c.type === 'conversation_reset')).toBe(true)
    const result = chunks.find((c) => c.type === 'result')
    expect(result).toMatchObject({ sessionId: 'sdk-2' })
  })

  it('手动 /compact：boundary 后立刻刷新 ctx，并补一条可见回执', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield { type: 'system', subtype: 'status', status: 'compacting' }
      yield { type: 'system', subtype: 'status', status: null }
      yield { type: 'system', subtype: 'init', session_id: 'sdk-1', slash_commands: [] }
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'sdk-1',
        compact_metadata: {
          trigger: 'manual',
          pre_tokens: 24960,
          post_tokens: 1021,
          cumulative_dropped_tokens: 23939,
          duration_ms: 11189,
        },
      }
      // 真机形状：成功后 result 正文为空，modelUsage 带着压缩本身的用量。
      yield {
        ...RESULT,
        result: '',
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('/compact', '/tmp'))

    // ⑤ ctx 角标不用等下一轮：boundary 就报出新占用。
    const ctx = chunks.find((c) => c.type === 'context_usage')
    expect(ctx).toEqual({ type: 'context_usage', data: CTX })

    // ⑤-2 压缩本身也必须显式上报（宿主据此在下一轮重发一轮性上下文）。
    expect(chunks.find((c) => c.type === 'compaction')).toEqual({
      type: 'compaction',
      trigger: 'manual',
      preTokens: 24960,
      postTokens: 1021,
      droppedTokens: 23939,
      durationMs: 11189,
    })

    // ⑥ 空正文轮补一条回执，且先于 result（route 会据此落库成 assistant 行）。
    const receipt = chunks.find((c) => c.type === 'local_command_output')
    expect(receipt).toEqual({
      type: 'local_command_output',
      content: '上下文已压缩：24,960 → 1,021 tokens',
    })
    expect(chunks.findIndex((c) => c.type === 'local_command_output'))
      .toBeLessThan(chunks.findIndex((c) => c.type === 'result'))

    // 本轮照常收轮。
    expect(chunks.some((c) => c.type === 'result')).toBe(true)
  })

  it('自动压缩只刷新 ctx，不往正常回复里塞回执', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield { type: 'system', subtype: 'status', status: 'compacting' }
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'sdk-1',
        compact_metadata: { trigger: 'auto', pre_tokens: 190000, post_tokens: 12000 },
      }
      yield { ...RESULT, result: 'done' }
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('hi', '/tmp'))

    expect(chunks.find((c) => c.type === 'context_usage')).toEqual({ type: 'context_usage', data: CTX })
    // auto 压缩同样要上报（服务端只能从这里知道转录被重写过）。
    expect(chunks.find((c) => c.type === 'compaction')).toEqual({
      type: 'compaction',
      trigger: 'auto',
      preTokens: 190000,
      postTokens: 12000,
    })
    expect(chunks.some((c) => c.type === 'local_command_output')).toBe(false)
    expect(chunks.find((c) => c.type === 'result')).toMatchObject({ content: 'done' })
  })

  it('/clear：空 result（num_turns=0 / 空 modelUsage）不被当成排队确认', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield { type: 'conversation_reset' }
      yield { type: 'system', subtype: 'init', session_id: 'sdk-2', slash_commands: [] }
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-2',
        result: '',
        num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
      }
    })()))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('/clear', '/tmp'))

    expect(chunks.some((c) => c.type === 'conversation_reset')).toBe(true)
    expect(chunks.find((c) => c.type === 'result')).toMatchObject({ sessionId: 'sdk-2' })
  })
})
