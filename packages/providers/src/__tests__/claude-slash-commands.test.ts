// packages/providers/src/__tests__/claude-slash-commands.test.ts
//
// 斜杠命令（2026-10-31）：
//   真机实测（SDK 0.3.235）：CLI 本地执行的命令（/context /compact /usage …）
//   只产出「完整 assistant 消息 + result」，没有任何 stream_event 增量。
//   provider 旧逻辑把 assistant 事件整条丢掉 → 正文消失。
//   这里钉住：① 无增量时 assistant 正文只补发一次；② 有增量时不重复；
//   ③ system:init 的 slash_commands 透传（terminal 绑定命令剔除）；
//   ④ /clear 的 conversation_reset 透传。

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
})
