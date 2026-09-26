// packages/server/src/__tests__/session-usage.test.ts
//
// v49 会话口径账本 —— 聊天 composer 的 token 角标（GET /api/sessions/:id/llm-calls）
// 与看板逐任务花费（Task.ai_usage = 作者会话段 ∪ 各实例 execution 段）的读路径。
// 钉三件事：
//   ① 会话口径**不做 message 去重**（去重属执行口径，见 DAO 注释）；
//   ② 钱是查询时派生的三态（未定价 → usd null + complete false，绝不焊 0）；
//   ③ 任务合并段不双计 —— 作者会话里带 execution 归属的行只归 execution 段。

import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { TokenUsageDAO, toLedgerRows } from "../db/dao/token-usage-dao"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { WorkspaceDAO } from "../db/dao/workspace-dao"
import { createAnalyticsRoutes } from "../routes/analytics"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { llmUsageAggregates } from "@octopus/shared"
import type { LlmCallRow } from "../db/types"

const ORG = "session-usage"

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
     VALUES (?, ?, ?, '/tmp/session-usage', 'manual', 'active', ?, ?)`,
  ).run(id, `ws-${id}`, ORG, now, now)
}

function seedSession(db: Database.Database, id: string) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sessions (id, org, title, clone_name, session_type, created_at, updated_at)
     VALUES (?, ?, '作者会话', 'task-author', 'clone_direct', ?, ?)`,
  ).run(id, ORG, now, now)
}

function seedTask(db: Database.Database, id: string, status: string, sessionId: string | null) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, '{"goal":"g","ac":[]}', '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, NULL)
  `).run(id, ORG, `t-${id}`, status, sessionId, now, now)
}

function seedExec(db: Database.Database, id: string, taskId: string) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
      status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index,
      started_at, completed_at)
    VALUES (?, 'ws-1', '0', 0, 'built-in/wf', 'wf', 'completed', '{}', '{}', ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(id, ORG, now, now, taskId, now, now)
}

/** 单价：USD 兜底行（双 NULL 窗口），in 3 / out 15 / cache_w 3.75 / cache_r 0.30 每 1M。 */
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
    execution_id: null,
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
    session_id: "s-1",
    instance_id: null,
    source_path: "clone_chat",
    ...over,
  }
}

let db: Database.Database
let dao: TokenUsageDAO

beforeEach(() => {
  db = newDb()
  seedWs(db)
  seedPrice(db, "claude-sonnet-4.5")
  dao = new TokenUsageDAO(db)
})

describe("findLlmCallsBySession — 会话口径不去重", () => {
  it("同 message_id 的双模型行都保留（去重会吞掉第二个模型）", () => {
    dao.insertLlmCallBatch([call({ id: "c1", message_id: "msg-A", model: "claude-sonnet-4.5" })])
    dao.insertLlmCallBatch([call({ id: "c2", message_id: "msg-A", model: "claude-haiku-4.5" })])

    const rows = dao.findLlmCallsBySession("s-1")
    expect(rows.map(r => r.id)).toEqual(["c1", "c2"])

    const agg = llmUsageAggregates(toLedgerRows(rows))
    expect(agg.totalCalls).toBe(2)
    // 未定价模型（haiku 没配价）→ 该模型 costUsd null，全局 cost.complete=false
    expect(agg.modelBreakdown["claude-haiku-4.5"].costUsd).toBeNull()
    expect(agg.totals.cost.complete).toBe(false)
    expect(agg.totals.cost.usd).not.toBeNull()
  })

  it("空会话 → vacuous 三态（tokens 0 / usd null / hit null），不造假 0%", () => {
    const rows = dao.findLlmCallsBySession("nope")
    expect(rows).toEqual([])
    const agg = llmUsageAggregates(toLedgerRows(rows))
    expect(agg.totals).toEqual({ tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null })
  })

  it("配价齐全时 cost.complete=true，命中率 = cacheRead/(input+cacheRead)", () => {
    dao.insertLlmCallBatch([call({ id: "c1", input_tokens: 1000, cache_read_tokens: 3000 })])
    const agg = llmUsageAggregates(toLedgerRows(dao.findLlmCallsBySession("s-1")))
    expect(agg.totals.cacheHitRate).toBeCloseTo(0.75, 10)
    expect(agg.totals.cost.complete).toBe(true)
  })
})

describe("GET /api/sessions/:id/llm-calls", () => {
  function app(): Hono {
    const r = createAnalyticsRoutes(new ExecutionDAO(db), dao, new WorkspaceDAO(db))
    const root = new Hono()
    root.route("/api", r)
    return root
  }

  it("返回 data + LedgerTotals 同形 aggregates", async () => {
    dao.insertLlmCallBatch([call({ id: "c1" })])
    const res = await app().request("/api/sessions/s-1/llm-calls")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((r: { id: string }) => r.id)).toEqual(["c1"])
    expect(body.aggregates.totalCalls).toBe(1)
    expect(body.aggregates.usage).toEqual({
      inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheCreationTokens: 500,
    })
    expect(Object.keys(body.aggregates.modelBreakdown)).toEqual(["claude-sonnet-4.5"])
    // (1000*3 + 200*15 + 500*3.75 + 8000*0.3)/1e6
    expect(body.aggregates.totals.cost.usd).toBeCloseTo((3000 + 3000 + 1875 + 2400) / 1e6, 12)
  })

  it("缺 id → 400", async () => {
    const res = await app().request("/api/sessions//llm-calls")
    expect([400, 404]).toContain(res.status)
  })
})

describe("aggregateLlmCallsBy — 分组账本摘要", () => {
  it("按 execution / session 各自成组，会话段带 execution_id IS NULL 护栏不双计", () => {
    // 作者会话里两行：一行纯聊天，一行带 execution 归属（interaction 类）
    dao.insertLlmCallBatch([
      call({ id: "c1", session_id: "s-1" }),
      call({ id: "c2", session_id: "s-1", execution_id: "e1" }),
    ])

    const byExec = dao.aggregateLlmCallsBy("execution_id", ["e1"])
    expect(byExec.get("e1")!.totalCalls).toBe(1)

    const bySessionAll = dao.aggregateLlmCallsBy("session_id", ["s-1"])
    expect(bySessionAll.get("s-1")!.totalCalls).toBe(2)

    const bySessionGuarded = dao.aggregateLlmCallsBy("session_id", ["s-1"], ["l.execution_id IS NULL"])
    expect(bySessionGuarded.get("s-1")!.totalCalls).toBe(1)
  })

  it("空键集 → 空 map（不发查询）", () => {
    expect(dao.aggregateLlmCallsBy("session_id", []).size).toBe(0)
  })
})

describe("Task.ai_usage — 草稿进统计 + 两段合并", () => {
  it("草稿只有作者会话段", () => {
    seedSession(db, "s-1")
    seedTask(db, "t-draft", "draft", "s-1")
    dao.insertLlmCallBatch([call({ id: "c1", session_id: "s-1" })])

    const service = new TasksService(db, new SSEService())
    const item = service.listTasks().items.find(t => t.id === "t-draft")!
    expect(item.ai_usage?.totalCalls).toBe(1)
    expect(item.ai_usage!.totals.tokens).toBe(9700)
    expect(item.ai_usage!.totals.cost.complete).toBe(true)
    expect(service.getTask("t-draft").ai_usage?.totalCalls).toBe(1)
  })

  it("跑过的任务 = 会话段 + execution 段相加，带归属的行不重复计", () => {
    seedSession(db, "s-1")
    seedTask(db, "t-run", "awaiting_review", "s-1")
    seedExec(db, "e1", "t-run")
    dao.insertLlmCallBatch([
      call({ id: "c1", session_id: "s-1" }),                                  // 作者段
      call({ id: "c2", session_id: "s-1", execution_id: "e1" }),              // 执行段
      call({ id: "c3", session_id: "s-1", execution_id: "e1", input_tokens: 2000 }),
    ])

    const service = new TasksService(db, new SSEService())
    const item = service.listTasks().items.find(t => t.id === "t-run")!
    expect(item.ai_usage?.totalCalls).toBe(3)
    expect(item.ai_usage!.usage.inputTokens).toBe(1000 + 1000 + 2000)
    // 从未跑过、也没有会话行的任务不带该字段
    seedTask(db, "t-idle", "ready", null)
    expect(service.listTasks().items.find(t => t.id === "t-idle")!.ai_usage).toBeUndefined()
  })

  it("作者会话存在但一行账本都没落（空草稿）→ 不带 ai_usage，读模型不炸", () => {
    seedSession(db, "s-1")
    seedSession(db, "s-gone")
    seedTask(db, "t-orphan", "draft", "s-gone")
    dao.insertLlmCallBatch([call({ id: "c1", session_id: "s-1" })])
    const service = new TasksService(db, new SSEService())
    expect(service.listTasks().items.find(t => t.id === "t-orphan")!.ai_usage).toBeUndefined()
  })
})
