// packages/server/src/__tests__/shadow-compare-removal.test.ts
//
// P4 票05 — shadow-compare 物理删除，S2 契约面（spec 故事27「死账清零」）：
// GET /api/workspaces/:id/executions/:executionId/shadow-compare ⇒ 404（路由消失）。
// 钉法先例 = wiki-draft-routes.test.ts:142（挂载 app 上未注册路径 ⇒ 404）；
// harness 沿用已删的 shadow-compare-route.test.ts（in-memory DB + 真 ExecutionDAO
// + registry stub）。本票删的是端点不是审计链（红线4：主仓证据文书加注已先行完成），
// 故 fixture 保留带 __ 键的历史行——判别力在「路由在不在」，不在「数据在不在」。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { ObservabilityService } from "../services/observability"
import { PrivacyFilter } from "../services/privacy-filter"
import { ExecutionDAO, TokenUsageDAO } from "../db/dao"
import executionRoutes, { setExecutionDependencies } from "../routes/execution"

const WS = "ws-shadow-rmv"
const EXEC = "exec-shadow-rmv"

const stubService = vi.hoisted(() => ({ getById: vi.fn(), getStateJson: vi.fn() }))

vi.mock("../services/execution-service-registry", () => ({
  initExecutionServiceRegistry: () => {},
  getService: (_wsId: string) => ({ service: stubService, wsPath: "/tmp/ws-shadow-rmv" }),
}))

let db: Database.Database
let app: Hono

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  const dao = new ExecutionDAO(db)
  setExecutionDependencies(new SSEService(), new ObservabilityService(db, new PrivacyFilter(), dao), dao, new TokenUsageDAO(db))
  stubService.getById.mockImplementation((id: string) => dao.findById(id) ?? undefined)
  stubService.getStateJson.mockReturnValue(undefined)

  db.prepare(
    `INSERT INTO workspaces (id, name, org, path, source, status, created_at, updated_at)
     VALUES (?, 'ws-shadow-rmv', 'org-shadow-rmv', '/tmp/ws-shadow-rmv', 'task', 'active', datetime('now'), datetime('now'))`,
  ).run(WS)

  // 历史影子行（票 12 时代的注入侧键形态）——删除 PR 零数据迁移，行必须原样在盘。
  const pool = {
    workflow_name: "shadow-wf",
    __relevant_rule_ids: JSON.stringify(["r-a"]),
    __injected_rule_ids: JSON.stringify(["r-a"]),
    wiki_refs: ["r-a"],
  }
  db.prepare(
    `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
       status, input_values, var_pool, org, created_at, updated_at)
     VALUES (?, ?, '0', 0, 'built-in/flow', 'flow', 'completed', '{}', ?, 'org-shadow-rmv', datetime('now'), datetime('now'))`,
  ).run(EXEC, WS, JSON.stringify(pool))

  app = new Hono().route("/api/workspaces/:id/executions", executionRoutes)
})

afterEach(() => { db.close() })

describe("P4 票05 — shadow-compare 端点删除（S2 契约面：路由消失）", () => {
  it("GET /executions/:id/shadow-compare ⇒ 404 — 执行行在、池里 __ 键在，仍须 404（路由物理删除，非数据缺失）", async () => {
    const res = await app.request(`/api/workspaces/${WS}/executions/${EXEC}/shadow-compare`)
    expect(res.status).toBe(404)
  })

  it("同一 router 其余注册路由存活：/state 显式 JSON 404 错误形（证明上方 404 = 路由不存在，非 router 整体失效）", async () => {
    const res = await app.request(`/api/workspaces/${WS}/executions/${EXEC}/state`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: "state not found" })
  })

  it("对已删路径发请求零写入：var_pool 影子键行原样在盘（删端点不删数据面）", async () => {
    const before = db.prepare(`SELECT var_pool FROM executions WHERE id = ?`).get(EXEC) as { var_pool: string }
    await app.request(`/api/workspaces/${WS}/executions/${EXEC}/shadow-compare`)
    const after = db.prepare(`SELECT var_pool FROM executions WHERE id = ?`).get(EXEC) as { var_pool: string }
    expect(after.var_pool).toBe(before.var_pool)
    expect(JSON.parse(after.var_pool)).toHaveProperty("__relevant_rule_ids")
  })
})
