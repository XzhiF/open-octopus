// packages/server/src/__tests__/executions-llm-calls-bynode.test.ts
//
// 票 11 ⑩回补（▤ 消耗页签的「按会话/节点」明细）—— GET /api/executions/:id/llm-calls
// **additive** 扩展：aggregates.byNode[] = 按 node_id 分组的逐节点账本（去重口径
// 与全局 totalCalls 同一条 message_id 规则，聚合公式 = shared llmUsageAggregates
// 单源，与会话口径孪生）。既有响应字段（data / aggregates 其余键）零变化。
//
// 期望值 = 手算 fixture（独立真相源，不反推实现）：
//   单价 in3/out15/cw3.75/cr0.30 每 1M。
//   c1 dev     1000/200/8000/500  msg m1  → 保留
//   c4 dev      700/ 50/    0/  0  msg m1  → 写侧兜底去重，不落库（读侧再挡一遍）
//   c2 dev      500/100/    0/  0  msg m2  → 保留
//   c3 verify  2000/400/ 1000/  0  msg m3  → 保留
//   c5 (无节点) 100/ 10/    0/  0  msg m5  → 保留（execution 级计数），byNode 无归属行
//   ⇒ 全局 totalCalls=4；dev=2（∑tokens 10300、cost (1500*3+300*15+500*3.75+8000*0.3)/1e6
//      = 13275/1e6、hit 8000/(1500+8000)）；verify=1（∑tokens 3400、cost 12300/1e6）。
//   分组顺序 = 首次出现（turn_index, call_index）：dev 先于 verify。

import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { WorkspaceDAO } from "../db/dao/workspace-dao"
import { createAnalyticsRoutes } from "../routes/analytics"
import type { LlmCallRow } from "../db/types"

const ORG = "bynode"

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
  return db
}

function seedWs(db: Database.Database, id = "ws-1") {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at)
     VALUES (?, ?, ?, '/tmp/bynode', 'manual', 'active', ?, ?)`,
  ).run(id, `ws-${id}`, ORG, now, now)
}

function seedExec(db: Database.Database, id: string) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
      status, input_values, var_pool, org, created_at, updated_at)
    VALUES (?, 'ws-1', '0', 0, 'built-in/wf', 'wf', 'completed', '{}', '{}', ?, ?, ?)
  `).run(id, ORG, now, now)
}

function seedPrice(db: Database.Database, modelId: string) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price,
      cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
    VALUES (?, 'anthropic', ?, 3, 15, 3.75, 0.3, 'USD', NULL, NULL, ?, ?)
  `).run(`price-${modelId}`, modelId, now, now)
}

function call(over: Partial<LlmCallRow> & { id: string }): LlmCallRow {
  return {
    node_execution_id: null,
    execution_id: "e1",
    turn_index: 1,
    call_index: 0,
    message_id: null,
    model: "claude-sonnet-4.5",
    stop_reason: "end_turn",
    timestamp: 1_700_000_000_000,
    duration_ms: 1000,
    ttft_ms: 100,
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 8000,
    cache_creation_tokens: 500,
    org: ORG,
    workspace_id: "ws-1",
    workflow_ref: null,
    node_id: null,
    session_id: null,
    instance_id: null,
    source_path: "workflow",
    ...over,
  }
}

let db: Database.Database
let dao: TokenUsageDAO

function app(): Hono {
  const r = createAnalyticsRoutes(new ExecutionDAO(db), dao, new WorkspaceDAO(db))
  const root = new Hono()
  root.route("/api", r)
  return root
}

beforeEach(() => {
  db = newDb()
  seedWs(db)
  seedExec(db, "e1")
  seedPrice(db, "claude-sonnet-4.5")
  dao = new TokenUsageDAO(db)
  // findLlmCallsByExecution ORDER BY turn_index, call_index —— 首现序即此序。
  dao.insertLlmCallBatch([
    call({ id: "c1", turn_index: 1, node_id: "dev", message_id: "m1" }),
    call({ id: "c4", turn_index: 2, node_id: "dev", message_id: "m1", input_tokens: 700, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 }),
    call({ id: "c2", turn_index: 3, node_id: "dev", message_id: "m2", input_tokens: 500, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 }),
    call({ id: "c3", turn_index: 4, node_id: "verify", message_id: "m3", input_tokens: 2000, output_tokens: 400, cache_read_tokens: 1000, cache_creation_tokens: 0 }),
    call({ id: "c5", turn_index: 5, node_id: null, message_id: "m5", input_tokens: 100, output_tokens: 10 }),
  ])
})

describe("GET /api/executions/:id/llm-calls — aggregates.byNode（票11 additive 扩展）", () => {
  it("执行级（无 nodeId）：byNode 按首次出现序逐节点成行，去重口径与全局一致", async () => {
    const res = await app().request("/api/executions/e1/llm-calls")
    expect(res.status).toBe(200)
    const body = await res.json() as {
      data: unknown[]
      aggregates: {
        totalCalls: number
        byNode?: Array<{ nodeId: string; totalCalls: number; usage: Record<string, number>; totals: { tokens: number; cost: { usd: number | null; complete: boolean }; cacheHitRate: number | null }; modelBreakdown: Record<string, unknown> }>
      }
    }

    // 既有字段零回归：data 原始行不裁（写侧 insertLlmCallBatch 已按 execution 内
    // message_id 兜底去重，重复行从未落库 —— 读侧去重是给批外写入的保险带）。
    expect(body.data).toHaveLength(4)
    expect(body.aggregates.totalCalls).toBe(4)

    const byNode = body.aggregates.byNode
    expect(byNode).toBeTruthy()
    expect(byNode!.map((n) => n.nodeId)).toEqual(["dev", "verify"]) // 无归属行（node_id null）不进分组

    const dev = byNode!.find((n) => n.nodeId === "dev")!
    expect(dev.totalCalls).toBe(2) // m1 重复行（c4）不计
    expect(dev.usage).toEqual({ inputTokens: 1500, outputTokens: 300, cacheReadTokens: 8000, cacheCreationTokens: 500 })
    expect(dev.totals.tokens).toBe(10300)
    expect(dev.totals.cost.usd).toBeCloseTo(13275 / 1e6, 12)
    expect(dev.totals.cost.complete).toBe(true)
    expect(dev.totals.cacheHitRate).toBeCloseTo(8000 / 9500, 10)

    const verify = byNode!.find((n) => n.nodeId === "verify")!
    expect(verify.totalCalls).toBe(1)
    expect(verify.usage).toEqual({ inputTokens: 2000, outputTokens: 400, cacheReadTokens: 1000, cacheCreationTokens: 0 })
    expect(verify.totals.tokens).toBe(3400)
    expect(verify.totals.cost.usd).toBeCloseTo(12300 / 1e6, 12)
  })

  it("?nodeId=dev 过滤形：响应保持既有形状（byNode 不塞进已过滤的账）", async () => {
    const res = await app().request("/api/executions/e1/llm-calls?nodeId=dev")
    expect(res.status).toBe(200)
    const body = await res.json() as { aggregates: Record<string, unknown> }
    expect(body.aggregates.byNode).toBeUndefined()
    expect(body.aggregates.totalCalls).toBeDefined()
  })

  it("无调用的执行：byNode = []（空数组不缺席，UI 空态直读）", async () => {
    const res = await app().request("/api/executions/e-empty/llm-calls")
    expect(res.status).toBe(200)
    const body = await res.json() as { aggregates: { totalCalls: number; byNode: unknown[] } }
    expect(body.aggregates.totalCalls).toBe(0)
    expect(body.aggregates.byNode).toEqual([])
  })
})
