// token-capture-1 票02 —— chat 轮次末捕获：明细批写 + 账本行。
// Verification Method 对照：①unit fake tracker 逐字段/归属/账本聚合 ②未定价三态 NULL
// ③integration 真 sqlite 临时库：同 trace 重放不双计 + ON CONFLICT 累计语义核对 ④seam:
// CloneRuntime.chat() 终局消费 tracker（中断轮不落库）。

import { describe, it, expect, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import fs from 'fs'
import type { LLMCallRecord } from '@octopus/providers'
import type { CloneDef } from '@octopus/shared'
import { applySchema } from '../../../db/schema'
import { TokenUsageDAO } from '../../../db/dao/token-usage-dao'
import { captureChatRound } from '../chat-usage-capture'
import { CloneRuntime } from '../clone-runtime'

// seam 测试注入 CloneRuntime 用的全局 getDb()（vi.mock 提升，运行期取值）
let mockDb: Database.Database | null = null
vi.mock('../../../db', () => ({
  getDb: () => {
    if (!mockDb) throw new Error('mockDb not set')
    return mockDb
  },
}))

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

function rec(over: Partial<LLMCallRecord>): LLMCallRecord {
  return {
    turnIndex: 1,
    messageId: `msg-${Math.round(performance.now() * 1000) % 100000}`,
    model: 'model-a',
    timestamp: 1000,
    durationMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...over,
  }
}

const CTX = { sessionId: 'sess-1', org: 'test-org', traceId: 'trace-1' }

function seedChatSession(db: Database.Database, id: string, workspaceId: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO chat_sessions (id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, workspaceId, now, now)
}

describe('captureChatRound — 明细批写 + 账本行（unit · fake tracker）', () => {
  let db: Database.Database | undefined
  afterEach(() => { db?.close() })

  it('N 个混合 model 的 record → N 条明细逐字段一致 + 每 model 恰 1 账本行', () => {
    db = freshDb()
    seedChatSession(db, 'sess-1', 'ws-9')
    const dao = new TokenUsageDAO(db)
    const records = [
      rec({ messageId: 'm1', model: 'model-a', turnIndex: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 1, cacheCreationTokens: 2, costUsd: 0.1, stopReason: 'tool_use', durationMs: 111, ttftMs: 5, timestamp: 1700 }),
      rec({ messageId: 'm2', model: 'model-b', turnIndex: 2, inputTokens: 30, outputTokens: 40, cacheReadTokens: 3, cacheCreationTokens: 4, costUsd: 0.2, timestamp: 1701 }),
      rec({ messageId: 'm3', model: 'model-a', turnIndex: 2, inputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.3, timestamp: 1702 }),
    ]
    captureChatRound(dao, { ...CTX, records })

    const details = db.prepare('SELECT * FROM llm_calls ORDER BY call_index').all() as Array<Record<string, unknown>>
    expect(details.length).toBe(3)
    details.forEach((d, i) => {
      const r = records[i]!
      expect(d).toMatchObject({
        id: `chat:trace-1:${r.messageId}`,
        node_execution_id: null,
        execution_id: null,
        turn_index: r.turnIndex,
        call_index: i,
        message_id: r.messageId,
        model: r.model,
        stop_reason: r.stopReason ?? null,
        timestamp: r.timestamp,
        duration_ms: r.durationMs,
        ttft_ms: r.ttftMs ?? null,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_read_tokens: r.cacheReadTokens,
        cache_creation_tokens: r.cacheCreationTokens,
        cost_usd: r.costUsd,
        org: 'test-org',
        workspace_id: 'ws-9',
        session_id: 'sess-1',
        source: 'chat',
        trace_id: 'trace-1',
        span_id: r.messageId,
      })
    })

    const ledgers = db.prepare("SELECT * FROM node_token_usages WHERE source = 'chat' ORDER BY model").all() as Array<Record<string, unknown>>
    expect(ledgers.map(l => l.model)).toEqual(['model-a', 'model-b'])
    const a = ledgers[0]!, b = ledgers[1]!
    // 账本四字段 = 该组明细之和
    expect([a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_creation_tokens]).toEqual([15, 26, 1, 2])
    expect([b.input_tokens, b.output_tokens, b.cache_read_tokens, b.cache_creation_tokens]).toEqual([30, 40, 3, 4])
    // 费用与明细和逐一对上（US3）
    expect(Math.abs((a.cost_usd as number) - 0.4)).toBeLessThan(1e-9)
    expect(Math.abs((b.cost_usd as number) - 0.2)).toBeLessThan(1e-9)
    // chat 账本行带 session_id/trace_id（01 新列），无节点宿主
    expect(a).toMatchObject({ node_execution_id: null, session_id: 'sess-1', trace_id: 'trace-1', source: 'chat' })
  })

  it('会话上下文缺失时 workspace_id 落 NULL（main-agent 会话不在 chat_sessions）', () => {
    db = freshDb()
    const dao = new TokenUsageDAO(db)
    captureChatRound(dao, { ...CTX, records: [rec({ messageId: 'm1' })] })
    expect((db.prepare('SELECT workspace_id FROM llm_calls').get() as { workspace_id: string | null }).workspace_id).toBeNull()
  })

  it('未定价三态：costUsd=undefined → 明细/账本 cost 均 NULL，非 0（绝不把未知焊成 0）', () => {
    db = freshDb()
    const dao = new TokenUsageDAO(db)
    const records = [
      rec({ messageId: 'm1', model: 'zz-unpriced-model-xyz', costUsd: undefined, inputTokens: 7, outputTokens: 9 }),
      rec({ messageId: 'm2', model: 'zz-unpriced-model-xyz', costUsd: undefined, inputTokens: 1, outputTokens: 1 }),
    ]
    captureChatRound(dao, { ...CTX, records })
    const costs = (db.prepare('SELECT cost_usd FROM llm_calls').all() as Array<{ cost_usd: number | null }>).map(r => r.cost_usd)
    expect(costs).toEqual([null, null])
    const ledger = db.prepare("SELECT cost_usd FROM node_token_usages WHERE source = 'chat'").get() as { cost_usd: number | null }
    expect(ledger.cost_usd).toBeNull()
  })

  it('空 records（provider 未给追踪）→ 零落库、不抛', () => {
    db = freshDb()
    const dao = new TokenUsageDAO(db)
    expect(() => captureChatRound(dao, { ...CTX, records: [] })).not.toThrow()
    expect((db.prepare('SELECT COUNT(*) n FROM llm_calls').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) n FROM node_token_usages').get() as { n: number }).n).toBe(0)
  })
})

describe('captureChatRound — integration（真 sqlite）：重放不双计 + upsert 累计语义核对', () => {
  let db: Database.Database | undefined
  afterEach(() => { db?.close() })

  const records = () => [
    rec({ messageId: 'm1', model: 'model-a', inputTokens: 10, outputTokens: 20, costUsd: 0.1 }),
    rec({ messageId: 'm2', model: 'model-a', inputTokens: 1, outputTokens: 2, costUsd: 0.2 }),
  ]

  it('同 trace 重放（同 ctx 二次捕获）→ 行数与逐值不变', () => {
    db = freshDb()
    const dao = new TokenUsageDAO(db)
    captureChatRound(dao, { ...CTX, records: records() })
    const before = {
      lc: db.prepare('SELECT id, input_tokens, cost_usd FROM llm_calls ORDER BY id').all(),
      ntu: db.prepare('SELECT id, input_tokens, output_tokens, cost_usd FROM node_token_usages ORDER BY id').all(),
    }
    captureChatRound(dao, { ...CTX, records: records() })
    expect(db.prepare('SELECT id, input_tokens, cost_usd FROM llm_calls ORDER BY id').all()).toEqual(before.lc)
    expect(db.prepare('SELECT id, input_tokens, output_tokens, cost_usd FROM node_token_usages ORDER BY id').all()).toEqual(before.ntu)
  })

  it('recordNodeUsage 的 ON CONFLICT 累计语义保持（同 id 显式双写 = 累加，engine/harness 重跑依赖）', () => {
    db = freshDb()
    const dao = new TokenUsageDAO(db)
    const input = {
      id: 'chat:trace-x:model-a', nodeExecutionId: null as string | null, model: 'model-a',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      costUsd: 0.5, source: 'chat' as const, createdAt: new Date().toISOString(),
      sessionId: 'sess-1', traceId: 'trace-x',
    }
    dao.recordNodeUsage(input)
    dao.recordNodeUsage(input)
    const row = db.prepare('SELECT input_tokens, output_tokens, cost_usd, session_id, trace_id FROM node_token_usages WHERE id = ?').get('chat:trace-x:model-a') as
      { input_tokens: number; output_tokens: number; cost_usd: number; session_id: string; trace_id: string }
    expect(row).toEqual({ input_tokens: 20, output_tokens: 40, cost_usd: 1.0, session_id: 'sess-1', trace_id: 'trace-x' })
  })
})

describe('CloneRuntime.chat() 收口（seam）：轮次末消费 tracker', () => {
  const TEST_DIR = path.join(os.tmpdir(), `chat-capture-seam-${process.pid}`)
  let db: Database.Database | undefined

  afterEach(() => {
    mockDb = null
    db?.close()
    vi.restoreAllMocks()
    delete process.env.OCTOPUS_HOME
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* non-fatal */ }
  })

  function makeRuntime(): CloneRuntime {
    process.env.OCTOPUS_HOME = TEST_DIR
    const cloneDef = {
      name: 'workspace', displayName: 't', type: 'built-in', persona: 'p',
      skills: [], memoryScope: 'shared', config: {},
    } as CloneDef
    return new CloneRuntime(cloneDef, 'test-org')
  }

  it('流终局 → tracker 的 records 落库为 chat 明细 + 账本行', async () => {
    db = freshDb()
    mockDb = db
    const records = [rec({ messageId: 'm1', model: 'model-a', inputTokens: 10, outputTokens: 20, costUsd: 0.1 })]
    const providers = await import('@octopus/providers')
    let sends = 0
    vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
      getType: () => 'claude',
      sendQuery: async function* () { sends++; yield { type: 'text', text: 'ok' } },
      getLLMCalls: () => records,
    }) as unknown as ReturnType<typeof providers.getProvider>)

    const runtime = makeRuntime()
    for await (const _chunk of runtime.chat('hello', 'sess-seam', null, TEST_DIR)) { /* drain */ }

    expect(sends).toBe(1)
    const details = db.prepare("SELECT * FROM llm_calls WHERE source = 'chat'").all()
    expect(details.length).toBe(1)
    expect((details[0] as Record<string, unknown>).trace_id).toBeTruthy() // 本轮 trace：session 内新生成
    const ledger = db.prepare("SELECT COUNT(*) n FROM node_token_usages WHERE source = 'chat'").get() as { n: number }
    expect(ledger.n).toBe(1)
  })

  it('消费者中断（未终局）→ 零落库（KD3：丢当前轮）', async () => {
    db = freshDb()
    mockDb = db
    const providers = await import('@octopus/providers')
    vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
      getType: () => 'claude',
      sendQuery: async function* () {
        yield { type: 'text', text: 'a' }
        yield { type: 'text', text: 'b' }
      },
      getLLMCalls: () => [rec({ messageId: 'm1' })],
    }) as unknown as ReturnType<typeof providers.getProvider>)

    const runtime = makeRuntime()
    for await (const _chunk of runtime.chat('hello', 'sess-seam', null, TEST_DIR)) {
      break // 提前中断 → generator .return()，终局代码不执行
    }
    expect((db.prepare('SELECT COUNT(*) n FROM llm_calls').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) n FROM node_token_usages').get() as { n: number }).n).toBe(0)
  })

  it('provider 不暴露 getLLMCalls（旧 mock 形状）→ 不抛、零落库', async () => {
    db = freshDb()
    mockDb = db
    const providers = await import('@octopus/providers')
    vi.spyOn(providers, 'getProvider').mockImplementation(() => ({
      getType: () => 'claude',
      sendQuery: async function* () { yield { type: 'text', text: 'ok' } },
    }) as unknown as ReturnType<typeof providers.getProvider>)

    const runtime = makeRuntime()
    const chunks: unknown[] = []
    for await (const c of runtime.chat('hello', 'sess-seam', null, TEST_DIR)) chunks.push(c)
    expect(chunks.length).toBe(1)
    expect((db.prepare('SELECT COUNT(*) n FROM llm_calls').get() as { n: number }).n).toBe(0)
  })
})
