import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ExecutionArchiveRow, WorkspaceArchiveRow } from "../types"

export class ArchiveDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── execution_archive ──────────────────────────────────────────

  insertArchive(row: Omit<ExecutionArchiveRow, "id" | "created_at"> & { created_at?: string }): number {
    const now = new Date().toISOString()
    const result = this.stmt(`
      INSERT INTO execution_archive (
        execution_id, workflow_ref, workflow_name, status,
        started_at, completed_at, duration_ms,
        total_input_tokens, total_output_tokens, total_cost_usd,
        node_summary, failed_nodes, error_message, model_breakdown,
        vars_snapshot, lessons_learned,
        workspace_id, workspace_archive_id, parent_execution_id, chain_position,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.execution_id, row.workflow_ref, row.workflow_name, row.status,
      row.started_at ?? null, row.completed_at ?? null, row.duration_ms ?? null,
      row.total_input_tokens, row.total_output_tokens, row.total_cost_usd,
      row.node_summary, row.failed_nodes ?? null, row.error_message ?? null, row.model_breakdown ?? null,
      row.vars_snapshot, row.lessons_learned ?? null,
      row.workspace_id ?? null, row.workspace_archive_id ?? null, row.parent_execution_id ?? null, row.chain_position ?? null,
      row.created_at ?? now,
    )
    return Number(result.lastInsertRowid)
  }

  getArchive(executionId: string): ExecutionArchiveRow | null {
    return (this.stmt("SELECT * FROM execution_archive WHERE execution_id = ?").get(executionId) as ExecutionArchiveRow) ?? null
  }

  getArchiveByPk(id: number): ExecutionArchiveRow | null {
    return (this.stmt("SELECT * FROM execution_archive WHERE id = ?").get(id) as ExecutionArchiveRow) ?? null
  }

  listArchives(filters: {
    workflow_ref?: string
    status?: string
    workspace_id?: string
    date_from?: string
    date_to?: string
  }, page: number, pageSize: number): { items: ExecutionArchiveRow[]; total: number; page: number; pageSize: number } {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters.workflow_ref) {
      conditions.push("workflow_ref = ?")
      params.push(filters.workflow_ref)
    }
    if (filters.status) {
      conditions.push("status = ?")
      params.push(filters.status)
    }
    if (filters.workspace_id) {
      conditions.push("workspace_id = ?")
      params.push(filters.workspace_id)
    }
    if (filters.date_from) {
      conditions.push("created_at >= ?")
      params.push(filters.date_from)
    }
    if (filters.date_to) {
      conditions.push("created_at <= ?")
      params.push(filters.date_to)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const countSql = `SELECT COUNT(*) as cnt FROM execution_archive ${where}`
    const dataSql = `SELECT * FROM execution_archive ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`

    const result = this.paginate<ExecutionArchiveRow>(dataSql, countSql, params, page, pageSize)
    return { items: result.data, total: result.total, page: result.page, pageSize: result.pageSize }
  }

  getStats(): {
    total_executions: number
    total_cost_usd: number
    success_rate: number
    today_cost_usd: number
    week_cost_usd: number
    month_cost_usd: number
  } {
    const totals = this.stmt(`
      SELECT
        COUNT(*) as total_executions,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        CASE WHEN COUNT(*) > 0
          THEN CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
          ELSE 0
        END as success_rate
      FROM execution_archive
    `).get() as { total_executions: number; total_cost_usd: number; success_rate: number }

    const today = this.stmt(`
      SELECT COALESCE(SUM(total_cost_usd), 0) as total
      FROM execution_archive
      WHERE created_at >= date('now', 'start of day')
    `).get() as { total: number }

    const week = this.stmt(`
      SELECT COALESCE(SUM(total_cost_usd), 0) as total
      FROM execution_archive
      WHERE created_at >= date('now', '-6 days')
    `).get() as { total: number }

    const month = this.stmt(`
      SELECT COALESCE(SUM(total_cost_usd), 0) as total
      FROM execution_archive
      WHERE created_at >= date('now', '-29 days')
    `).get() as { total: number }

    return {
      total_executions: totals.total_executions,
      total_cost_usd: totals.total_cost_usd,
      success_rate: totals.success_rate,
      today_cost_usd: today.total,
      week_cost_usd: week.total,
      month_cost_usd: month.total,
    }
  }

  getTopWorkflows(limit: number = 5): Array<{
    workflow_ref: string
    workflow_name: string
    execution_count: number
    success_rate: number
    total_cost_usd: number
  }> {
    return this.stmt(`
      SELECT
        workflow_ref,
        workflow_name,
        COUNT(*) as execution_count,
        CASE WHEN COUNT(*) > 0
          THEN CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
          ELSE 0
        END as success_rate,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd
      FROM execution_archive
      GROUP BY workflow_ref, workflow_name
      ORDER BY execution_count DESC
      LIMIT ?
    `).all(limit) as Array<{
      workflow_ref: string
      workflow_name: string
      execution_count: number
      success_rate: number
      total_cost_usd: number
    }>
  }

  getCostTrends(days: number): Array<{
    date: string
    total_cost_usd: number
    execution_count: number
  }> {
    return this.stmt(`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COUNT(*) as execution_count
      FROM execution_archive
      WHERE created_at >= date('now', '-' || (? - 1) || ' days')
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all(days) as Array<{
      date: string
      total_cost_usd: number
      execution_count: number
    }>
  }

  getWorkflowStats(days: number, sort: string = "execution_count", order: string = "desc", limit: number = 10): Array<{
    workflow_ref: string
    workflow_name: string
    execution_count: number
    success_count: number
    failure_count: number
    success_rate: number
    total_cost_usd: number
    avg_cost_usd: number
    avg_duration_ms: number
  }> {
    // Validate sort field to prevent SQL injection
    const allowedSortFields = new Set(["execution_count", "success_rate", "total_cost_usd", "avg_cost_usd", "avg_duration_ms"])
    const sortField = allowedSortFields.has(sort) ? sort : "execution_count"
    // Validate order
    const orderDir = order.toLowerCase() === "asc" ? "ASC" : "DESC"

    return this.stmt(`
      SELECT
        workflow_ref,
        workflow_name,
        COUNT(*) as execution_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failure_count,
        CASE WHEN COUNT(*) > 0
          THEN CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
          ELSE 0
        END as success_rate,
        COALESCE(SUM(total_cost_usd), 0) as total_cost_usd,
        COALESCE(AVG(total_cost_usd), 0) as avg_cost_usd,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms
      FROM execution_archive
      WHERE created_at >= date('now', '-' || (? - 1) || ' days')
      GROUP BY workflow_ref, workflow_name
      ORDER BY ${sortField} ${orderDir}
      LIMIT ?
    `).all(days, limit) as Array<{
      workflow_ref: string
      workflow_name: string
      execution_count: number
      success_count: number
      failure_count: number
      success_rate: number
      total_cost_usd: number
      avg_cost_usd: number
      avg_duration_ms: number
    }>
  }

  getLeaderboard(dimension: "cost" | "speed" | "success_rate", days: number, limit: number): Array<{
    rank: number
    workflow_ref: string
    workflow_name: string
    value: number
    execution_count: number
  }> {
    const dateFilter = "created_at >= date('now', '-' || (? - 1) || ' days')"
    let sql: string

    switch (dimension) {
      case "cost":
        sql = `
          SELECT
            workflow_ref,
            workflow_name,
            COALESCE(SUM(total_cost_usd), 0) as value,
            COUNT(*) as execution_count
          FROM execution_archive
          WHERE ${dateFilter}
          GROUP BY workflow_ref, workflow_name
          ORDER BY value DESC
          LIMIT ?
        `
        break
      case "speed":
        sql = `
          SELECT
            workflow_ref,
            workflow_name,
            COALESCE(AVG(duration_ms), 0) as value,
            COUNT(*) as execution_count
          FROM execution_archive
          WHERE ${dateFilter} AND duration_ms IS NOT NULL
          GROUP BY workflow_ref, workflow_name
          ORDER BY value ASC
          LIMIT ?
        `
        break
      case "success_rate":
      default:
        sql = `
          SELECT
            workflow_ref,
            workflow_name,
            CASE WHEN COUNT(*) > 0
              THEN CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
              ELSE 0
            END as value,
            COUNT(*) as execution_count
          FROM execution_archive
          WHERE ${dateFilter}
          GROUP BY workflow_ref, workflow_name
          ORDER BY value DESC
          LIMIT ?
        `
        break
    }

    const rows = this.stmt(sql).all(days, limit) as Array<{
      workflow_ref: string
      workflow_name: string
      value: number
      execution_count: number
    }>

    // Add rank in JS (simple and correct)
    return rows.map((row, i) => ({ rank: i + 1, ...row }))
  }

  updateLessonsLearned(executionId: string, lessons: string): void {
    this.stmt(
      "UPDATE execution_archive SET lessons_learned = ? WHERE execution_id = ?"
    ).run(lessons, executionId)
  }

  getRecentByWorkspace(workspaceId: string, limit: number = 3): ExecutionArchiveRow[] {
    return this.stmt(
      "SELECT * FROM execution_archive WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(workspaceId, limit) as ExecutionArchiveRow[]
  }

  getRecentByOrg(org: string, limit: number = 10): ExecutionArchiveRow[] {
    return this.stmt(`
      SELECT * FROM execution_archive
      WHERE workspace_id IN (SELECT id FROM workspaces WHERE org = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(org, limit) as ExecutionArchiveRow[]
  }

  // ── workspace_archive ──────────────────────────────────────────

  insertWorkspaceArchive(row: Omit<WorkspaceArchiveRow, "id" | "archived_at"> & { archived_at?: string }): number {
    const now = new Date().toISOString()
    const result = this.stmt(`
      INSERT INTO workspace_archive (
        workspace_id, workspace_name, org,
        execution_chains, workflow_manifest,
        total_executions, total_cost_usd,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.workspace_id, row.workspace_name, row.org,
      row.execution_chains, row.workflow_manifest,
      row.total_executions, row.total_cost_usd,
      row.archived_at ?? now,
    )
    return Number(result.lastInsertRowid)
  }

  getWorkspaceArchives(org: string): WorkspaceArchiveRow[] {
    return this.stmt(
      "SELECT * FROM workspace_archive WHERE org = ? ORDER BY archived_at DESC"
    ).all(org) as WorkspaceArchiveRow[]
  }

  getWorkspaceArchive(workspaceId: string): WorkspaceArchiveRow | null {
    return (this.stmt(
      "SELECT * FROM workspace_archive WHERE workspace_id = ? ORDER BY archived_at DESC LIMIT 1"
    ).get(workspaceId) as WorkspaceArchiveRow) ?? null
  }

  // ── Cleanup queries (for workspace cascade delete) ─────────────

  deleteByWorkspace(workspaceId: string): void {
    this.stmt("DELETE FROM execution_archive WHERE workspace_id = ?").run(workspaceId)
    this.stmt("DELETE FROM workspace_archive WHERE workspace_id = ?").run(workspaceId)
  }

  // ── Cost trend comparison (for trend direction) ────────────────

  getCostSumInRange(from: string, to: string): number {
    const row = this.stmt(
      "SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM execution_archive WHERE created_at >= ? AND created_at < ?"
    ).get(from, to) as { total: number }
    return row.total
  }
}
