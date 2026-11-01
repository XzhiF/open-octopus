// packages/providers/src/__tests__/claude-idle-watchdog.test.ts
//
// P0-2 契约（2026-11-01）：provider 的 SDK 迭代必须有空闲看门狗。
//   - 首个事件不来 / 中途长时间无事件 → 产出结构化 `{type:'error',code:'IDLE_TIMEOUT'}`
//     并结束生成器（而不是静默挂住整条聊天流）；
//   - 用户主动 abort 仍走原有中断路径，不得被误报成 IDLE_TIMEOUT；
//   - 正常流的行为不变。
//
// mock 的是 SDK 的 query()，provider 的转换/看门狗是真实代码。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk, SendQueryOptions } from '../types'
import { ClaudeSDKProvider } from '../claude/provider'

let mockQuery: ReturnType<typeof vi.fn>
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}))

const CTX = {
  categories: [],
  totalTokens: 0,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 0,
  model: 'test-model',
}

function makeQuery(gen: AsyncGenerator<unknown>) {
  const q = gen as AsyncGenerator<unknown> & {
    interrupt: () => Promise<void>
    getContextUsage: () => Promise<unknown>
  }
  q.interrupt = async () => {}
  q.getContextUsage = async () => CTX
  return q
}

async function drain(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

beforeEach(() => {
  mockQuery = vi.fn()
})

describe('ClaudeSDKProvider idle watchdog', () => {
  it('mid-stream silence yields IDLE_TIMEOUT and ends the generator', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm-1', model: 'test-model' } },
      }
      // Wedged SDK: never produces another event, never throws.
      await new Promise(() => {})
    })()))

    const provider = new ClaudeSDKProvider()
    const chunks = await drain(provider.sendQuery('hi', '/tmp', undefined, {
      firstEventTimeoutMs: 500,
      streamIdleTimeoutMs: 30,
    }))

    const last = chunks.at(-1)
    expect(last?.type).toBe('error')
    if (last?.type === 'error') {
      expect(last.code).toBe('IDLE_TIMEOUT')
      expect(last.message).toContain('30ms')
    }
  })

  it('no first event within the budget yields IDLE_TIMEOUT (subprocess never started)', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      await new Promise(() => {})
    })()))

    const provider = new ClaudeSDKProvider()
    const chunks = await drain(provider.sendQuery('hi', '/tmp', undefined, {
      firstEventTimeoutMs: 30,
      streamIdleTimeoutMs: 5_000,
    }))

    expect(chunks).toHaveLength(1)
    expect(chunks[0].type).toBe('error')
    if (chunks[0].type === 'error') {
      expect(chunks[0].code).toBe('IDLE_TIMEOUT')
      expect(chunks[0].message).toContain('30ms')
    }
  })

  it('a user abort is not misreported as IDLE_TIMEOUT', async () => {
    mockQuery.mockImplementation(({ options }: { options?: { abortController?: AbortController } }) =>
      makeQuery((async function* () {
        const signal = options?.abortController?.signal
        await new Promise<void>((resolve) => {
          if (signal?.aborted) { resolve(); return }
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      })()))

    const provider = new ClaudeSDKProvider()
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 10)

    const chunks = await drain(provider.sendQuery('hi', '/tmp', undefined, {
      abortSignal: ac.signal,
      firstEventTimeoutMs: 5_000,
      streamIdleTimeoutMs: 5_000,
    } satisfies SendQueryOptions))

    expect(chunks.some((c) => c.type === 'error' && c.code === 'IDLE_TIMEOUT')).toBe(false)
  })

  it('normal streams are unaffected by the watchdog', async () => {
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'm-1', model: 'test-model' } },
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
          delta: { type: 'text_delta', text: 'hello' },
        },
      }
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    })()))

    const provider = new ClaudeSDKProvider()
    const chunks = await drain(provider.sendQuery('hi', '/tmp', undefined, {
      firstEventTimeoutMs: 1_000,
      streamIdleTimeoutMs: 1_000,
    }))

    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(chunks.map((c) => c.type)).toContain('text_delta')
    expect(chunks.at(-1)?.type).toBe('result')
  })
})
