// packages/providers/src/__tests__/claude-interruptible.test.ts
//
// 2026-10-31 中断记账（provider 侧契约）：
//   1. `interruptible: true` → prompt 以 streaming input mode 传给 SDK
//      （async iterable），这是 Query.interrupt() 唯一可用的模式；
//   2. abortSignal 触发 → 调 q.interrupt()，而不是硬杀 abortController；
//   3. interrupt 后继续消费，把被中断轮的 error result（带 usage/modelUsage）
//      原样转成 error chunk 交给路由落账；
//   4. interrupt 后再等不到 result → 超过 drain 截止（2s）硬 abort 兜底。
//
// mock 的是 SDK 的 query()，provider 的转换逻辑是真实代码。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk, SendQueryOptions } from '../types'
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

function makeQuery(gen: AsyncGenerator<unknown>, interrupt: () => Promise<void> = async () => {}): MockQuery {
  const q = gen as MockQuery
  q.interrupt = interrupt
  q.getContextUsage = async () => CTX
  return q
}

async function drain(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

const MODEL_USAGE = { inputTokens: 245, outputTokens: 80, cacheReadInputTokens: 24064, cacheCreationInputTokens: 0, costUSD: 0.015 }
const USAGE = { inputTokens: 245, outputTokens: 80, cacheReadTokens: 24064, cacheCreationTokens: 0 }

beforeEach(() => {
  mockQuery = vi.fn()
})

describe('ClaudeSDKProvider interruptible', () => {
  it('uses streaming input mode only when interruptible is on', async () => {
    const prompts: unknown[] = []
    mockQuery.mockImplementation(() => makeQuery((async function* () {})()))
    const provider = new ClaudeSDKProvider()

    await drain(provider.sendQuery('hi', '/tmp'))
    await drain(provider.sendQuery('hi', '/tmp', undefined, { interruptible: true }))

    prompts.push(mockQuery.mock.calls[0][0].prompt, mockQuery.mock.calls[1][0].prompt)
    expect(typeof prompts[0]).toBe('string')
    expect(typeof prompts[1]).not.toBe('string')
    expect((prompts[1] as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBeTypeOf('function')
  })

  it('abortSignal → Query.interrupt() (not a hard kill), and the interrupted result lands as an error chunk with usage', async () => {
    const ac = new AbortController()
    let interruptCalled = 0
    let sdkAbort: AbortController | undefined

    mockQuery.mockImplementation(({ prompt, options }: { prompt: unknown; options: SendQueryOptions & { abortController?: AbortController } }) => {
      expect(typeof prompt).not.toBe('string') // streaming input mode
      sdkAbort = options.abortController
      return makeQuery(
        (async function* () {
          yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'test-model' } } }
          // 真实 CLI 在 clean interrupt 后仍会产出被中断轮的 result。
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            terminal_reason: 'aborted_tools',
            session_id: 'sdk-sess',
            num_turns: 1,
            usage: { input_tokens: 245, output_tokens: 80, cache_read_input_tokens: 24064, cache_creation_input_tokens: 0 },
            modelUsage: { 'test-model': MODEL_USAGE },
            total_cost_usd: 0.015,
            errors: ['interrupted'],
          }
        })(),
        async () => { interruptCalled += 1 },
      )
    })

    const provider = new ClaudeSDKProvider()
    const chunks: MessageChunk[] = []
    for await (const c of provider.sendQuery('write a very long essay', '/tmp', undefined, {
      interruptible: true,
      abortSignal: ac.signal,
    })) {
      chunks.push(c)
      if (c.type === 'message_start') ac.abort()
    }

    expect(interruptCalled).toBe(1)
    // 优雅中断 ≠ 硬杀：SDK 的 abortController 没有被 abort。
    expect(sdkAbort?.signal.aborted).toBe(false)

    const err = chunks.find((c) => c.type === 'error')
    expect(err).toMatchObject({
      code: 'error_during_execution',
      sdkTerminalReason: 'aborted_tools',
      costUsd: 0.015,
    })
    if (err?.type !== 'error') throw new Error('expected error chunk')
    expect(err.usage).toEqual(USAGE)
    expect(err.modelUsages).toEqual([expect.objectContaining({ model: 'test-model', inputTokens: 245, outputTokens: 80 })])
    // 中断轮不是 success：没有 result chunk 被伪造出来。
    expect(chunks.some((c) => c.type === 'result')).toBe(false)
  })

  it('degrades to a hard abort when no result arrives within the drain deadline', async () => {
    const ac = new AbortController()
    let hardAborted = false

    mockQuery.mockImplementation(({ options }: { options: { abortController?: AbortController } }) => {
      const controller = options.abortController!
      controller.signal.addEventListener('abort', () => { hardAborted = true }, { once: true })
      return makeQuery(
        (async function* () {
          yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'test-model' } } }
          // 永不产出 result —— 等 drain 截止后 provider 必须硬 abort。
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener('abort', () => resolve(), { once: true })
          })
        })(),
        async () => { /* interrupt 被 SDK 吞掉，没有任何结果 */ },
      )
    })

    const provider = new ClaudeSDKProvider()
    const t0 = Date.now()
    for await (const c of provider.sendQuery('hi', '/tmp', undefined, { interruptible: true, abortSignal: ac.signal })) {
      if (c.type === 'message_start') ac.abort()
    }

    expect(hardAborted).toBe(true)
    // 2s drain 截止 + 余量
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900)
  }, 15_000)
})
