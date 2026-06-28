import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ExecutionArchiveRow, WorkspaceArchiveRow, PaginatedResult } from "../types"

export class ArchiveDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── execution_archive ────────────────────────────────────────────

  insertExecutionArchive(row: Omit<ExecutionArchiveRow, "created_at"> & { created_at?: string }): string {
    const createdAt = row.created_at ?? new Date().toISOString()
    this.stmt(`
      INSERT INTO execution_archive (
        id, org, workflow_ref, workflow_name, status, started_at, completed_at,
        duration_ms, node_summary, failed_nodes, error_message,
        total_input_tokens, total_output_tokens, total_cost_usd, model_breakdown,
        vars_snapshot, lessons_learned, workspace_archive_id, workspace_id,
        chain_position, parent_execution_id, schedule_id, clone_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.workflow_ref, row.workflow_name, row.status,
      row.started_at, row.completed_at, row.duration_ms,
      row.node_summary, row.failed_nodes, row.error_message,
      row.total_input_tokens, row.total_output_tokens, row.total_cost_usd,
      row.model_breakdown, row.vars_snapshot, row.lessons_learned,
      row.workspace_archive_id, row.workspace_id, row.chain_position,
      row.parent_execution_id, row.schedule_id, row.clone_name, createdAt
    )
    return row.id
  }

  findExecutionArchiveById(id: string): ExecutionArchiveRow | null {
    return (this.stmt("SELECT * FROM execution_archive WHERE id = ?").get(id) as ExecutionArchiveRow) ?? null
  }

  listExecutionArchives(opts: {
    org?: string
    page: number
    pageSize: number
    workflow?: string
    status?: string
    from?: string
    to?: string
    sort?: string
    order?: string
  }): PaginatedResult<ExecutionArchiveRow> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (opts.org) { conditions.push("org = ?"); params.push(opts.org) }
    if (opts.workflow) { conditions.push("workflow_ref = ?"); params.push(opts.workflow) }
    if (opts.status) { conditions.push("status = ?"); params.push(opts.status) }
    if (opts.from) { conditions.push("created_at >= ?"); params.push(opts.from) }
    if (opts.to) { conditions.push("created_at <= ?"); params.push(opts.to) }

    const sortColumns: Record<string, string> = {
      created_at: "created_at",
      total_cost_usd: "total_cost_usd",
      duration_ms: "duration_ms",
    }
    const sortCol = sortColumns[opts.sort ?? "created_at"] ?? "created_at"
    const sortOrder = opts.order === "asc" ? "ASC" : "DESC"

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const dataSql = `SELECT * FROM execution_archive ${where} ORDER BY ${sortCol} ${sortOrder} LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as cnt FROM execution_archive ${where}`

    return this.paginate<ExecutionArchiveRow>(dataSql, countSql, params, opts.page, opts.pageSize)
  }

  aggregateByWorkflow(org: string, days: number = 30): Array<{
    workflow_ref: string
    workflow_name: string
    execution_count: number
    success_count: number
    failed_count: number
    total_cost_usd: number
    avg_duration_ms: number
    last_executed_at: string | null
  }> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    return this.stmt(`
      SELECT
        workflow_ref,
        workflow_name,
        COUNT(*) as execution_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        SUM(total_cost_usd) as total_cost_usd,
        AVG(duration_ms) as avg_duration_ms,
        MAX(completed_at) as last_executed_at
      FROM execution_archive
      WHERE org = ? AND created_at >= ?
      GROUP BY workflow_ref
      ORDER BY execution_count DESC
    `).all(org, cutoff) as Array<{
      workflow_ref: string
      workflow_name: string
      execution_count: number
      success_count: number
      failed_count: number
      total_cost_usd: number
      avg_duration_ms: number
      last_executed_at: string | null
    }>
  }

  costTrends(org: string, days: number, workspaceId?: string): Array<{
    date: string
    total_cost_usd: number
    execution_count: number
  }> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    if (workspaceId) {
      return this.stmt(`
        SELECT
          DATE(created_at) as date,
          SUM(total_cost_usd) as total_cost_usd,
          COUNT(*) as execution_count
        FROM execution_archive
        WHERE org = ? AND created_at >= ? AND workspace_id = ?
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `).all(org, cutoff, workspaceId) as Array<{
        date: string
        total_cost_usd: number
        execution_count: number
      }>
    }
    return this.stmt(`
      SELECT
        DATE(created_at) as date,
        SUM(total_cost_usd) as total_cost_usd,
        COUNT(*) as execution_count
      FROM execution_archive
      WHERE org = ? AND created_at >= ?
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `).all(org, cutoff) as Array<{
      date: string
      total_cost_usd: number
      execution_count: number
    }>
  }

  getRollingStats(workflowRef: string, days: number = 30): {
    avg_cost: number
    stddev_cost: number
    avg_duration: number
    stddev_duration: number
    count: number
  } | null {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const row = this.stmt(`
      SELECT
        AVG(total_cost_usd) as avg_cost,
        SQRT(AVG(total_cost_usd * total_cost_usd) - AVG(total_cost_usd) * AVG(total_cost_usd)) as stddev_cost,
        AVG(duration_ms) as avg_duration,
        SQRT(AVG(duration_ms * duration_ms) - AVG(duration_ms) * AVG(duration_ms)) as stddev_duration,
        COUNT(*) as count
      FROM execution_archive
      WHERE workflow_ref = ? AND created_at >= ?
    `).get(workflowRef, cutoff) as {
      avg_cost: number
      stddev_cost: number
      avg_duration: number
      stddev_duration: number
      count: number
    } | undefined
    return row?.count > 0 ? row : null
  }

  deleteByWorkspaceId(workspaceId: string): Database.RunResult {
    return this.stmt("DELETE FROM execution_archive WHERE workspace_id = ?").run(workspaceId)
  }

  deleteAllByOrg(org: string): Database.RunResult {
    return this.stmt("DELETE FROM execution_archive WHERE org = ?").run(org)
  }

  // ── workspace_archive ────────────────────────────────────────────

  insertWorkspaceArchive(row: Omit<WorkspaceArchiveRow, "archived_at"> & { archived_at?: string }): string {
    const archivedAt = row.archived_at ?? new Date().toISOString()
    this.stmt(`
      INSERT INTO workspace_archive (
        id, org, workspace_name, workspace_path, created_at, archived_at,
        execution_count, total_cost_usd, total_duration_ms,
        execution_chains, workflow_manifest, summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.workspace_name, row.workspace_path,
      row.created_at, archivedAt, row.execution_count,
      row.total_cost_usd, row.total_duration_ms,
      row.execution_chains, row.workflow_manifest, row.summary
    )
    return row.id
  }

  findWorkspaceArchiveByWorkspace(wsId: string): WorkspaceArchiveRow | null {
    return (this.stmt("SELECT * FROM workspace_archive WHERE id = ?").get(wsId) as WorkspaceArchiveRow) ?? null
  }
}
