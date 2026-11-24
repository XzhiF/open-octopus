// packages/providers/src/__tests__/claude-context-usage.test.ts
//
// ctx 角标刷新（2026-11-24 用户）：
//   旧逻辑每轮只在首条 message_start 报一次 context_usage —— 长轮跑一小时
//   角标都不动。这里钉住新口径：
//   ① 首条 message_start 必报；
//   ② 节流窗口（20s）内不重复；
//   ③ 窗口过后下一条 message_start 再报；
//   ④ 收轮（result）强制补一次，且发在 result 之前（宿主收到 result 就收轮）；
//   ⑤ 控制请求失败不破坏收轮。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

function ctxAt(totalTokens: number) {
  return {
    categories: [],
    totalTokens,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: Math.round((totalTokens / 200_000) * 1000) / 10,
    model: 'test-model',
  }
}

function makeQuery(
  gen: AsyncGenerator<unknown>,
  getContextUsage: () => Promise<unknown>,
): MockQuery {
  const q = gen as MockQuery
  q.interrupt = async () => {}
  q.getContextUsage = getContextUsage
  return q
}

const msgStart = (id: string) => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { id, model: 'test-model' } },
})

const RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 'sdk-1',
  result: '',
  num_turns: 1,
  modelUsage: {
    'claude-test': {
      inputTokens: 10, outputTokens: 2,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001,
    },
  },
}

type CtxChunk = Extract<MessageChunk, { type: 'context_usage' }>

async function drain(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

function ctxUsages(chunks: MessageChunk[]): CtxChunk[] {
  return chunks.filter((c): c is CtxChunk => c.type === 'context_usage')
}

beforeEach(() => {
  mockQuery = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ClaudeSDKProvider context_usage 刷新', () => {
  it('首条 message_start 必报；节流窗口内不重复；收轮再补一次且早于 result', async () => {
    let calls = 0
    const readCtx = vi.fn(async () => ctxAt(1_000 * (++calls)))
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield msgStart('m1')
      yield msgStart('m2') // 同一瞬间：被 20s 节流挡下
      yield RESULT
    })(), readCtx))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('hi', '/tmp'))
    const usages = ctxUsages(chunks)

    expect(usages).toHaveLength(2)
    expect(usages[0].data.totalTokens).toBe(1_000)
    // 收轮这次是第二次控制请求（最新读数）。
    expect(usages[1].data.totalTokens).toBe(2_000)
    expect(calls).toBe(2)

    // 收轮刷新必须早于 result chunk。
    const lastCtxIdx = chunks.lastIndexOf(usages[1])
    const resultIdx = chunks.findIndex((c) => c.type === 'result')
    expect(resultIdx).toBeGreaterThan(-1)
    expect(lastCtxIdx).toBeLessThan(resultIdx)
  })

  it('节流窗口过后，下一条 message_start 再报一次', async () => {
    let now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let calls = 0
    const readCtx = vi.fn(async () => ctxAt(500 * (++calls)))
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield msgStart('m1')
      now += 21_000 // 越过 20s 节流窗口
      yield msgStart('m2')
      yield RESULT
    })(), readCtx))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('hi', '/tmp'))
    const usages = ctxUsages(chunks)

    // 首条 + 窗口后 + 收轮。
    expect(usages.map((u) => u.data.totalTokens)).toEqual([500, 1_000, 1_500])
  })

  it('控制请求失败不破坏收轮（角标事件缺省，result 照常）', async () => {
    const readCtx = vi.fn(async () => { throw new Error('unsupported') })
    mockQuery.mockImplementation(() => makeQuery((async function* () {
      yield msgStart('m1')
      yield RESULT
    })(), readCtx))

    const chunks = await drain(new ClaudeSDKProvider().sendQuery('hi', '/tmp'))

    expect(ctxUsages(chunks)).toHaveLength(0)
    expect(chunks.some((c) => c.type === 'result')).toBe(true)
    // 首报 + 收轮各尝试一次；失败计数未到上限，仍会重试。
    expect(readCtx).toHaveBeenCalledTimes(2)
  })
})
