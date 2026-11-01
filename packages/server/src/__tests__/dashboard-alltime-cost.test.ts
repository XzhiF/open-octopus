/**
 * Dashboard all-time cost —— live 与 archived 两侧不重不漏。
 *
 * 完整归档路径（archiveWorkspace）不删源账本行，工作区只是软归档；
 * 所以 live 半边必须排除已进 execution_archive 的执行，否则
 * all_time_cost = live + archived 会把同一批费用算两次。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { ArchiveDAO } from "../db/dao/archive-dao"
import { createDashboardRoutes } from "../routes/dashboard"

let db: Database.Database
let tokenDao: TokenUsageDAO
let archiveDao: ArchiveDAO

/** 1 USD / 1M input tokens → 1_000_000 tokens = $1。 */
function seedPrice(model: string) {
  db.prepare(`
    INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price,
      cache_write_unit_price, cache_read_unit_price, currency, valid_from, valid_to, created_at, updated_at)
    VALUES (?, 'test', ?, 1, 0, 0, 0, 'USD', NULL, NULL, 't', 't')
  `).run(`price-${model}`, model)
}

function seedCall(id: string, executionId: string | null, inputTokens: number) {
  db.prepare(`
    INSERT INTO llm_calls (id, execution_id, turn_index, call_index, model, timestamp, duration_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, 1, 0, 'm-cost', 1_700_000_000_000, 1, ?, 0, 0, 0)
  `).run(id, executionId, inputTokens)
}

function seedArchivedExecution(executionId: string, cost: number) {
  db.prepare(`
    INSERT INTO execution_archive (execution_id, workspace_id, total_cost, status, archived_at)
    VALUES (?, 'ws-arch', ?, 'completed', datetime('now'))
  `).run(executionId, cost)
}

function seedArchivedWorkspace(cost: number) {
  db.prepare(`
    INSERT INTO workspace_archive (workspace_id, name, execution_count, total_cost, total_duration_ms,
      created_at, archived_at, metadata, extracted_experiences, extracted_skills, extracted_workflows,
      extracted_agents, analysis_report, file_deleted)
    VALUES ('ws-arch', 'archived-ws', 1, ?, 0, 't', datetime('now'), NULL, 0, 0, 0, 0, NULL, 0)
  `).run(cost)
}

function app() {
  const a = new Hono()
  a.route("/api/dashboard", createDashboardRoutes(
    { list: () => [] } as never,
    { getLeaderboard: () => ({}) } as never,
    {
      getDashboardStats: () => ({
        total_executions: 0, completed_executions: 0, failed_executions: 0,
        running_executions: 0, pending_executions: 0, avg_duration_ms: 0,
      }),
    } as never,
    tokenDao,
    archiveDao,
  ))
  return a
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tokenDao = new TokenUsageDAO(db)
  archiveDao = new ArchiveDAO(db)
})

afterAll(() => {
  db.close()
})

beforeEach(() => {
  db.prepare("DELETE FROM llm_calls").run()
  db.prepare("DELETE FROM execution_archive").run()
  db.prepare("DELETE FROM workspace_archive").run()
  db.prepare("DELETE FROM billing_price_config").run()
})

describe("dashboard all_time_cost", () => {
  it("excludes archived executions from live cost (no double count)", async () => {
    seedPrice("m-cost")
    seedCall("live", "exec-live", 1_000_000)      // $1 — 未归档
    seedCall("arch", "exec-arch", 2_000_000)      // $2 — 已冻结进归档
    seedCall("chat", null, 3_000_000)             // $3 — 聊天行无执行归属，恒为 live
    seedArchivedExecution("exec-arch", 2)
    seedArchivedWorkspace(2)

    const res = await app().request("/api/dashboard/stats")
    expect(res.status).toBe(200)
    const body = await res.json() as {
      total_cost: { usd: number | null; complete: boolean }
      archived_cost: { usd: number | null; complete: boolean }
      all_time_cost: { usd: number | null; complete: boolean }
    }

    expect(body.total_cost).toEqual({ usd: 4, complete: true })    // $1 + $3
    expect(body.archived_cost).toEqual({ usd: 2, complete: true })
    expect(body.all_time_cost).toEqual({ usd: 6, complete: true }) // 不重不漏
  })

  it("keeps the archived frozen cost when every live row is unpriced", async () => {
    seedCall("live", "exec-live", 1_000_000)
    seedArchivedExecution("exec-arch", 2)
    seedArchivedWorkspace(2)

    const body = await (await app().request("/api/dashboard/stats")).json() as {
      total_cost: { usd: number | null }
      all_time_cost: { usd: number | null }
    }
    expect(body.total_cost.usd).toBeNull()
    expect(body.all_time_cost.usd).toBe(2) // 归档侧有冻结值，live 侧无价
  })
})
