// packages/server/src/__tests__/clone-chat-capture.test.ts
//
// 02 · 分身聊天（CloneRuntime）入账 —— billing NEW-r2 口径。
// Anti-fake-run（同 clone-stream-resume 模式）：真实 better-sqlite3 + applySchema +
// 真实路由 + streamSSE via app.request；只 mock CloneRuntime 的 chunk 流与 clone-resolver。
// NEW-r2：llm_calls 行 = 纯事实（source_path/归属/四类 token）；钱一律查询时经
// llm_calls_costed 视图派生（兜底价配在 beforeAll → 立即回算全部历史）。
// 期望 = 价格 × 行内 token /1e6 手算（独立真相源；cc×cache_write、cr×cache_read）：
//   PRIMARY   {3,15,3.75,0.3}: 1000×3+500×15+100×3.75+200×0.3 = 10935 → 0.010935。
//   SECONDARY {1,2,0.5,0.1}:    400×1+200×2+ 50×0.5 +25×0.1  =  827.5 → 0.0008275。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"
import { AgentSessionDAO } from "../db/dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { createCloneSessionRoutes } from "../routes/clone"

const control = vi.hoisted(() => ({
  chunks: [] as Array<Record<string, unknown>>,
}))

vi.mock("../services/agent/clone-runtime", () => ({
  CloneRuntime: class {
    constructor(_cloneDef: unknown, _org: string) {}
    getDefaultCwd(): string { return "/tmp/fake-cwd" }
    async *chat() {
      for (const chunk of control.chunks) yield chunk
    }
  },
}))

vi.mock("../services/agent/clone-resolver", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/agent/clone-resolver")>()
  return {
    ...real,
    resolveCloneInfo: (name: string) => {
      if (name !== "task-author") return null
      return {
        name, display_name: "Task Author", type: "built-in" as const,
        persona: "# task-author\n\nFake persona for test.",
        skills: [], memory_scope: "shared" as const,
      }
    },
  }
})

const ORG = "E2E_TEST_clone-chat"
const PRIMARY = "E2E_TEST_clone-primary"
const SECONDARY = "E2E_TEST_clone-secondary"

// P1 B3：sessions/messages 已迁 PG；P1 B4 票2B-1：llm_calls/账本视图/价行亦迁 PG ——
// 本文件整体切 PG 随机库（SQLite 连接退役）。cost numeric → ::float8。用例语义与条数不变。
let pg: PgFixture | null = null
let db: Database.Database
let app: Hono
let sessionDAO: AgentSessionDAO
let tokenDao: TokenUsageDAO

async function createSession(): Promise<string> {
  const res = await app.request("/api/clones/task-author/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { id: string }).id
}

async function chatOnce(sessionId: string, message: string) {
  const res = await app.request(`/api/clones/task-author/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message }),
  })
  await res.text() // drain the SSE stream to completion
  return res
}

async function llmRows(): Promise<Array<Record<string, unknown>>> {
  return await pg!.sql`SELECT * FROM llm_calls ORDER BY call_index` as unknown as Array<Record<string, unknown>>
}

/** NEW-r2：钱不落账本 —— 按行 id 查视图派生 cost_usd（无价 → NULL，不焊 0）。 */
async function viewCost(id: unknown): Promise<number | null> {
  const rows = await pg!.sql`SELECT cost_usd::float8 AS cost_usd FROM llm_calls_costed WHERE id = ${String(id)}`
  const r = (rows as unknown as Array<{ cost_usd: number | null }>)[0]
  if (!r) throw new Error(`视图行缺失: id=${String(id)}`)
  return r.cost_usd
}

function resultChunk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result", sessionId: "E2E_TD_provider-sess-1",
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100 },
    modelUsages: [{
      model: PRIMARY, inputTokens: 1000, outputTokens: 500,
      cacheReadTokens: 200, cacheCreationTokens: 100, costUsd: 999.99, // SDK 上报价不作账（KD2）
    }],
    ...over,
  }
}

beforeAll(async () => {
  pg = await setupRegisteredPgSchema()
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(pg!.sql)
  tokenDao = new TokenUsageDAO(pg!.sql)
  app = new Hono()
  app.route("/api/clones", createCloneSessionRoutes({ sessionDAO, tokenUsageDao: tokenDao, partialFlushMs: 0 }))
  const billing = new BillingDAO(pg!.sql)
  await billing.createPrice({
    id: "OC-clone-p", vendor: "e2e", model_id: PRIMARY,
    input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
    currency: "USD",
  })
  await billing.createPrice({
    id: "OC-clone-s", vendor: "e2e", model_id: SECONDARY,
    input_unit_price: 1, output_unit_price: 2, cache_write_unit_price: 0.5, cache_read_unit_price: 0.1,
    currency: "USD",
  })
})

afterAll(async () => {
  await pg?.close()
  pg = null
  db.close()
})

beforeEach(async () => {
  await pg!.sql.unsafe("DELETE FROM llm_calls")
  control.chunks = []
})

describePg("分身聊天入账（票02 / US1）", () => {
  it("一轮对话 result chunk → 恰一行：source_path=clone_chat、session_id=会话、四类 token；视图 cost 与手算一致", async () => {
    const sessionId = await createSession()
    control.chunks = [{ type: "text_delta", content: "hello" }, resultChunk()]
    await chatOnce(sessionId, "E2E_TEST msg-1")

    const rows = await llmRows()
    expect(rows).toHaveLength(1) // 同一轮不产生重复行（AC2；含 messageUsages 单模型）
    const r = rows[0]
    expect(r).toMatchObject({
      source_path: "clone_chat",
      session_id: sessionId,
      // v47/票04 KD17「归属维度可得性如实」：聊天行无执行链路 → NULL，不造 FK 目标。
      node_execution_id: null,
      execution_id: null,
      org: ORG,
      model: PRIMARY,
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
    })
    // NEW-r2：行 = 纯事实，无任何快照列；钱 = 视图派生（兜底价命中 → 手算值，非 SDK 上报 999.99）
    expect(r).not.toMatchObject({ cost_usd: expect.anything() })
    expect(await viewCost(r.id)).toBeCloseTo(0.010935, 6)
  })

  it("未配价模型 → 行仍入账，视图 cost NULL（NEW-r2：unpriced 不焊 0、不估算）", async () => {
    const sessionId = await createSession()
    control.chunks = [resultChunk({
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      modelUsages: [{ model: "E2E_TEST_clone-noprice", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    })]
    await chatOnce(sessionId, "E2E_TEST msg-unpriced")

    const rows = await llmRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source_path: "clone_chat", session_id: sessionId, model: "E2E_TEST_clone-noprice",
      input_tokens: 10, output_tokens: 5,
    })
    expect(await viewCost(rows[0].id)).toBeNull()
    // 补上兜底价 → 同一行立即回算出钱（规则账语义；期望 10×3+5×15=105 /1e6）
    await new BillingDAO(pg!.sql).createPrice({
      id: "OC-clone-retro", vendor: "e2e", model_id: "E2E_TEST_clone-noprice",
      input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
      currency: "USD",
    })
    expect(await viewCost(rows[0].id)).toBeCloseTo(105 / 1e6, 12)
  })

  it("多模型 modelUsages → 每模型一行、各自经视图算价（per-call 粒度，不并成一坨）", async () => {
    const sessionId = await createSession()
    control.chunks = [resultChunk({
      usage: { inputTokens: 1400, outputTokens: 700, cacheReadTokens: 225, cacheCreationTokens: 150 },
      modelUsages: [
        { model: PRIMARY, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100 },
        { model: SECONDARY, inputTokens: 400, outputTokens: 200, cacheReadTokens: 25, cacheCreationTokens: 50 },
      ],
    })]
    await chatOnce(sessionId, "E2E_TEST msg-multi")

    const rows = await llmRows()
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.model).sort()).toEqual([PRIMARY, SECONDARY].sort())
    const primary = rows.find(r => r.model === PRIMARY)!
    const secondary = rows.find(r => r.model === SECONDARY)!
    expect(await viewCost(primary.id)).toBeCloseTo(0.010935, 6)
    expect(await viewCost(secondary.id)).toBeCloseTo(0.0008275, 6) // 400×1+200×2+50×0.5(cc)+25×0.1(cr) = 827.5 /1e6
    expect(rows.every(r => r.source_path === "clone_chat" && r.session_id === sessionId)).toBe(true)
  })

  it("无 result chunk（error/abort 路径）→ 不记行（有真值才记，不造数）", async () => {
    const sessionId = await createSession()
    control.chunks = [{ type: "text_delta", content: "half" }, { type: "error", code: "X", message: "boom" }]
    await chatOnce(sessionId, "E2E_TEST msg-error")
    expect(await llmRows()).toHaveLength(0)
    // 纯旁路：消息行照常落库（finalized，无 streaming 残留）
    // P1 B3: messages 已迁 PG —— 直读随机库；jsonb::text 冒号后有空白，改语义判定。
    const msg = (await pg!.sql`
      SELECT content, metadata::text AS metadata FROM messages
      WHERE session_id = ${sessionId} AND role='assistant'`)[0] as { content: string; metadata: string }
    expect(msg.content).toBe("half")
    expect((JSON.parse(msg.metadata) as { streaming?: unknown }).streaming).toBeUndefined()
  })

  it("token/usage 全零的 result → 不记行（真值为空不造数）", async () => {
    const sessionId = await createSession()
    control.chunks = [resultChunk({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      modelUsages: [{ model: PRIMARY, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }],
    })]
    await chatOnce(sessionId, "E2E_TEST msg-zero")
    expect(await llmRows()).toHaveLength(0)
  })

  it("多轮会话：每轮各记一行（append 语义，与 workflow per-turn 一致）", async () => {
    const sessionId = await createSession()
    control.chunks = [resultChunk()]
    await chatOnce(sessionId, "E2E_TEST round-1")
    await chatOnce(sessionId, "E2E_TEST round-2")
    const rows = await llmRows()
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.session_id === sessionId && r.source_path === "clone_chat")).toBe(true)
    // 每行独立 id，不覆盖前一行；各自视图 cost 都命中兜底价
    expect(new Set(rows.map(r => r.id)).size).toBe(2)
    for (const r of rows) expect(Math.abs(Number(await viewCost(r.id)) - 0.010935) < 1e-9, `行 ${String(r.id)} 视图 cost 偏离手算值`).toBe(true)
  })
})
