import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { ArchiveDAO } from "../archive-dao"
import { describePg, setupPgSchema, type PgFixture } from "../../pg/__tests__/dao-fixture"
import type { ExecutionArchiveRow, WorkspaceArchiveRow } from "../../types"

function makeExecRow(overrides: Partial<ExecutionArchiveRow> = {}): ExecutionArchiveRow {
  return {
    execution_id: "exec-1",
    workspace_id: "ws-1",
    org: "xzf",
    workflow_name: "test-flow",
    total_cost: 0.05,
    total_duration_ms: 5000,
    node_count: 3,
    success_rate: 1.0,
    token_breakdown: null,
    model_breakdown: null,
    node_summary: null,
    chain_info: null,
    status: "completed",
    archived_at: "2026-07-08T00:00:00.000Z",
    metadata: null,
    ...overrides,
  }
}

function makeWsRow(overrides: Partial<WorkspaceArchiveRow> = {}): WorkspaceArchiveRow {
  return {
    workspace_id: "ws-1",
    org: "xzf",
    name: "test-workspace",
    description: null,
    source: null,
    execution_count: 10,
    total_cost: 1.5,
    total_duration_ms: 60000,
    created_at: "2026-01-01T00:00:00.000Z",
    archived_at: "2026-07-08T00:00:00.000Z",
    metadata: null,
    // [票6a] postgres.js 拒 undefined 绑定（better-sqlite3 旧路径容忍缺字段）——
    // DAO 写侧必传字段在行工厂里显式给 null，保持 SQLite 时代的缺省语义。
    analysis_report: null,
    ...overrides,
  }
}

/**
 * [P1 B5 票6a] ArchiveDAO 已迁 BasePgDAO —— 本文件每用例随机 PG 库（setupPgSchema，
 * 与旧 :memory: 同生命周期）。出口契约由 DAO 经 pg-mappers 归一（timestamptz→ISO、
 * jsonb→JSON 串、COUNT/AVG→number、bool→0/1），断言语义不动。
 * 裁决④：ArchiveDraftDAO 留 SQLite —— 见 archive-draft-dao.test.ts。
 */
describePg("ArchiveDAO (PG)", () => {
  let pg: PgFixture
  let dao: ArchiveDAO

  beforeEach(async () => {
    pg = await setupPgSchema()
    dao = new ArchiveDAO(pg.sql)
  })

  afterEach(async () => {
    await pg.close()
  })

  // ── insertExecutionArchive ────────────────────────────────────────

  it("inserts an execution archive row", async () => {
    await dao.insertExecutionArchive(makeExecRow())
    const row = await dao.findByExecutionId("exec-1")
    expect(row).not.toBeNull()
    expect(row!.execution_id).toBe("exec-1")
    expect(row!.workspace_id).toBe("ws-1")
    expect(row!.total_cost).toBe(0.05)
  })

  it("is idempotent — duplicate insert is ignored (INSERT OR IGNORE)", async () => {
    await dao.insertExecutionArchive(makeExecRow())
    await dao.insertExecutionArchive(makeExecRow({ total_cost: 999 }))
    const row = await dao.findByExecutionId("exec-1")
    expect(row).not.toBeNull()
    expect(row!.total_cost).toBe(0.05) // original value preserved
    expect(await dao.countByWorkspace("ws-1")).toBe(1)
  })

  it("deletes by execution_id", async () => {
    await dao.insertExecutionArchive(makeExecRow())
    await dao.deleteByExecutionId("exec-1")
    expect(await dao.findByExecutionId("exec-1")).toBeNull()
  })

  // ── insertWorkspaceArchive ────────────────────────────────────────

  it("inserts a workspace archive row", async () => {
    await dao.insertWorkspaceArchive(makeWsRow())
    const row = await dao.findByWorkspaceId("ws-1")
    expect(row).not.toBeNull()
    expect(row!.name).toBe("test-workspace")
    expect(row!.execution_count).toBe(10)
  })

  it("is idempotent — duplicate workspace archive is ignored", async () => {
    await dao.insertWorkspaceArchive(makeWsRow())
    await dao.insertWorkspaceArchive(makeWsRow({ execution_count: 999 }))
    const row = await dao.findByWorkspaceId("ws-1")
    expect(row!.execution_count).toBe(10)
  })

  // ── getStats ──────────────────────────────────────────────────────

  it("empty tables: counts are 0, costs are NULL (C3: 未定价/无数据 ≠ 假 $0)", async () => {
    const stats = await dao.getStats()
    expect(stats.total_executions).toBe(0)
    expect(stats.total_cost).toBeNull()
    expect(stats.avg_duration_ms).toBe(0)
    expect(stats.avg_cost_per_execution).toBeNull()
    expect(stats.success_rate).toBe(0)
    expect(stats.archived_workspaces).toBe(0)
    expect(stats.archived_workspace_cost).toBeNull()
  })

  it("aggregates stats correctly with data", async () => {
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e1", total_cost: 0.1, total_duration_ms: 1000, success_rate: 1.0 }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e2", total_cost: 0.3, total_duration_ms: 3000, success_rate: 0.5 }))
    await dao.insertWorkspaceArchive(makeWsRow({ workspace_id: "ws-a", total_cost: 2.0 }))

    const stats = await dao.getStats("xzf")
    expect(stats.total_executions).toBe(2)
    expect(stats.total_cost).toBeCloseTo(0.4)
    expect(stats.avg_duration_ms).toBe(2000)
    expect(stats.avg_cost_per_execution).toBeCloseTo(0.2)
    expect(stats.success_rate).toBe(0.75)
    expect(stats.archived_workspaces).toBe(1)
    expect(stats.archived_workspace_cost).toBe(2.0)
  })

  it("filters stats by workspace_id", async () => {
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e1", workspace_id: "ws-a", total_cost: 0.1 }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e2", workspace_id: "ws-b", total_cost: 0.9 }))

    const stats = await dao.getStats(undefined, "ws-a")
    expect(stats.total_executions).toBe(1)
    expect(stats.total_cost).toBeCloseTo(0.1)
  })

  // ── getCostTrends ─────────────────────────────────────────────────

  it("returns cost trends filtered by period", async () => {
    const now = new Date().toISOString()
    const old = "2020-01-01T00:00:00.000Z" // outside any period

    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e1", archived_at: now, total_cost: 0.5 }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e2", archived_at: old, total_cost: 99 }))

    const trends = await dao.getCostTrends("xzf", "90d")
    expect(trends.length).toBeGreaterThanOrEqual(1)
    // Only the recent row should appear
    const totalCost = trends.reduce((sum, t) => sum + (t.cost ?? 0), 0) // C3: 趋势点可 null（当日未定价）
    expect(totalCost).toBeCloseTo(0.5)
  })

  // ── getLeaderboard ────────────────────────────────────────────────

  it("sorts leaderboard by cost descending", async () => {
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e1", workflow_name: "cheap", total_cost: 0.01 }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e2", workflow_name: "expensive", total_cost: 1.0 }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e3", workflow_name: "mid", total_cost: 0.5 }))

    const board = await dao.getLeaderboard("xzf", "cost", 10)
    expect(board.length).toBe(3)
    expect(board[0].workflow_name).toBe("expensive")
    expect(board[0].metric_value).toBeCloseTo(1.0)
    expect(board[2].workflow_name).toBe("cheap")
  })

  it("sorts leaderboard by frequency descending", async () => {
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e1", workflow_name: "rare" }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e2", workflow_name: "frequent" }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e3", workflow_name: "frequent" }))

    const board = await dao.getLeaderboard("xzf", "frequency", 10)
    expect(board[0].workflow_name).toBe("frequent")
    expect(board[0].metric_value).toBe(2)
  })

  // ── pagination ────────────────────────────────────────────────────

  it("paginates listByWorkspace results", async () => {
    for (let i = 0; i < 5; i++) {
      await dao.insertExecutionArchive(makeExecRow({ execution_id: `e${i}` }))
    }
    const page = await dao.listByWorkspace("ws-1", 1, 2)
    expect(page.data.length).toBe(2)
    expect(page.total).toBe(5)
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(2)
  })

  // ── getWorkflowStats ──────────────────────────────────────────────

  it("returns workflow stats grouped by workflow_name", async () => {
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e1", workflow_name: "a", total_cost: 1.0 }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e2", workflow_name: "a", total_cost: 2.0 }))
    await dao.insertExecutionArchive(makeExecRow({ execution_id: "e3", workflow_name: "b", total_cost: 0.5 }))

    const stats = await dao.getWorkflowStats("xzf")
    expect(stats.length).toBe(2)
    expect(stats[0].workflow_name).toBe("a") // higher count first
    expect(stats[0].execution_count).toBe(2)
    expect(stats[0].avg_cost).toBeCloseTo(1.5)
  })

  // ── getWorkspaceArchiveStats ──────────────────────────────────────

  it("returns workspace archive stats for org", async () => {
    await dao.insertWorkspaceArchive(makeWsRow({ workspace_id: "ws-1", execution_count: 5, total_cost: 1.0 }))
    await dao.insertWorkspaceArchive(makeWsRow({ workspace_id: "ws-2", execution_count: 3, total_cost: 0.5 }))

    const stats = await dao.getWorkspaceArchiveStats("xzf")
    expect(stats.total_workspaces).toBe(2)
    expect(stats.total_execution_count).toBe(8)
    expect(stats.total_cost).toBeCloseTo(1.5)
  })
})
