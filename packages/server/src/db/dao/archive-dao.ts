// packages/server/src/db/dao/archive-dao.ts
// ArchiveDAO — CRUD and analytics for execution_archive and workspace_archive tables.

import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ExecutionArchiveRow, WorkspaceArchiveRow } from "../types-archive"
import type { PaginatedResult } from "../types"

export class ArchiveDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── execution_archive ────────────────────────────────────────────

  insertExecutionArchive(row: ExecutionArchiveRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO execution_archive (
        id, org, workspace_id, workspace_name, workflow_ref, workflow_name,
        status, started_at, completed_at, duration_ms,
        total_input_tokens, total_output_tokens, total_cost_usd,
        node_summary, model_breakdown, failed_nodes, error_message,
        vars_snapshot, lessons_learned, parent_execution_id,
        workspace_archive_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.workspace_id ?? null, row.workspace_name ?? null,
      row.workflow_ref, row.workflow_name,
      row.status, row.started_at ?? null, row.completed_at ?? null,
      row.duration_ms ?? null,
      row.total_input_tokens ?? 0, row.total_output_tokens ?? 0,
      row.total_cost_usd ?? 0,
      row.node_summary ?? "[]", row.model_breakdown ?? null,
      row.failed_nodes ?? null, row.error_message ?? null,
      row.vars_snapshot ?? "{}", row.lessons_learned ?? null,
      row.parent_execution_id ?? null, row.workspace_archive_id ?? null,
      row.created_at ?? new Date().toISOString(),
    )
  }

  findById(id: string): ExecutionArchiveRow | null {
    return (this.stmt("SELECT * FROM execution_archive WHERE id = ?").get(id) as ExecutionArchiveRow) ?? null
  }

  getExecutionDetail(id: string): ExecutionArchiveRow | null {
    return this.findById(id)
  }

  listExecutions(
    filters: { workflow?: string; status?: string; from?: string; to?: string; org?: string },
    page: number,
    pageSize: number,
  ): PaginatedResult<ExecutionArchiveRow> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters.workflow) {
      conditions.push("workflow_name = ?")
      params.push(filters.workflow)
    }
    if (filters.status) {
      const statuses = filters.status.split(",").map(s => s.trim()).filter(Boolean)
      if (statuses.length > 0) {
        conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`)
        params.push(...statuses)
      }
    }
    if (filters.from) {
      conditions.push("created_at >= ?")
      params.push(filters.from)
    }
    if (filters.to) {
      conditions.push("created_at <= ?")
      params.push(filters.to)
    }
    if (filters.org) {
      conditions.push("org = ?")
      params.push(filters.org)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const dataSql = `SELECT * FROM execution_archive ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as cnt FROM execution_archive ${where}`

    return this.paginate<ExecutionArchiveRow>(dataSql, countSql, params, page, pageSize)
  }

  getStats(org?: string): {
    total_executions: number
    completed_executions: number
    failed_executions: number
    success_rate: number
    total_cost_usd: number
    avg_duration_ms: number
  } {
    const where = org ? "WHERE org = ?" : ""
    const params = org ? [org] : []

    const row = this.stmt(`
      SELECT
        COUNT(*) as total_executions,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_executions,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_executions,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1.0 ELSE 0.0 END) / COUNT(*) AS REAL) * 100, 1)
          ELSE 0 END as success_rate,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COALESCE(ROUND(AVG(CASE WHEN status = 'completed' THEN duration_ms END), 0), 0) as avg_duration_ms
      FROM execution_archive ${where}
    `).get(...params) as {
      total_executions: number
      completed_executions: number
      failed_executions: number
      success_rate: number
      total_cost_usd: number
      avg_duration_ms: number
    }

    return {
      total_executions: row.total_executions,
      completed_executions: row.completed_executions,
      failed_executions: row.failed_executions,
      success_rate: row.success_rate,
      total_cost_usd: row.total_cost_usd,
      avg_duration_ms: row.avg_duration_ms,
    }
  }

  getTopWorkflows(org?: string, limit: number = 5): Array<{ workflow_name: string; runs: number; total_cost_usd: number }> {
    const where = org ? "WHERE org = ?" : ""
    const params = org ? [org] : []
    params.push(limit)

    return this.stmt(`
      SELECT workflow_name, COUNT(*) as runs, COALESCE(SUM(total_cost_usd), 0) as total_cost_usd
      FROM execution_archive ${where}
      GROUP BY workflow_name
      ORDER BY runs DESC
      LIMIT ?
    `).all(...params) as Array<{ workflow_name: string; runs: number; total_cost_usd: number }>
  }

  getCostTrends(
    period: "7d" | "30d",
    org?: string,
  ): {
    points: Array<{ date: string; cost_usd: number; execution_count: number }>
    summary: { today_cost_usd: number; week_cost_usd: number; month_cost_usd: number }
  } {
    const days = period === "7d" ? 7 : 30
    const orgFilter = org ? "AND org = ?" : ""
    const params: unknown[] = org ? [org] : []

    const points = this.stmt(`
      SELECT
        date(created_at) as date,
        COALESCE(SUM(total_cost_usd), 0) as cost_usd,
        COUNT(*) as execution_count
      FROM execution_archive
      WHERE created_at >= date('now', '-' || ? || ' days')
        ${orgFilter}
      GROUP BY date(created_at)
      ORDER BY date ASC
    `).all(days, ...params) as Array<{ date: string; cost_usd: number; execution_count: number }>

    const summaryParams: unknown[] = org ? [org] : []
    const summary = this.stmt(`
      SELECT
        COALESCE(SUM(CASE WHEN date(created_at) = date('now') THEN total_cost_usd ELSE 0 END), 0) as today_cost_usd,
        COALESCE(SUM(CASE WHEN created_at >= date('now', '-7 days') THEN total_cost_usd ELSE 0 END), 0) as week_cost_usd,
        COALESCE(SUM(total_cost_usd), 0) as month_cost_usd
      FROM execution_archive
      WHERE created_at >= date('now', '-30 days')
        ${orgFilter}
    `).get(...summaryParams) as { today_cost_usd: number; week_cost_usd: number; month_cost_usd: number }

    return {
      points,
      summary: {
        today_cost_usd: summary.today_cost_usd,
        week_cost_usd: summary.week_cost_usd,
        month_cost_usd: summary.month_cost_usd,
      },
    }
  }

  getWorkflowStats(org?: string, limit: number = 20): Array<{
    workflow_name: string
    workflow_ref: string
    runs: number
    completed_runs: number
    success_rate: number
    total_cost_usd: number
    avg_duration_ms: number
  }> {
    const where = org ? "WHERE org = ?" : ""
    const params = org ? [org] : []
    params.push(limit)

    return this.stmt(`
      SELECT
        workflow_name,
        MAX(workflow_ref) as workflow_ref,
        COUNT(*) as runs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1.0 ELSE 0.0 END) / COUNT(*) AS REAL) * 100, 1)
          ELSE 0 END as success_rate,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COALESCE(ROUND(AVG(CASE WHEN status = 'completed' THEN duration_ms END), 0), 0) as avg_duration_ms
      FROM execution_archive ${where}
      GROUP BY workflow_name
      ORDER BY runs DESC
      LIMIT ?
    `).all(...params) as Array<{
      workflow_name: string
      workflow_ref: string
      runs: number
      completed_runs: number
      success_rate: number
      total_cost_usd: number
      avg_duration_ms: number
    }>
  }

  getLeaderboard(
    dimension: "cheapest" | "fastest" | "most_reliable",
    org?: string,
    limit: number = 5,
  ): Array<Record<string, unknown>> {
    const orgFilter = org ? "AND org = ?" : ""
    const params: unknown[] = org ? [org] : []
    params.push(limit)

    if (dimension === "cheapest") {
      return this.stmt(`
        SELECT id, workflow_name, total_cost_usd, duration_ms, status
        FROM execution_archive
        WHERE 1=1 ${orgFilter}
        ORDER BY total_cost_usd ASC
        LIMIT ?
      `).all(...params) as Array<Record<string, unknown>>
    }

    if (dimension === "fastest") {
      return this.stmt(`
        SELECT id, workflow_name, duration_ms, total_cost_usd, status
        FROM execution_archive
        WHERE status = 'completed' ${orgFilter}
        ORDER BY duration_ms ASC
        LIMIT ?
      `).all(...params) as Array<Record<string, unknown>>
    }

    // most_reliable: group by workflow_name, order by success_rate DESC
    return this.stmt(`
      SELECT
        workflow_name,
        COUNT(*) as runs,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1.0 ELSE 0.0 END) / COUNT(*) AS REAL) * 100, 1)
          ELSE 0 END as success_rate
      FROM execution_archive
      WHERE 1=1 ${orgFilter}
      GROUP BY workflow_name
      ORDER BY success_rate DESC
      LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>
  }

  getChildren(parentId: string): Array<{ id: string; workflow_name: string; status: string }> {
    return this.stmt(`
      SELECT id, workflow_name, status
      FROM execution_archive
      WHERE parent_execution_id = ?
      ORDER BY created_at ASC
    `).all(parentId) as Array<{ id: string; workflow_name: string; status: string }>
  }

  deleteByWorkspace(workspaceId: string): Database.RunResult {
    return this.stmt("DELETE FROM execution_archive WHERE workspace_id = ?").run(workspaceId)
  }

  getRecentByWorkflow(workflowName: string, org: string, limit: number): ExecutionArchiveRow[] {
    return this.stmt(`
      SELECT * FROM execution_archive
      WHERE workflow_name = ? AND org = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(workflowName, org, limit) as ExecutionArchiveRow[]
  }

  deleteOldArchives(cutoffIso: string): Database.RunResult {
    return this.stmt("DELETE FROM execution_archive WHERE created_at < ?").run(cutoffIso)
  }

  clearNodeSummaryOlderThan(cutoffIso: string): Database.RunResult {
    return this.stmt("UPDATE execution_archive SET node_summary = '[]' WHERE created_at < ?").run(cutoffIso)
  }

  // ── workspace_archive ────────────────────────────────────────────

  insertWorkspaceArchive(row: WorkspaceArchiveRow): Database.RunResult {
    return this.stmt(`
      INSERT INTO workspace_archive (
        id, org, workspace_name, execution_count, total_cost_usd,
        execution_chains, workflow_manifest, archived_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.workspace_name,
      row.execution_count ?? 0, row.total_cost_usd ?? 0,
      row.execution_chains ?? "[]", row.workflow_manifest ?? "[]",
      row.archived_at ?? new Date().toISOString(),
      row.created_at ?? new Date().toISOString(),
    )
  }

  listUnarchivedWorkspaces(): Array<{ id: string; path: string; org: string }> {
    return this.stmt(`
      SELECT id, path, org FROM workspaces
      WHERE archive_status = 'archived'
    `).all() as Array<{ id: string; path: string; org: string }>
  }
}
