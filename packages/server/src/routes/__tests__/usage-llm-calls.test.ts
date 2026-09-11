// token-capture-1 票03 —— GET /api/usage/llm-calls 回读 API。
// Verification Method：①session 查仅回 chat 域行、逐字段与 sqlite 直查一致；engine 行按
// source 过滤可查 ②rounds = 同条件手算 GROUP BY 逐一对上（API↔DB 交叉）③边界：全空参
// 400 / limit>500 截断 / from-to 生效。

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { createUsageRoutes } from "../usage"
import type { LlmCallRow } from "../../db/types"

let db: Database.Database
let dao: TokenUsageDAO
let app: Hono

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  dao = new TokenUsageDAO(db)
  app = new Hono()
  app.route("/api/usage", createUsageRoutes(dao))
})

afterEach(() => {
  db.close()
})

/** 票02 形状：chat 明细（host NULL，source='chat'，trace/span/session 齐）。 */
function chatRow(over: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    id: `chat:t1:${Math.random().toString(36).slice(2)}`,
    node_execution_id: null,
    execution_id: null,
    turn_index: 1,
    call_index: 0,
    message_id: "m-x",
    model: "claude-test",
    stop_reason: "end_turn",
    timestamp: 1700,
    duration_ms: 100,
    ttft_ms: 5,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 1,
    cache_creation_tokens: 2,
    cost_usd: 0.1,
    org: "test-org",
    workspace_id: "ws-1",
    workflow_ref: null,
    node_id: null,
    session_id: "sess-1",
    instance_id: null,
    source: "chat",
    trace_id: "t1",
    span_id: "m-x",
    ...over,
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

describe("GET /api/usage/llm-calls", () => {
  it("植入 chat + engine 行 → session_id 查询仅回 chat 域行，逐字段与 sqlite 直查一致", async () => {
    dao.insertLlmCallBatch([
      chatRow({ id: "c1", message_id: "m1", span_id: "m1", input_tokens: 10, output_tokens: 20, cost_usd: 0.1 }),
      chatRow({ id: "c2", message_id: "m2", span_id: "m2", trace_id: "t2", model: "claude-haiku", input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: null }),
      // engine 行（phase2 补标语境用 source='node'；同样带 session_id 考验 source 缺省口径）
      chatRow({ id: "e1", source: "node", message_id: "e-m1", span_id: null, trace_id: null }),
    ])

    const res = await app.request("/api/usage/llm-calls?session_id=sess-1")
    expect(res.status).toBe(200)
    const body = await json(res)
    const calls = body.calls as Array<Record<string, unknown>>
    expect(calls.map(x => x.id).sort()).toEqual(["c1", "c2"]) // 缺省 source='chat'

    // 逐字段与 sqlite 直查一致 + snake→camel 出口（ADR-0014）
    const direct = db.prepare("SELECT * FROM llm_calls WHERE id='c1'").get() as Record<string, unknown>
    expect(calls.find(x => x.id === "c1")).toEqual({
      id: direct.id, nodeExecutionId: direct.node_execution_id, executionId: direct.execution_id,
      turnIndex: direct.turn_index, callIndex: direct.call_index, messageId: direct.message_id,
      model: direct.model, stopReason: direct.stop_reason, timestamp: direct.timestamp,
      durationMs: direct.duration_ms, ttftMs: direct.ttft_ms, inputTokens: direct.input_tokens,
      outputTokens: direct.output_tokens, cacheReadTokens: direct.cache_read_tokens,
      cacheCreationTokens: direct.cache_creation_tokens, costUsd: direct.cost_usd,
      org: direct.org, workspaceId: direct.workspace_id, workflowRef: direct.workflow_ref,
      nodeId: direct.node_id, sessionId: direct.session_id, instanceId: direct.instance_id,
      source: direct.source, traceId: direct.trace_id, spanId: direct.span_id,
    })

    // engine 行按 source 过滤可查
    const engineRes = await app.request("/api/usage/llm-calls?session_id=sess-1&source=node")
    const engineCalls = (await json(engineRes)).calls as Array<{ id: string }>
    expect(engineCalls.map(x => x.id)).toEqual(["e1"])
  })

  it("rounds 聚合 = 同条件手算 GROUP BY trace_id 逐一对上", async () => {
    dao.insertLlmCallBatch([
      chatRow({ id: "c1", message_id: "m1", span_id: "m1", trace_id: "t1", model: "model-a", input_tokens: 10, output_tokens: 20, cache_read_tokens: 1, cache_creation_tokens: 2, cost_usd: 0.1 }),
      chatRow({ id: "c2", message_id: "m2", span_id: "m2", trace_id: "t1", model: "model-a", input_tokens: 5, output_tokens: 6, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.2 }),
      chatRow({ id: "c3", message_id: "m3", span_id: "m3", trace_id: "t2", model: "model-b", input_tokens: 100, output_tokens: 200, cache_read_tokens: 3, cache_creation_tokens: 4, cost_usd: null }),
    ])

    const body = await json(await app.request("/api/usage/llm-calls?session_id=sess-1"))
    const rounds = body.rounds as Array<Record<string, unknown>>
    expect(rounds.length).toBe(2)

    // 手算：t1 = 两行和（totalTokens 具名口径 = 四字段全口径含 cache）
    const byTrace = Object.fromEntries(rounds.map(r => [r.traceId as string, r]))
    expect(byTrace.t1).toMatchObject({
      models: ["model-a"],
      inputTokens: 15, outputTokens: 26, cacheReadTokens: 1, cacheCreationTokens: 2,
      totalTokens: 15 + 26 + 1 + 2,
      costUsd: 0.30000000000000004, // 未定价三态：全有价 → 部分和即全量
    })
    // t3 未定价 → costUsd null（绝不焊 0）；DB 交叉：SQL GROUP BY 逐值对照
    expect(byTrace.t2).toMatchObject({
      models: ["model-b"],
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 3, cacheCreationTokens: 4,
      totalTokens: 307,
      costUsd: null,
    })
    const sql = db.prepare(`
      SELECT trace_id,
        SUM(input_tokens) ti, SUM(output_tokens) to2, SUM(cache_read_tokens) cr,
        SUM(cache_creation_tokens) cc, SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens) tot,
        CASE WHEN COUNT(cost_usd)=0 THEN NULL ELSE SUM(cost_usd) END cost
      FROM llm_calls WHERE source='chat' AND session_id='sess-1' GROUP BY trace_id`).all() as Array<Record<string, unknown>>
    for (const s of sql) {
      const r = byTrace[s.trace_id as string] as Record<string, number | null>
      expect([r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.totalTokens, r.costUsd])
        .toEqual([s.ti, s.to2, s.cr, s.cc, s.tot, s.cost])
    }
  })

  it("trace_id 查询走同一路径；未知 session 返回空数组（非 404）", async () => {
    dao.insertLlmCallBatch([chatRow({ id: "c1", message_id: "m1", span_id: "m1", trace_id: "tX" })])
    const byTrace = await json(await app.request("/api/usage/llm-calls?trace_id=tX"))
    expect((byTrace.calls as unknown[]).length).toBe(1)
    expect((byTrace.rounds as Array<Record<string, unknown>>)[0].traceId).toBe("tX")

    const unknown = await app.request("/api/usage/llm-calls?session_id=nope")
    expect(unknown.status).toBe(200)
    const u = await json(unknown)
    expect(u.calls).toEqual([])
    expect(u.rounds).toEqual([])
  })

  describe("参数边界", () => {
    it("全空参 → 400；只有 source / 只有 from-to → 也 400（session_id/trace_id 必含其一）", async () => {
      expect((await app.request("/api/usage/llm-calls")).status).toBe(400)
      expect((await app.request("/api/usage/llm-calls?source=chat")).status).toBe(400)
      expect((await app.request("/api/usage/llm-calls?from=1&to=2")).status).toBe(400)
    })

    it("非数字 from/to → 400", async () => {
      expect((await app.request("/api/usage/llm-calls?session_id=s1&from=abc")).status).toBe(400)
      expect((await app.request("/api/usage/llm-calls?session_id=s1&to=1.5")).status).toBe(400)
    })

    it("limit 默认 100、>500 截断到 500（植入 601 行）", async () => {
      const rows = Array.from({ length: 601 }, (_, i) =>
        chatRow({ id: `c${i}`, message_id: `m${i}`, span_id: `m${i}`, trace_id: `t-${i % 2}`, timestamp: 1000 + i }))
      dao.insertLlmCallBatch(rows)

      const dflt = await json(await app.request("/api/usage/llm-calls?session_id=sess-1"))
      expect((dflt.calls as unknown[]).length).toBe(100)
      const capped = await json(await app.request("/api/usage/llm-calls?session_id=sess-1&limit=9999"))
      expect((capped.calls as unknown[]).length).toBe(500)
      const small = await json(await app.request("/api/usage/llm-calls?session_id=sess-1&limit=7"))
      expect((small.calls as unknown[]).length).toBe(7)
      const garbage = await json(await app.request("/api/usage/llm-calls?session_id=sess-1&limit=abc"))
      expect((garbage.calls as unknown[]).length).toBe(100) // 非数字回落默认
    })

    it("from/to（epoch ms）过滤生效", async () => {
      dao.insertLlmCallBatch([
        chatRow({ id: "lo", message_id: "m1", span_id: "m1", timestamp: 100 }),
        chatRow({ id: "mid", message_id: "m2", span_id: "m2", timestamp: 500 }),
        chatRow({ id: "hi", message_id: "m3", span_id: "m3", timestamp: 900 }),
      ])
      const win = await json(await app.request("/api/usage/llm-calls?session_id=sess-1&from=200&to=800"))
      expect((win.calls as Array<{ id: string }>).map(c => c.id)).toEqual(["mid"])
      const open = await json(await app.request("/api/usage/llm-calls?session_id=sess-1&from=500"))
      expect((open.calls as Array<{ id: string }>).map(c => c.id).sort()).toEqual(["hi", "mid"])
    })
  })
})
