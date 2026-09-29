import { LEDGER_SQL } from "@octopus/shared"
import { BasePgDAO, type PgSql } from "./base-pg"
import { bool, flag, iso, isoOrNull, jsonStr, num, numOrNull } from "./pg-mappers"
import type {
  ExecutionArchiveRow, WorkspaceArchiveRow, ArchiveStats,
  CostTrend, WorkflowStat, LeaderboardEntry, PaginatedResult,
} from "../types"

/**
 * ArchiveDAO — P1 B5 票6a：BaseDAO → BasePgDAO（事务簇终批收尾）。
 * 覆盖 execution_archive / workspace_archive 的 CRUD + 看板聚合。
 * 出口经 pg-mappers 归一回旧 SQLite 行契约：
 *   timestamptz→ISO、jsonb→JSON 串、COUNT/bigint→number、boolean 列→0/1；
 *   写入口 file_deleted 等 0/1 参数经 bool() 显式转（postgres.js 会把
 *   JS number 静默存 false 的雷区）。方言面：
 *   INSERT OR IGNORE→ON CONFLICT DO NOTHING、datetime('now','-N days')→
 *   now() - INTERVAL、date()→::date（Date→'YYYY-MM-DD' 串归一在出口做）、
 *   ORDER BY 聚合值补 NULLS LAST 对齐 SQLite 的 NULL 最后语义。
 */

interface ExecArchPg {
  execution_id: string
  workspace_id: string
  org: string
  workflow_name: string | null
  total_cost: number | string | null
  total_duration_ms: string | number
  node_count: number
  success_rate: number
  token_breakdown: unknown
  model_breakdown: unknown
  node_summary: unknown
  chain_info: unknown
  status: string
  archived_at: Date | string
  metadata: unknown
}

function fromExecArch(r: ExecArchPg): ExecutionArchiveRow {
  return {
    ...r,
    total_cost: numOrNull(r.total_cost),
    total_duration_ms: num(r.total_duration_ms),
    token_breakdown: jsonStr(r.token_breakdown),
    model_breakdown: jsonStr(r.model_breakdown),
    node_summary: jsonStr(r.node_summary),
    chain_info: jsonStr(r.chain_info),
    metadata: jsonStr(r.metadata),
    archived_at: iso(r.archived_at),
  }
}

interface WsArchPg {
  workspace_id: string
  org: string
  name: string
  description: string | null
  source: string | null
  execution_count: number
  total_cost: number | string | null
  total_duration_ms: string | number
  created_at: Date | string | null
  archived_at: Date | string
  metadata: string | null
  extracted_experiences: number
  extracted_skills: number
  extracted_workflows: number
  extracted_agents: number
  analysis_report: string | null
  file_deleted: boolean | number
}

function fromWsArch(r: WsArchPg): WorkspaceArchiveRow {
  return {
    ...r,
    total_cost: numOrNull(r.total_cost),
    total_duration_ms: num(r.total_duration_ms),
    created_at: isoOrNull(r.created_at),
    archived_at: iso(r.archived_at),
    file_deleted: flag(r.file_deleted),
  }
}

/** PG date/Date/文本 → 'YYYY-MM-DD'（SQLite date() 契约）。 */
function dateStr(v: Date | string): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return typeof v === "string" && v.length > 10 ? v.slice(0, 10) : v
}

export class ArchiveDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── execution_archive CRUD ──────────────────────────────────────────

  async insertExecutionArchive(row: ExecutionArchiveRow): Promise<{ inserted: boolean }> {
    const result = await this.exec(`
      INSERT INTO execution_archive
        (execution_id, workspace_id, org, workflow_name, total_cost, total_duration_ms,
         node_count, success_rate, token_breakdown, model_breakdown, node_summary,
         chain_info, status, archived_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(execution_id) DO NOTHING
    `, [
      row.execution_id, row.workspace_id, row.org, row.workflow_name,
      row.total_cost, row.total_duration_ms, row.node_count, row.success_rate,
      row.token_breakdown, row.model_breakdown, row.node_summary,
      row.chain_info, row.status, row.archived_at, row.metadata,
    ])
    return { inserted: result.changes > 0 }
  }

  async findByExecutionId(executionId: string): Promise<ExecutionArchiveRow | null> {
    const row = await this.q1<ExecArchPg>("SELECT * FROM execution_archive WHERE execution_id = ?", [executionId])
    return row ? fromExecArch(row) : null
  }

  async deleteByExecutionId(executionId: string): Promise<void> {
    await this.exec("DELETE FROM execution_archive WHERE execution_id = ?", [executionId])
  }

  async listByWorkspace(workspaceId: string, page = 1, pageSize = 20): Promise<PaginatedResult<ExecutionArchiveRow>> {
    const result = await this.paginate<ExecArchPg>(
      "SELECT * FROM execution_archive WHERE workspace_id = ? ORDER BY archived_at DESC LIMIT ? OFFSET ?",
      "SELECT COUNT(*) as cnt FROM execution_archive WHERE workspace_id = ?",
      [workspaceId],
      page,
      pageSize,
    )
    return { ...result, data: result.data.map(fromExecArch) }
  }

  async countByWorkspace(workspaceId: string): Promise<number> {
    const row = await this.q1<{ cnt: string | number }>("SELECT COUNT(*) as cnt FROM execution_archive WHERE workspace_id = ?", [workspaceId])
    return num(row?.cnt)
  }

  /**
   * 票6a · archive-service Phase 3 事务内聚合：workspace 已归档执行的费用和
   * （三态：全无价 → NULL，同 LEDGER_SQL 语义）。必须经 tx 构造的实例调用
   * 才能看到本事务内未提交的 execution_archive 新行。
   */
  async sumCostByWorkspace(workspaceId: string): Promise<number | null> {
    const row = await this.q1<{ total: number | string | null }>(
      `SELECT ${LEDGER_SQL.sumCostOf('total_cost')} as total FROM execution_archive WHERE workspace_id = ?`,
      [workspaceId],
    )
    return numOrNull(row?.total)
  }

  /** 同 sumCostByWorkspace：时长和（COALESCE 焊 0，与旧 SQLite 直读逐字同式）。 */
  async sumDurationByWorkspace(workspaceId: string): Promise<number> {
    const row = await this.q1<{ total: string | number }>(
      "SELECT COALESCE(SUM(total_duration_ms), 0) as total FROM execution_archive WHERE workspace_id = ?",
      [workspaceId],
    )
    return num(row?.total)
  }

  // ── workspace_archive CRUD ──────────────────────────────────────────

  async insertWorkspaceArchive(row: WorkspaceArchiveRow): Promise<void> {
    await this.exec(`
      INSERT INTO workspace_archive
        (workspace_id, org, name, description, source, execution_count,
         total_cost, total_duration_ms, created_at, archived_at, metadata,
         extracted_experiences, extracted_skills, extracted_workflows, extracted_agents, analysis_report, file_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO NOTHING
    `, [
      row.workspace_id, row.org, row.name, row.description, row.source,
      row.execution_count, row.total_cost, row.total_duration_ms,
      row.created_at, row.archived_at, row.metadata,
      row.extracted_experiences ?? 0, row.extracted_skills ?? 0, row.extracted_workflows ?? 0,
      row.extracted_agents ?? 0,
      row.analysis_report, bool(row.file_deleted ?? 0),
    ])
  }

  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceArchiveRow | null> {
    const row = await this.q1<WsArchPg>("SELECT * FROM workspace_archive WHERE workspace_id = ?", [workspaceId])
    return row ? fromWsArch(row) : null
  }

  async listArchivedWorkspaces(org: string, page = 1, pageSize = 20): Promise<PaginatedResult<WorkspaceArchiveRow>> {
    const result = await this.paginate<WsArchPg>(
      "SELECT * FROM workspace_archive WHERE org = ? ORDER BY archived_at DESC LIMIT ? OFFSET ?",
      "SELECT COUNT(*) as cnt FROM workspace_archive WHERE org = ?",
      [org],
      page,
      pageSize,
    )
    return { ...result, data: result.data.map(fromWsArch) }
  }

  // ── Dashboard aggregation queries ───────────────────────────────────

  async getStats(org?: string, workspaceId?: string): Promise<ArchiveStats> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (org) { conditions.push("org = ?"); params.push(org) }
    if (workspaceId) { conditions.push("workspace_id = ?"); params.push(workspaceId) }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const execStats = await this.q1<{
      total_executions: string | number
      total_cost: number | string | null
      avg_duration_ms: number | string | null
      avg_cost_per_execution: number | string | null
      success_rate: number
    }>(`
      SELECT
        COUNT(*) as total_executions,
        ${LEDGER_SQL.sumCostOf('total_cost')} as total_cost,
        COALESCE(AVG(total_duration_ms), 0) as avg_duration_ms,
        ${LEDGER_SQL.sumCostOf('total_cost')} / NULLIF(COUNT(*), 0) as avg_cost_per_execution,
        COALESCE(AVG(success_rate), 0) as success_rate
      FROM execution_archive ${where}
    `, params)

    const wsWhere = org ? "WHERE org = ?" : ""
    const wsParams = org ? [org] : []
    const wsStats = await this.q1<{ archived_workspaces: string | number; archived_workspace_cost: number | string | null }>(`
      SELECT COUNT(*) as archived_workspaces, ${LEDGER_SQL.sumCostOf('total_cost')} as archived_workspace_cost
      FROM workspace_archive ${wsWhere}
    `, wsParams)

    return {
      total_executions: num(execStats?.total_executions),
      total_cost: numOrNull(execStats?.total_cost),
      avg_duration_ms: num(execStats?.avg_duration_ms),
      avg_cost_per_execution: numOrNull(execStats?.avg_cost_per_execution),
      success_rate: execStats?.success_rate ?? 0,
      archived_workspaces: num(wsStats?.archived_workspaces),
      archived_workspace_cost: numOrNull(wsStats?.archived_workspace_cost),
    }
  }

  async getCostTrends(org: string, period: '7d' | '30d' | '90d', workflowName?: string): Promise<CostTrend[]> {
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90
    const conditions = ["org = ?", `archived_at >= now() - INTERVAL '${days} days'`]
    const params: unknown[] = [org]
    if (workflowName) { conditions.push("workflow_name = ?"); params.push(workflowName) }
    const where = `WHERE ${conditions.join(" AND ")}`

    const rows = await this.q<{ date: Date | string; cost: number | string | null; execution_count: string | number }>(`
      SELECT archived_at::date as date, ${LEDGER_SQL.sumCostOf('total_cost')} as cost, COUNT(*) as execution_count
      FROM execution_archive ${where}
      GROUP BY archived_at::date
      ORDER BY date ASC
    `, params)
    return rows.map(r => ({ date: dateStr(r.date), cost: numOrNull(r.cost), execution_count: num(r.execution_count) }))
  }

  async getWorkflowStats(org?: string): Promise<WorkflowStat[]> {
    const where = org ? "WHERE org = ?" : ""
    const params = org ? [org] : []

    const rows = await this.q<{
      workflow_name: string
      execution_count: string | number
      success_rate: number
      avg_duration_ms: number | string
      avg_cost: number | string | null
    }>(`
      SELECT
        workflow_name,
        COUNT(*) as execution_count,
        COALESCE(AVG(success_rate), 0) as success_rate,
        COALESCE(AVG(total_duration_ms), 0) as avg_duration_ms,
        AVG(total_cost) as avg_cost
      FROM execution_archive ${where}
      GROUP BY workflow_name
      ORDER BY execution_count DESC NULLS LAST
    `, params)
    return rows.map(r => ({
      workflow_name: r.workflow_name,
      execution_count: num(r.execution_count),
      success_rate: r.success_rate,
      avg_duration_ms: num(r.avg_duration_ms),
      avg_cost: numOrNull(r.avg_cost),
    }))
  }

  async getLeaderboard(org: string, metric: 'cost' | 'duration' | 'frequency', limit: number): Promise<LeaderboardEntry[]> {
    const metricExpr = metric === 'cost' ? 'SUM(total_cost)' : metric === 'duration' ? 'AVG(total_duration_ms)' : 'COUNT(*)'
    const rows = await this.q<{ workflow_name: string; metric_value: number | string | null; execution_count: string | number }>(`
      SELECT workflow_name, ${metricExpr} as metric_value, COUNT(*) as execution_count
      FROM execution_archive
      WHERE org = ?
      GROUP BY workflow_name
      ORDER BY metric_value DESC NULLS LAST
      LIMIT ?
    `, [org, limit])
    return rows.map(r => ({
      workflow_name: r.workflow_name,
      metric_value: num(r.metric_value),
      execution_count: num(r.execution_count),
    }))
  }

  async getWorkspaceArchiveStats(org: string): Promise<{ total_workspaces: number; total_execution_count: number; total_cost: number | null }> {
    const row = await this.q1<{ total_workspaces: string | number; total_execution_count: string | number; total_cost: number | string | null }>(`
      SELECT COUNT(*) as total_workspaces, COALESCE(SUM(execution_count), 0) as total_execution_count, ${LEDGER_SQL.sumCostOf('total_cost')} as total_cost
      FROM workspace_archive WHERE org = ?
    `, [org])
    return {
      total_workspaces: num(row?.total_workspaces),
      total_execution_count: num(row?.total_execution_count),
      total_cost: numOrNull(row?.total_cost),
    }
  }

  // ── Archive V2: Extraction tracking ─────────────────────────────

  async updateExtractionStats(workspaceId: string, experiences: number, skills: number, workflows: number = 0, agents: number = 0): Promise<void> {
    await this.exec(`
      UPDATE workspace_archive
      SET extracted_experiences = ?, extracted_skills = ?, extracted_workflows = ?, extracted_agents = ?
      WHERE workspace_id = ?
    `, [experiences, skills, workflows, agents, workspaceId])
  }

  /** deleted 形参保持旧 0/1 契约（调用方传 number）；入口 bool() 显式转 PG boolean 列。 */
  async setFileDeleted(workspaceId: string, deleted: number): Promise<void> {
    await this.exec(`
      UPDATE workspace_archive
      SET file_deleted = ?
      WHERE workspace_id = ?
    `, [bool(deleted), workspaceId])
  }

  async getArchivedWorkspaces(
    org?: string,
    filter?: { name?: string }
  ): Promise<WorkspaceArchiveRow[]> {
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
    const rows = await this.q<WsArchPg>(`
      SELECT * FROM workspace_archive
      ${where}
      ORDER BY archived_at DESC
    `, params)
    return rows.map(fromWsArch)
  }
}
