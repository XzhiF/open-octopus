import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type {
  ExecutionArchiveRow, WorkspaceArchiveRow, ArchiveStats,
  CostTrend, WorkflowStat, LeaderboardEntry, PaginatedResult,
} from "../types"

export class ArchiveDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── execution_archive CRUD ──────────────────────────────────────────

  insertExecutionArchive(row: ExecutionArchiveRow): { inserted: boolean } {
    const result = this.stmt(`
      INSERT OR IGNORE INTO execution_archive
        (execution_id, workspace_id, org, workflow_name, total_cost, total_duration_ms,
         node_count, success_rate, token_breakdown, model_breakdown, node_summary,
         chain_info, status, archived_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.execution_id, row.workspace_id, row.org, row.workflow_name,
      row.total_cost, row.total_duration_ms, row.node_count, row.success_rate,
      row.token_breakdown, row.model_breakdown, row.node_summary,
      row.chain_info, row.status, row.archived_at, row.metadata,
    )
    return { inserted: result.changes > 0 }
  }

  findByExecutionId(executionId: string): ExecutionArchiveRow | null {
    return (this.stmt("SELECT * FROM execution_archive WHERE execution_id = ?").get(executionId) as ExecutionArchiveRow) ?? null
  }

  deleteByExecutionId(executionId: string): void {
    this.stmt("DELETE FROM execution_archive WHERE execution_id = ?").run(executionId)
  }

  listByWorkspace(workspaceId: string, page = 1, pageSize = 20): PaginatedResult<ExecutionArchiveRow> {
    return this.paginate<ExecutionArchiveRow>(
      "SELECT * FROM execution_archive WHERE workspace_id = ? ORDER BY archived_at DESC LIMIT ? OFFSET ?",
      "SELECT COUNT(*) as cnt FROM execution_archive WHERE workspace_id = ?",
      [workspaceId],
      page,
      pageSize,
    )
  }

  countByWorkspace(workspaceId: string): number {
    return (this.stmt("SELECT COUNT(*) as cnt FROM execution_archive WHERE workspace_id = ?").get(workspaceId) as { cnt: number }).cnt
  }

  // ── workspace_archive CRUD ──────────────────────────────────────────

  insertWorkspaceArchive(row: WorkspaceArchiveRow): void {
    this.stmt(`
      INSERT OR IGNORE INTO workspace_archive
        (workspace_id, org, name, description, source, execution_count,
         total_cost, total_duration_ms, created_at, archived_at, metadata,
         extracted_experiences, extracted_skills, extracted_workflows, extracted_agents, analysis_report, file_deleted,
         archive_path, archive_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.workspace_id, row.org, row.name, row.description, row.source,
      row.execution_count, row.total_cost, row.total_duration_ms,
      row.created_at, row.archived_at, row.metadata,
      row.extracted_experiences ?? 0, row.extracted_skills ?? 0, row.extracted_workflows ?? 0,
      row.extracted_agents ?? 0,
      row.analysis_report, row.file_deleted ?? 0,
      row.archive_path ?? null, row.archive_mode ?? 'full',
    )
  }

  findByWorkspaceId(workspaceId: string): WorkspaceArchiveRow | null {
    return (this.stmt("SELECT * FROM workspace_archive WHERE workspace_id = ?").get(workspaceId) as WorkspaceArchiveRow) ?? null
  }

  listArchivedWorkspaces(org: string, page = 1, pageSize = 20): PaginatedResult<WorkspaceArchiveRow> {
    return this.paginate<WorkspaceArchiveRow>(
      "SELECT * FROM workspace_archive WHERE org = ? ORDER BY archived_at DESC LIMIT ? OFFSET ?",
      "SELECT COUNT(*) as cnt FROM workspace_archive WHERE org = ?",
      [org],
      page,
      pageSize,
    )
  }

  // ── Dashboard aggregation queries ───────────────────────────────────

  getStats(org?: string, workspaceId?: string): ArchiveStats {
    const conditions: string[] = []
    const params: unknown[] = []
    if (org) { conditions.push("org = ?"); params.push(org) }
    if (workspaceId) { conditions.push("workspace_id = ?"); params.push(workspaceId) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const execStats = this.stmt(`
      SELECT
        COUNT(*) as total_executions,
        COALESCE(SUM(total_cost), 0) as total_cost,
        COALESCE(AVG(total_duration_ms), 0) as avg_duration_ms,
        COALESCE(SUM(total_cost) / NULLIF(COUNT(*), 0), 0) as avg_cost_per_execution,
        COALESCE(AVG(success_rate), 0) as success_rate
      FROM execution_archive ${where}
    `).get(...params) as Omit<ArchiveStats, 'archived_workspaces' | 'archived_workspace_cost'>

    const wsWhere = org ? "WHERE org = ?" : ""
    const wsParams = org ? [org] : []
    const wsStats = this.stmt(`
      SELECT COUNT(*) as archived_workspaces, COALESCE(SUM(total_cost), 0) as archived_workspace_cost
      FROM workspace_archive ${wsWhere}
    `).get(...wsParams) as { archived_workspaces: number; archived_workspace_cost: number }

    return { ...execStats, ...wsStats }
  }

  getCostTrends(org: string, period: '7d' | '30d' | '90d', workflowName?: string): CostTrend[] {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
    const conditions = ["org = ?", `archived_at >= datetime('now', '-${days} days')`]
    const params: unknown[] = [org]
    if (workflowName) { conditions.push("workflow_name = ?"); params.push(workflowName) }
    const where = `WHERE ${conditions.join(" AND ")}`

    return this.stmt(`
      SELECT date(archived_at) as date, COALESCE(SUM(total_cost), 0) as cost, COUNT(*) as execution_count
      FROM execution_archive ${where}
      GROUP BY date(archived_at)
      ORDER BY date ASC
    `).all(...params) as CostTrend[]
  }

  getWorkflowStats(org?: string): WorkflowStat[] {
    const where = org ? "WHERE org = ?" : ""
    const params = org ? [org] : []

    return this.stmt(`
      SELECT
        workflow_name,
        COUNT(*) as execution_count,
        COALESCE(AVG(success_rate), 0) as success_rate,
        COALESCE(AVG(total_duration_ms), 0) as avg_duration_ms,
        COALESCE(AVG(total_cost), 0) as avg_cost
      FROM execution_archive ${where}
      GROUP BY workflow_name
      ORDER BY execution_count DESC
    `).all(...params) as WorkflowStat[]
  }

  getLeaderboard(org: string, metric: 'cost' | 'duration' | 'frequency', limit: number): LeaderboardEntry[] {
    const metricExpr = metric === 'cost' ? 'SUM(total_cost)' : metric === 'duration' ? 'AVG(total_duration_ms)' : 'COUNT(*)'
    return this.stmt(`
      SELECT workflow_name, ${metricExpr} as metric_value, COUNT(*) as execution_count
      FROM execution_archive
      WHERE org = ?
      GROUP BY workflow_name
      ORDER BY metric_value DESC
      LIMIT ?
    `).all(org, limit) as LeaderboardEntry[]
  }

  getWorkspaceArchiveStats(org: string): { total_workspaces: number; total_execution_count: number; total_cost: number } {
    return this.stmt(`
      SELECT COUNT(*) as total_workspaces, COALESCE(SUM(execution_count), 0) as total_execution_count, COALESCE(SUM(total_cost), 0) as total_cost
      FROM workspace_archive WHERE org = ?
    `).get(org) as { total_workspaces: number; total_execution_count: number; total_cost: number }
  }

  // ── Archive V2: Extraction tracking ─────────────────────────────

  updateExtractionStats(workspaceId: string, experiences: number, skills: number, workflows: number = 0, agents: number = 0): void {
    this.stmt(`
      UPDATE workspace_archive
      SET extracted_experiences = ?, extracted_skills = ?, extracted_workflows = ?, extracted_agents = ?
      WHERE workspace_id = ?
    `).run(experiences, skills, workflows, agents, workspaceId)
  }

  setFileDeleted(workspaceId: string, deleted: number): void {
    this.stmt(`
      UPDATE workspace_archive
      SET file_deleted = ?
      WHERE workspace_id = ?
    `).run(deleted, workspaceId)
  }

  setArchivePath(workspaceId: string, archivePath: string): void {
    this.stmt(`
      UPDATE workspace_archive
      SET archive_path = ?
      WHERE workspace_id = ?
    `).run(archivePath, workspaceId)
  }

  getArchivedWorkspaces(
    org?: string,
    filter?: { name?: string }
  ): WorkspaceArchiveRow[] {
    const conditions: string[] = []
    const params: unknown[] = []

    if (org) {
      conditions.push("org = ?")
      params.push(org)
    }

    if (filter?.name) {
      conditions.push("name LIKE ?")
      params.push(`%${filter.name}%`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    return this.stmt(`
      SELECT * FROM workspace_archive
      ${where}
      ORDER BY archived_at DESC
    `).all(...params) as WorkspaceArchiveRow[]
  }
}
