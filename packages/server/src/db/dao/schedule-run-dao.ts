import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ScheduleExecutionRow, ScheduleAuditLogRow, SchedulerAuditLogRow, PaginatedResult } from "../types"

/**
 * ScheduleRunDAO — execution records and audit logs for schedules.
 * Covers: schedule_executions, schedule_audit_logs, scheduler_audit_logs tables.
 */
export class ScheduleRunDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── schedule_executions ─────────────────────────────────────────

  findExecutionById(id: string): ScheduleExecutionRow | null {
    return (this.stmt("SELECT * FROM schedule_executions WHERE id = ?").get(id) as ScheduleExecutionRow) ?? null
  }

  listExecutions(scheduleId: string, filters?: {
    status?: string; page?: number; limit?: number
  }): PaginatedResult<ScheduleExecutionRow> {
    const conditions: string[] = ["schedule_id = ?"]
    const params: unknown[] = [scheduleId]
    if (filters?.status) {
      const dbStatus = filters.status === "success" ? "completed" : filters.status === "failure" ? "failed" : filters.status
      conditions.push("status = ?")
      params.push(dbStatus)
    }
    const where = conditions.join(" AND ")
    const page = filters?.page ?? 1
    const limit = filters?.limit ?? 20
    const countSql = `SELECT COUNT(*) as cnt FROM schedule_executions WHERE ${where}`
    const dataSql = `SELECT * FROM schedule_executions WHERE ${where} ORDER BY triggered_at DESC LIMIT ? OFFSET ?`
    return this.paginate<ScheduleExecutionRow>(dataSql, countSql, params, page, limit)
  }

  findExecutionByJobAndId(jobId: string, executionId: string): ScheduleExecutionRow | null {
    return (this.stmt(
      "SELECT * FROM schedule_executions WHERE id = ? AND schedule_id = ?"
    ).get(executionId, jobId) as ScheduleExecutionRow) ?? null
  }

  insertExecution(row: Partial<ScheduleExecutionRow> & { id: string; schedule_id: string }): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(`
      INSERT INTO schedule_executions (
        id, schedule_id, execution_id, status, trigger_type,
        triggered_at, timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.schedule_id, row.execution_id ?? null,
      row.status ?? "triggered", row.trigger_type ?? "scheduled",
      row.triggered_at ?? now, row.timezone_offset ?? "+00:00",
      row.timezone_iana ?? "UTC", row.created_at ?? now,
      row.triggered_by ?? null,
    )
  }

  updateExecution(id: string, fields: Partial<ScheduleExecutionRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    vals.push(id)
    return this.stmt(`UPDATE schedule_executions SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  markExecutionComplete(id: string, status: "completed" | "failed", durationMs: number, errorSummary?: string): Database.RunResult {
    if (status === "completed") {
      return this.stmt(
        "UPDATE schedule_executions SET status = 'completed', duration_ms = ?, completed_at = datetime('now') WHERE id = ?"
      ).run(durationMs, id)
    }
    return this.stmt(
      "UPDATE schedule_executions SET status = 'failed', error_summary = ?, duration_ms = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(errorSummary ?? "Execution failed", durationMs, id)
  }

  countRunningBySchedule(scheduleId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered', 'running')"
    ).get(scheduleId) as { cnt: number }).cnt
  }

  countMissedBySchedule(scheduleId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND status = 'missed'"
    ).get(scheduleId) as { cnt: number }).cnt
  }

  // ── schedule_audit_logs ─────────────────────────────────────────

  listScheduleAuditLogs(workspaceId: string, filters?: {
    scheduleId?: string; page?: number; limit?: number
  }): PaginatedResult<ScheduleAuditLogRow> {
    const conditions: string[] = ["workspace_id = ?"]
    const params: unknown[] = [workspaceId]
    if (filters?.scheduleId) { conditions.push("schedule_id = ?"); params.push(filters.scheduleId) }
    const where = conditions.join(" AND ")
    const page = filters?.page ?? 1
    const limit = filters?.limit ?? 20
    const countSql = `SELECT COUNT(*) as cnt FROM schedule_audit_logs WHERE ${where}`
    const dataSql = `SELECT * FROM schedule_audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    return this.paginate<ScheduleAuditLogRow>(dataSql, countSql, params, page, limit)
  }

  insertScheduleAuditLog(row: Omit<ScheduleAuditLogRow, "actor_name"> & { actor_name?: string }): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedule_audit_logs (id, action, actor_id, actor_name, schedule_id, schedule_name, workspace_id, changes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.action, row.actor_id, row.actor_name ?? "system",
      row.schedule_id, row.schedule_name, row.workspace_id,
      row.changes, row.created_at,
    )
  }

  deleteScheduleAuditLogsByWorkspace(workspaceId: string): Database.RunResult {
    return this.stmt("DELETE FROM schedule_audit_logs WHERE workspace_id = ?").run(workspaceId)
  }

  // ── scheduler_audit_logs ────────────────────────────────────────

  listSchedulerAuditLogs(scheduleId: string, filters?: {
    action?: string; page?: number; limit?: number
  }): PaginatedResult<SchedulerAuditLogRow> {
    const conditions: string[] = ["schedule_id = ?"]
    const params: unknown[] = [scheduleId]
    if (filters?.action) { conditions.push("action = ?"); params.push(filters.action) }
    const where = conditions.join(" AND ")
    const page = filters?.page ?? 1
    const limit = filters?.limit ?? 20
    const countSql = `SELECT COUNT(*) as cnt FROM scheduler_audit_logs WHERE ${where}`
    const dataSql = `SELECT * FROM scheduler_audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    return this.paginate<SchedulerAuditLogRow>(dataSql, countSql, params, page, limit)
  }

  insertSchedulerAuditLog(row: Omit<SchedulerAuditLogRow, "actor"> & { actor?: string }): Database.RunResult {
    return this.stmt(`
      INSERT INTO scheduler_audit_logs (id, schedule_id, action, actor, changes, ip_address, workspace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.schedule_id, row.action, row.actor ?? "system",
      row.changes, row.ip_address, row.workspace_id, row.created_at,
    )
  }

  // ── Additional methods for service migrations ────────────────────

  findExecutionByIdSimple(id: string): ScheduleExecutionRow | null {
    return (this.stmt("SELECT * FROM schedule_executions WHERE id = ?").get(id) as ScheduleExecutionRow) ?? null
  }

  countRunningByScheduleExcluding(scheduleId: string, excludeId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND id != ? AND status IN ('triggered', 'running')"
    ).get(scheduleId, excludeId) as { cnt: number }).cnt
  }

  countDistinctActiveSchedules(excludeId?: string): number {
    if (excludeId) {
      return (this.stmt(
        `SELECT COUNT(DISTINCT se.schedule_id) as count
         FROM schedule_executions se
         WHERE se.status IN ('triggered', 'running') AND se.id != ?`
      ).get(excludeId) as { count: number }).count
    }
    return (this.stmt(
      `SELECT COUNT(DISTINCT se.schedule_id) as count
       FROM schedule_executions se
       WHERE se.status IN ('triggered', 'running')`
    ).get() as { count: number }).count
  }

  updateExecutionStatus(id: string, status: string): Database.RunResult {
    return this.stmt("UPDATE schedule_executions SET status = ? WHERE id = ?").run(status, id)
  }

  markExecutionRunning(id: string): Database.RunResult {
    return this.stmt("UPDATE schedule_executions SET status = 'running' WHERE id = ?").run(id)
  }

  markExecutionFailed(id: string, errorSummary: string, statusFilter?: string[]): Database.RunResult {
    if (statusFilter && statusFilter.length > 0) {
      const placeholders = statusFilter.map(() => "?").join(", ")
      return this.stmt(
        `UPDATE schedule_executions SET status = 'failed', error_summary = ?, completed_at = datetime('now') WHERE id = ? AND status IN (${placeholders})`
      ).run(errorSummary, id, ...statusFilter)
    }
    return this.stmt(
      "UPDATE schedule_executions SET status = 'failed', error_summary = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(errorSummary, id)
  }

  markExecutionCompleteWithDuration(id: string, status: "completed" | "failed", durationMs: number, errorSummary?: string): Database.RunResult {
    if (status === "completed") {
      return this.stmt(
        "UPDATE schedule_executions SET status = 'completed', duration_ms = ?, completed_at = datetime('now') WHERE id = ?"
      ).run(durationMs, id)
    }
    return this.stmt(
      "UPDATE schedule_executions SET status = 'failed', error_summary = ?, duration_ms = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(errorSummary ?? "Execution failed", durationMs, id)
  }

  updateExecutionWorkspace(id: string, workspaceId: string): Database.RunResult {
    return this.stmt("UPDATE schedule_executions SET workspace_id = ? WHERE id = ?").run(workspaceId, id)
  }

  updateExecutionLinkId(id: string, executionId: string): Database.RunResult {
    return this.stmt("UPDATE schedule_executions SET execution_id = ? WHERE id = ?").run(executionId, id)
  }

  updateExecutionStatusSimple(id: string, status: string, errorSummary?: string): Database.RunResult {
    if (errorSummary !== undefined) {
      return this.stmt(
        "UPDATE schedule_executions SET status = ?, error_summary = ?, completed_at = datetime('now') WHERE id = ?"
      ).run(status, errorSummary, id)
    }
    return this.stmt(
      "UPDATE schedule_executions SET status = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(status, id)
  }

  setAgentResult(id: string, agentOutput: string, modelUsed: string, tokenUsage: string, durationMs: number): Database.RunResult {
    return this.stmt(`
      UPDATE schedule_executions
      SET status = 'completed',
          agent_output = ?,
          model_used = ?,
          token_usage = ?,
          duration_ms = ?,
          completed_at = datetime('now'),
          exit_code = 0
      WHERE id = ?
    `).run(agentOutput, modelUsed, tokenUsage, durationMs, id)
  }

  setExecutionResult(id: string, status: string, errorSummary: string, durationMs: number): Database.RunResult {
    return this.stmt(`
      UPDATE schedule_executions
      SET status = ?,
          error_summary = ?,
          duration_ms = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `).run(status, errorSummary, durationMs, id)
  }

  countExecutionsBySchedule(scheduleId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ?"
    ).get(scheduleId) as { cnt: number }).cnt
  }

  countExecutionStatsInRange(start: string, end: string): { total: number; success: number } {
    const row = this.stmt(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('success', 'completed') THEN 1 ELSE 0 END) as success
       FROM schedule_executions
       WHERE triggered_at >= ? AND triggered_at < ?
    `).get(start, end) as { total: number; success: number }
    return { total: row.total, success: row.success ?? 0 }
  }

  // ── Data retention ──────────────────────────────────────────────

  deleteOldScheduleExecutions(cutoffIso: string): Database.RunResult {
    return this.stmt(
      "DELETE FROM schedule_executions WHERE created_at < ? AND status NOT IN ('triggered', 'running')"
    ).run(cutoffIso)
  }

  // ── Insert methods for engine/executors ─────────────────────────

  insertSkippedExecution(id: string, scheduleId: string, triggeredAt: string, timezone: string, skipReason: string): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, skip_reason, created_at, triggered_by)
      VALUES (?, ?, 'skipped', 'scheduled', ?, '+00:00', ?, ?, datetime('now'), 'scheduler')
    `).run(id, scheduleId, triggeredAt, timezone, skipReason)
  }

  insertMissedExecution(id: string, scheduleId: string, triggeredAt: string, timezone: string): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, missed_reason, created_at, triggered_by
      ) VALUES (?, ?, 'missed', 'scheduled', ?, '+00:00', ?, '服务不可用期间错过', datetime('now'), 'scheduler')
    `).run(id, scheduleId, triggeredAt, timezone)
  }

  insertTriggeredExecution(id: string, scheduleId: string, triggerType: string, triggeredAt: string, tzOffset: string, timezone: string, triggeredBy: string): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, 'triggered', ?, ?, ?, ?, ?, ?)
    `).run(id, scheduleId, triggerType, triggeredAt, tzOffset, timezone, triggeredAt, triggeredBy)
  }

  insertTriggeredExecutionForManual(id: string, scheduleId: string, triggeredAt: string, tzOffset: string, timezone: string): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedule_executions (
        id, schedule_id, execution_id, status, trigger_type,
        triggered_at, timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, NULL, 'triggered', 'manual', ?, ?, ?, ?, 'user')
    `).run(id, scheduleId, triggeredAt, tzOffset, timezone, triggeredAt)
  }

  findExecutionsBySchedulePaginated(scheduleId: string, limit: number, offset: number): ScheduleExecutionRow[] {
    return this.stmt(
      `SELECT * FROM schedule_executions WHERE schedule_id = ? ORDER BY triggered_at DESC LIMIT ? OFFSET ?`
    ).all(scheduleId, limit, offset) as ScheduleExecutionRow[]
  }

  markExecutionTimedOut(id: string, errorSummary: string, jobType: string): Database.RunResult {
    if (jobType === 'agent') {
      return this.stmt(`
        UPDATE schedule_executions
        SET status = 'timeout', error_summary = ?, completed_at = datetime('now')
        WHERE id = ?
      `).run(errorSummary, id)
    }
    return this.stmt(`
      UPDATE schedule_executions
      SET status = 'failed', error_summary = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(errorSummary, id)
  }

  findExecutionWithJobType(executionId: string): (ScheduleExecutionRow & { job_type: string }) | null {
    return (this.stmt(
      'SELECT se.*, s.job_type FROM schedule_executions se JOIN schedules s ON se.schedule_id = s.id WHERE se.id = ?'
    ).get(executionId) as (ScheduleExecutionRow & { job_type: string })) ?? null
  }

  findExecutionVarPool(executionId: string): { var_pool: string } | null {
    return (this.stmt('SELECT var_pool FROM executions WHERE id = ?').get(executionId) as { var_pool: string }) ?? null
  }

  getTodayStats(): { total: number; failed: number } {
    const today = new Date().toISOString().slice(0, 10)
    return this.stmt(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM schedule_executions
      WHERE triggered_at >= ?
    `).get(today + 'T00:00:00') as { total: number; failed: number }
  }

  // ── Monitoring queries (P5.7) ──────────────────────────────────

  /** Total count of triggered/running executions across all schedules. */
  countRunningExecutions(): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE status IN ('triggered', 'running')"
    ).get() as { cnt: number }).cnt
  }

  /** Schedule IDs with executions still in triggered/running state before cutoff. */
  findDelayedExecutions(cutoffIso: string): string[] {
    const rows = this.stmt(
      `SELECT DISTINCT schedule_id FROM schedule_executions
       WHERE status IN ('triggered', 'running') AND triggered_at < ?`
    ).all(cutoffIso) as Array<{ schedule_id: string }>
    return rows.map((r) => r.schedule_id)
  }

  /** Per-schedule failure rate since cutoff. */
  failureRateBySchedule(sinceIso: string): Array<{ schedule_id: string; rate: number }> {
    return this.stmt(`
      SELECT schedule_id,
        CASE WHEN COUNT(*) = 0 THEN 0
          ELSE CAST(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
        END as rate
      FROM schedule_executions
      WHERE triggered_at >= ? AND status IN ('completed', 'failed')
      GROUP BY schedule_id
    `).all(sinceIso) as Array<{ schedule_id: string; rate: number }>
  }
}
