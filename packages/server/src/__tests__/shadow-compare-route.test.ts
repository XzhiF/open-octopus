// packages/server/src/__tests__/shadow-compare-route.test.ts
//
// LLM-WIKI P1 ticket 12 — 影子对照导出的 HTTP 面（story 31）：
// GET /api/workspaces/:id/executions/:executionId/shadow-compare
// 读真实的 executions.var_pool 行（ExecutionDAO → SQLite，即票 10 handoff 的
// 「executions.var_pool 查询面」），返回四象限对照。期望形状为手算字面量，
// 非实现自证。先例：agent-events-intervention.test.ts 的 registry stub。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { ObservabilityService } from "../services/observability"
import { PrivacyFilter } from "../services/privacy-filter"
import { ExecutionDAO, TokenUsageDAO } from "../db/dao"
import executionRoutes, { setExecutionDependencies } from "../routes/execution"

const WS = "ws-shadow-1"
const EXEC = "exec-shadow-1"

const stubService = vi.hoisted(() => ({ getById: vi.fn() }))

vi.mock("../services/execution-service-registry", () => ({
  initExecutionServiceRegistry: () => {},
  getService: (_wsId: string) => ({ service: stubService, wsPath: "/tmp/ws-shadow" }),
}))

let db: Database.Database
let app: Hono

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  const dao = new ExecutionDAO(db)
  setExecutionDependencies(new SSEService(), new ObservabilityService(db, new PrivacyFilter(), dao), dao, new TokenUsageDAO(db))
  // 读面走真 DAO：executions.var_pool 的 SELECT 是被测路径
  stubService.getById.mockImplementation((id: string) => dao.findById(id) ?? undefined)

  db.prepare(
    `INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at)
     VALUES (?, 'ws-shadow', 'org-shadow', '/tmp/ws-shadow', 'task', 'active', datetime('now'), datetime('now'))`,
  ).run(WS)

  // —— fixture：与 pure-function 测试独立的第二组手算样本 ——
  // relevant [r-a,r-b,r-c] injected [r-a,r-b] wiki_refs [r-b, stale:r-c]
  // → hit [r-b] · miss [r-c] · injectOnly [r-a] · queryOnly [r-c]
  const pool = {
    workflow_name: "shadow-wf",
    __relevant_rule_ids: JSON.stringify(["r-a", "r-b", "r-c"]),
    __injected_rule_ids: JSON.stringify(["r-a", "r-b"]),
    wiki_refs: ["r-b", "stale:r-c"],
  }
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
       status, input_values, var_pool, org, created_at, updated_at)
     VALUES (?, ?, '0', 0, 'built-in/flow', 'flow', 'completed', '{}', ?, 'org-shadow', datetime('now'), datetime('now'))`,
  ).run(EXEC, WS, JSON.stringify(pool))

  app = new Hono().route("/api/workspaces/:id/executions", executionRoutes)
})

afterEach(() => { db.close() })

async function shadowCompare(executionId: string) {
  return app.request(`/api/workspaces/${WS}/executions/${executionId}/shadow-compare`)
}

describe("GET /executions/:id/shadow-compare — 影子双轨对照导出（票 12）", () => {
  it("reads executions.var_pool from SQLite and returns the hand-computed four quadrants", async () => {
    const res = await shadowCompare(EXEC)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.executionId).toBe(EXEC)
    expect(body.quadrants).toEqual({
      hit: ["r-b"],
      miss: ["r-c"],
      injectOnly: ["r-a"],
      queryOnly: ["r-c"],
    })
    expect(body.querySide.stale).toEqual(["r-c"])
    expect(body.metrics).toEqual({ injectedCount: 2, queriedCount: 2, hitCount: 1, staleCount: 1 })
  })

  it("stale entries are separately filterable on the query side (票 12 第 2 项)", async () => {
    const body = await (await shadowCompare(EXEC)).json()
    // stale: 前缀原样可追溯（refs 保留原始 token），归一 id 进 queried/stale 两列
    expect(body.querySide.refs).toEqual(["r-b", "stale:r-c"])
    expect(body.querySide.stale).toEqual(["r-c"])
    expect(body.querySide.queried).toContain("r-c")
  })

  it("execution with an empty var_pool returns the stable empty shape (200, not 500)", async () => {
    const EMPTY = "exec-shadow-empty"
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         status, input_values, var_pool, org, created_at, updated_at)
       VALUES (?, ?, '0', 0, 'built-in/flow', 'flow', 'completed', '{}', '{}', 'org-shadow', datetime('now'), datetime('now'))`,
    ).run(EMPTY, WS)

    const res = await shadowCompare(EMPTY)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.quadrants).toEqual({ hit: [], miss: [], injectOnly: [], queryOnly: [] })
  })

  // 知识中心票 08 —— 冻结只读：注入链生产者物理删除后的新执行形态（池里只有
  // wiki_refs，没有任何 __ 键）：injectSide 恒空、对照仍可导（历史行如上方
  // EXEC 带 __ 键继续解析 —— 证据链审计面不失效）。
  it("票08 冻结形态：注入侧字段恒空（relevant/injected=[]），历史对照数据仍可查", async () => {
    const POST08 = "exec-shadow-post08"
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         status, input_values, var_pool, org, created_at, updated_at)
       VALUES (?, ?, '0', 0, 'built-in/flow', 'flow', 'completed', '{}', ?, 'org-shadow', datetime('now'), datetime('now'))`,
    ).run(POST08, WS, JSON.stringify({ workflow_name: "flow", wiki_refs: ["prj-octopus#oct-007", "stale:oct-009"] }))

    const res = await shadowCompare(POST08)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.injectSide).toEqual({ relevant: [], injected: [] })
    expect(body.querySide.queried).toEqual(["prj-octopus#oct-007", "oct-009"])
    expect(body.quadrants).toEqual({ hit: [], miss: [], injectOnly: [], queryOnly: ["prj-octopus#oct-007", "oct-009"] })
    expect(body.metrics).toEqual({ injectedCount: 0, queriedCount: 2, hitCount: 0, staleCount: 1 })

    // 历史行（带 __relevant_rule_ids/__injected_rule_ids 的旧执行快照）不受冻结影响
    const legacy = await (await shadowCompare(EXEC)).json()
    expect(legacy.injectSide.relevant).toEqual(["r-a", "r-b", "r-c"])
    expect(legacy.injectSide.injected).toEqual(["r-a", "r-b"])
  })

  it("unknown execution id → 404", async () => {
    const res = await shadowCompare("exec-ghost")
    expect(res.status).toBe(404)
  })

  it("workspace without shadow rows is unaffected — route never touches the inject side (read-only, 票08 冻结)", async () => {
    const before = db.prepare(`SELECT var_pool FROM executions WHERE id = ?`).get(EXEC) as { var_pool: string }
    await shadowCompare(EXEC)
    const after = db.prepare(`SELECT var_pool FROM executions WHERE id = ?`).get(EXEC) as { var_pool: string }
    expect(after.var_pool).toBe(before.var_pool) // 导出零写入
  })
})
