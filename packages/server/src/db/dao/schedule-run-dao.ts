import { BasePgDAO, type PgSql } from "./base-pg"
import { iso, isoOrNull, jsonStr, num, numOrNull } from "./pg-mappers"
import { TERMINAL_EXECUTION_STATUSES } from "@octopus/shared"
import type { ScheduleExecutionRow, ScheduleAuditLogRow, SchedulerAuditLogRow, PaginatedResult } from "../types"

/**
 * ScheduleRunDAO — execution records and audit logs for schedules.
 * Covers: schedule_executions, schedule_audit_logs, scheduler_audit_logs tables.
 *
 * P1 B5 票1：BaseDAO → BasePgDAO。出口经 pg-mappers 归一回旧 SQLite 行契约
 * （timestamptz→ISO、jsonb→JSON 串、bigint→number）；`datetime('now')` → `now()`。
 */

/** schedule_executions 的 PG 原始行（经 fromSe 归一，契约列类型不动）。 */
interface SePg {
  id: string
  schedule_id: string
  execution_id: string | null
  status: string
  trigger_type: string
  triggered_at: Date | string
  timezone_offset: string
  timezone_iana: string
  duration_ms: string | number | null
  skip_reason: string | null
  missed_reason: string | null
  retry_of: string | null
  error_summary: string | null
  exit_code: number | null
  agent_output: string | null
  model_used: string | null
  token_usage: unknown
  metadata: unknown
  triggered_by: string | null
  workspace_id: string | null
  created_at: Date | string
  completed_at: Date | string | null
}

function fromSe(r: SePg): ScheduleExecutionRow {
  return {
    ...r,
    triggered_at: iso(r.triggered_at),
    created_at: iso(r.created_at),
    completed_at: isoOrNull(r.completed_at),
    duration_ms: numOrNull(r.duration_ms),
    token_usage: jsonStr(r.token_usage) ?? "{}",
    metadata: jsonStr(r.metadata) ?? "{}",
  }
}

/** schedule_audit_logs / scheduler_audit_logs 的 created_at 归一。 */
function auditIso<T extends { created_at: Date | string }>(r: T): T {
  return { ...r, created_at: iso(r.created_at) }
}

export class ScheduleRunDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── schedule_executions ─────────────────────────────────────────

  async findExecutionById(id: string): Promise<ScheduleExecutionRow | null> {
    const row = await this.q1<SePg>("SELECT * FROM schedule_executions WHERE id = ?", [id])
    return row ? fromSe(row) : null
  }

  async listExecutions(scheduleId: string, filters?: {
    status?: string; page?: number; limit?: number
  }): Promise<PaginatedResult<ScheduleExecutionRow>> {
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
    const dataSql = `SELECT * FROM schedule_executions WHERE ${where} ORDER BY triggered_at DESC NULLS LAST LIMIT ? OFFSET ?`
    const r = await this.paginate<SePg>(dataSql, countSql, params, page, limit)
    return { ...r, data: r.data.map(fromSe) }
  }

  async findExecutionByJobAndId(jobId: string, executionId: string): Promise<ScheduleExecutionRow | null> {
    const row = await this.q1<SePg>(
      "SELECT * FROM schedule_executions WHERE id = ? AND schedule_id = ?", [executionId, jobId],
    )
    return row ? fromSe(row) : null
  }

  async insertExecution(row: Partial<ScheduleExecutionRow> & { id: string; schedule_id: string }): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(`
      INSERT INTO schedule_executions (
        id, schedule_id, execution_id, status, trigger_type,
        triggered_at, timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.schedule_id, row.execution_id ?? null,
      row.status ?? "triggered", row.trigger_type ?? "scheduled",
      row.triggered_at ?? now, row.timezone_offset ?? "+00:00",
      row.timezone_iana ?? "UTC", row.created_at ?? now,
      row.triggered_by ?? null,
    ])
  }

  async updateExecution(id: string, fields: Partial<ScheduleExecutionRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0 }
    vals.push(id)
    return this.exec(`UPDATE schedule_executions SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  async markExecutionComplete(id: string, status: "completed" | "failed", durationMs: number, errorSummary?: string): Promise<{ changes: number }> {
    if (status === "completed") {
      return this.exec(
        "UPDATE schedule_executions SET status = 'completed', duration_ms = ?, completed_at = now() WHERE id = ?",
        [durationMs, id],
      )
    }
    return this.exec(
      "UPDATE schedule_executions SET status = 'failed', error_summary = ?, duration_ms = ?, completed_at = now() WHERE id = ?",
      [errorSummary ?? "Execution failed", durationMs, id],
    )
  }

  async countRunningBySchedule(scheduleId: string): Promise<number> {
    const row = await this.q1<{ cnt: string | number }>(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered', 'running')",
      [scheduleId],
    )
    return num(row?.cnt)
  }

  /**
   * Mark any still-active (triggered/running) schedule_executions for a schedule
   * as failed. Used during stale-claimed rollback so the partial unique index
   * `idx_sched_execs_unique_active (schedule_id) WHERE status IN ('triggered','running')`
   * releases — otherwise the next dispatch's insertTriggeredExecution collides
   * with the orphaned row and the task can never be re-dispatched (Issue 3).
   */
  async markStaleExecutionsFailed(scheduleId: string, reason: string): Promise<{ changes: number }> {
    return this.exec(
      `UPDATE schedule_executions
       SET status = 'failed', error_summary = ?, completed_at = now()
       WHERE schedule_id = ? AND status IN ('triggered', 'running')`,
      [reason, scheduleId],
    )
  }

  async countMissedBySchedule(scheduleId: string): Promise<number> {
    const row = await this.q1<{ cnt: string | number }>(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND status = 'missed'",
      [scheduleId],
    )
    return num(row?.cnt)
  }

  // ── schedule_audit_logs ─────────────────────────────────────────

  async listScheduleAuditLogs(workspaceId: string, filters?: {
    scheduleId?: string; page?: number; limit?: number
  }): Promise<PaginatedResult<ScheduleAuditLogRow>> {
    const conditions: string[] = ["workspace_id = ?"]
    const params: unknown[] = [workspaceId]
    if (filters?.scheduleId) { conditions.push("schedule_id = ?"); params.push(filters.scheduleId) }
    const where = conditions.join(" AND ")
    const page = filters?.page ?? 1
    const limit = filters?.limit ?? 20
    const countSql = `SELECT COUNT(*) as cnt FROM schedule_audit_logs WHERE ${where}`
    const dataSql = `SELECT * FROM schedule_audit_logs WHERE ${where} ORDER BY created_at DESC NULLS LAST LIMIT ? OFFSET ?`
    const r = await this.paginate<ScheduleAuditLogRow & { created_at: Date | string; changes: unknown }>(dataSql, countSql, params, page, limit)
    return {
      ...r,
      data: r.data.map(row => ({ ...auditIso(row), changes: jsonStr(row.changes) })) as ScheduleAuditLogRow[],
    }
  }

  async insertScheduleAuditLog(row: Omit<ScheduleAuditLogRow, "actor_name"> & { actor_name?: string }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedule_audit_logs (id, action, actor_id, actor_name, schedule_id, schedule_name, workspace_id, changes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.action, row.actor_id, row.actor_name ?? "system",
      row.schedule_id, row.schedule_name, row.workspace_id,
      row.changes, row.created_at,
    ])
  }

  async deleteScheduleAuditLogsByWorkspace(workspaceId: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM schedule_audit_logs WHERE workspace_id = ?", [workspaceId])
  }

  // ── scheduler_audit_logs ────────────────────────────────────────

  async listSchedulerAuditLogs(scheduleId: string, filters?: {
    action?: string; page?: number; limit?: number
  }): Promise<PaginatedResult<SchedulerAuditLogRow>> {
    const conditions: string[] = ["schedule_id = ?"]
    const params: unknown[] = [scheduleId]
    if (filters?.action) { conditions.push("action = ?"); params.push(filters.action) }
    const where = conditions.join(" AND ")
    const page = filters?.page ?? 1
    const limit = filters?.limit ?? 20
    const countSql = `SELECT COUNT(*) as cnt FROM scheduler_audit_logs WHERE ${where}`
    const dataSql = `SELECT * FROM scheduler_audit_logs WHERE ${where} ORDER BY created_at DESC NULLS LAST LIMIT ? OFFSET ?`
    const r = await this.paginate<SchedulerAuditLogRow & { created_at: Date | string; changes: unknown }>(dataSql, countSql, params, page, limit)
    return {
      ...r,
      data: r.data.map(row => ({ ...auditIso(row), changes: jsonStr(row.changes) })) as SchedulerAuditLogRow[],
    }
  }

  async insertSchedulerAuditLog(row: Omit<SchedulerAuditLogRow, "actor"> & { actor?: string }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO scheduler_audit_logs (id, schedule_id, action, actor, changes, ip_address, workspace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.schedule_id, row.action, row.actor ?? "system",
      row.changes, row.ip_address, row.workspace_id, row.created_at,
    ])
  }

  // ── Additional methods for service migrations ────────────────────

  async findExecutionByIdSimple(id: string): Promise<ScheduleExecutionRow | null> {
    const row = await this.q1<SePg>("SELECT * FROM schedule_executions WHERE id = ?", [id])
    return row ? fromSe(row) : null
  }

  async countRunningByScheduleExcluding(scheduleId: string, excludeId: string): Promise<number> {
    const row = await this.q1<{ cnt: string | number }>(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ? AND id != ? AND status IN ('triggered', 'running')",
      [scheduleId, excludeId],
    )
    return num(row?.cnt)
  }

  /**
   * The ONE concurrency meter the whole fleet shares (ADR-0021 §5.4) — every cap
   * consumer must use this, not the per-table counts below.
   *
   * It deliberately spans two tables, because after v41 "work in flight" lives in two
   * places: a job fire is a `schedule_executions` row, a task launch is an `executions`
   * row carrying `task_id`. Counting only the first would let a burst of task launches
   * walk straight past the cap that cron jobs obediently wait behind (and vice versa).
   *
   * `job_type='job'` fires are EXCLUDED: the built-in housekeeping jobs (task-lifecycle
   * above all) run every minute by design and are not work — counting them would let the
   * janitor permanently occupy one of the 3 real slots.
   *
   * Task rows use the same fail-closed predicate as `ux_exec_task_active` (NOT IN
   * terminal) — but over EVERY task-bound row, roots and composite children alike. This
   * axis is compute slots, and a running subunit holds a workspace and an engine exactly
   * like a root does; the pre-v41 meter counted each child as its own schedule row, so
   * counting only roots would silently raise the real concurrency of a composite task.
   * The other axis, `ux_exec_task_active`, is deliberately ROOTS ONLY: a composite is
   * allowed to run several children of one task at once.
   *
   * EXCEPT that `pending` is subtracted back out, and the two lists are NOT the same
   * axis: an armed-but-not-started row holds the task's IDENTITY slot (the latch must
   * keep counting it, or the same task gets launched twice) while holding no compute at
   * all. Counting it here would make the gate self-blocking — three armed tasks would
   * read as "cap reached" and freeze every other launch behind rows that are, by
   * design, waiting for this exact meter to free up.
   */
  async countActiveWork(opts?: { excludeFireId?: string; excludeTaskExecutionId?: string }): Promise<number> {
    const excludeFire = opts?.excludeFireId
    const jobsRow = await this.q1<{ cnt: string | number }>(
      excludeFire
        ? `SELECT COUNT(DISTINCT se.schedule_id) AS cnt
           FROM schedule_executions se
           JOIN schedules s ON s.id = se.schedule_id
           WHERE se.status IN ('triggered', 'running') AND s.job_type != 'job' AND se.id != ?`
        : `SELECT COUNT(DISTINCT se.schedule_id) AS cnt
           FROM schedule_executions se
           JOIN schedules s ON s.id = se.schedule_id
           WHERE se.status IN ('triggered', 'running') AND s.job_type != 'job'`,
      excludeFire ? [excludeFire] : [],
    )
    const jobs = num(jobsRow?.cnt)

    const excludeTask = opts?.excludeTaskExecutionId
    const tasksRow = await this.q1<{ cnt: string | number }>(
      `SELECT COUNT(*) AS cnt FROM executions
       WHERE task_id IS NOT NULL
         AND status NOT IN (${TERMINAL_EXECUTION_STATUSES.map(() => "?").join(", ")})
         AND status != 'pending'
         ${excludeTask ? "AND id != ?" : ""}`,
      [
        ...TERMINAL_EXECUTION_STATUSES,
        ...(excludeTask ? [excludeTask] : []),
      ],
    )
    const tasks = num(tasksRow?.cnt)

    return jobs + tasks
  }

  /** Terminal bookends for a `job` fire (the ops row: what ran, what it said, how long). */
  async markCodeJobComplete(id: string, handler: string, summary: string, durationMs: number): Promise<{ changes: number }> {
    return this.exec(
      `UPDATE schedule_executions
       SET status = 'completed', agent_output = ?, model_used = ?, exit_code = 0,
           duration_ms = ?, completed_at = now()
       WHERE id = ?`,
      [summary, `job:${handler}`, durationMs, id],
    )
  }

  async markCodeJobFailed(id: string, errorSummary: string, durationMs: number, exitCode: number): Promise<{ changes: number }> {
    return this.exec(
      `UPDATE schedule_executions
       SET status = 'failed', error_summary = ?, exit_code = ?,
           duration_ms = ?, completed_at = now()
       WHERE id = ?`,
      [errorSummary, exitCode, durationMs, id],
    )
  }

  async countDistinctActiveSchedules(excludeId?: string): Promise<number> {
    if (excludeId) {
      const row = await this.q1<{ count: string | number }>(
        `SELECT COUNT(DISTINCT se.schedule_id) as count
         FROM schedule_executions se
         WHERE se.status IN ('triggered', 'running') AND se.id != ?`,
        [excludeId],
      )
      return num(row?.count)
    }
    const row = await this.q1<{ count: string | number }>(
      `SELECT COUNT(DISTINCT se.schedule_id) as count
       FROM schedule_executions se
       WHERE se.status IN ('triggered', 'running')`,
    )
    return num(row?.count)
  }

  async updateExecutionStatus(id: string, status: string): Promise<{ changes: number }> {
    return this.exec("UPDATE schedule_executions SET status = ? WHERE id = ?", [status, id])
  }

  async markExecutionRunning(id: string): Promise<{ changes: number }> {
    return this.exec("UPDATE schedule_executions SET status = 'running' WHERE id = ?", [id])
  }

  async markExecutionFailed(id: string, errorSummary: string, statusFilter?: string[]): Promise<{ changes: number }> {
    if (statusFilter && statusFilter.length > 0) {
      const placeholders = statusFilter.map(() => "?").join(", ")
      return this.exec(
        `UPDATE schedule_executions SET status = 'failed', error_summary = ?, completed_at = now() WHERE id = ? AND status IN (${placeholders})`,
        [errorSummary, id, ...statusFilter],
      )
    }
    return this.exec(
      "UPDATE schedule_executions SET status = 'failed', error_summary = ?, completed_at = now() WHERE id = ?",
      [errorSummary, id],
    )
  }

  async markExecutionCompleteWithDuration(id: string, status: "completed" | "failed", durationMs: number, errorSummary?: string): Promise<{ changes: number }> {
    if (status === "completed") {
      return this.exec(
        "UPDATE schedule_executions SET status = 'completed', duration_ms = ?, completed_at = now() WHERE id = ?",
        [durationMs, id],
      )
    }
    return this.exec(
      "UPDATE schedule_executions SET status = 'failed', error_summary = ?, duration_ms = ?, completed_at = now() WHERE id = ?",
      [errorSummary ?? "Execution failed", durationMs, id],
    )
  }

  async updateExecutionWorkspace(id: string, workspaceId: string): Promise<{ changes: number }> {
    return this.exec("UPDATE schedule_executions SET workspace_id = ? WHERE id = ?", [workspaceId, id])
  }

  async updateExecutionLinkId(id: string, executionId: string): Promise<{ changes: number }> {
    return this.exec("UPDATE schedule_executions SET execution_id = ? WHERE id = ?", [executionId, id])
  }

  async updateExecutionStatusSimple(id: string, status: string, errorSummary?: string): Promise<{ changes: number }> {
    if (errorSummary !== undefined) {
      return this.exec(
        "UPDATE schedule_executions SET status = ?, error_summary = ?, completed_at = now() WHERE id = ?",
        [status, errorSummary, id],
      )
    }
    return this.exec(
      "UPDATE schedule_executions SET status = ?, completed_at = now() WHERE id = ?",
        [status, id],
    )
  }

  async setAgentResult(id: string, agentOutput: string, modelUsed: string, tokenUsage: string, durationMs: number): Promise<{ changes: number }> {
    return this.exec(`
      UPDATE schedule_executions
      SET status = 'completed',
          agent_output = ?,
          model_used = ?,
          token_usage = ?,
          duration_ms = ?,
          completed_at = now(),
          exit_code = 0
      WHERE id = ?
    `, [agentOutput, modelUsed, tokenUsage, durationMs, id])
  }

  async setExecutionResult(id: string, status: string, errorSummary: string, durationMs: number): Promise<{ changes: number }> {
    return this.exec(`
      UPDATE schedule_executions
      SET status = ?,
          error_summary = ?,
          duration_ms = ?,
          completed_at = now()
      WHERE id = ?
    `, [status, errorSummary, durationMs, id])
  }

  async countExecutionsBySchedule(scheduleId: string): Promise<number> {
    const row = await this.q1<{ cnt: string | number }>(
      "SELECT COUNT(*) as cnt FROM schedule_executions WHERE schedule_id = ?", [scheduleId],
    )
    return num(row?.cnt)
  }

  async countExecutionStatsInRange(start: string, end: string): Promise<{ total: number; success: number }> {
    const row = await this.q1<{ total: string | number; success: string | number | null }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('success', 'completed') THEN 1 ELSE 0 END) as success
       FROM schedule_executions
       WHERE triggered_at >= ? AND triggered_at < ?
    `, [start, end])
    return { total: num(row?.total), success: numOrNull(row?.success) ?? 0 }
  }

  // ── Data retention ──────────────────────────────────────────────

  async deleteOldScheduleExecutions(cutoffIso: string): Promise<{ changes: number }> {
    return this.exec(
      "DELETE FROM schedule_executions WHERE created_at < ? AND status NOT IN ('triggered', 'running')",
      [cutoffIso],
    )
  }

  // ── Insert methods for engine/executors ─────────────────────────

  async insertSkippedExecution(id: string, scheduleId: string, triggeredAt: string, timezone: string, skipReason: string): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedule_executions (id, schedule_id, status, trigger_type, triggered_at, timezone_offset, timezone_iana, skip_reason, created_at, triggered_by)
      VALUES (?, ?, 'skipped', 'scheduled', ?, '+00:00', ?, ?, now(), 'scheduler')
    `, [id, scheduleId, triggeredAt, timezone, skipReason])
  }

  async insertMissedExecution(id: string, scheduleId: string, triggeredAt: string, timezone: string): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, missed_reason, created_at, triggered_by
      ) VALUES (?, ?, 'missed', 'scheduled', ?, '+00:00', ?, '服务不可用期间错过', now(), 'scheduler')
    `, [id, scheduleId, triggeredAt, timezone])
  }

  async insertTriggeredExecution(id: string, scheduleId: string, triggerType: string, triggeredAt: string, tzOffset: string, timezone: string, triggeredBy: string): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedule_executions (
        id, schedule_id, status, trigger_type, triggered_at,
        timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, 'triggered', ?, ?, ?, ?, ?, ?)
    `, [id, scheduleId, triggerType, triggeredAt, tzOffset, timezone, triggeredAt, triggeredBy])
  }

  async insertTriggeredExecutionForManual(id: string, scheduleId: string, triggeredAt: string, tzOffset: string, timezone: string): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedule_executions (
        id, schedule_id, execution_id, status, trigger_type,
        triggered_at, timezone_offset, timezone_iana, created_at, triggered_by
      ) VALUES (?, ?, NULL, 'triggered', 'manual', ?, ?, ?, ?, 'user')
    `, [id, scheduleId, triggeredAt, tzOffset, timezone, triggeredAt])
  }

  async findExecutionsBySchedulePaginated(scheduleId: string, limit: number, offset: number): Promise<ScheduleExecutionRow[]> {
    const rows = await this.q<SePg>(
      `SELECT * FROM schedule_executions WHERE schedule_id = ? ORDER BY triggered_at DESC NULLS LAST LIMIT ? OFFSET ?`,
      [scheduleId, limit, offset],
    )
    return rows.map(fromSe)
  }

  async markExecutionTimedOut(id: string, errorSummary: string, jobType: string): Promise<{ changes: number }> {
    if (jobType === 'agent') {
      return this.exec(`
        UPDATE schedule_executions
        SET status = 'timeout', error_summary = ?, completed_at = now()
        WHERE id = ?
      `, [errorSummary, id])
    }
    return this.exec(`
      UPDATE schedule_executions
      SET status = 'failed', error_summary = ?, completed_at = now()
      WHERE id = ?
    `, [errorSummary, id])
  }

  async findExecutionWithJobType(executionId: string): Promise<(ScheduleExecutionRow & { job_type: string }) | null> {
    const row = await this.q1<SePg & { job_type: string }>(
      'SELECT se.*, s.job_type FROM schedule_executions se JOIN schedules s ON se.schedule_id = s.id WHERE se.id = ?',
      [executionId],
    )
    return row ? { ...fromSe(row), job_type: row.job_type } : null
  }

  async findExecutionVarPool(executionId: string): Promise<{ var_pool: string } | null> {
    const row = await this.q1<{ var_pool: unknown }>('SELECT var_pool FROM executions WHERE id = ?', [executionId])
    if (!row) return null
    return { var_pool: jsonStr(row.var_pool) ?? "{}" }
  }

  async getTodayStats(): Promise<{ total: number; failed: number }> {
    const today = new Date().toISOString().slice(0, 10)
    const row = await this.q1<{ total: string | number; failed: string | number | null }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM schedule_executions
      WHERE triggered_at >= ?
    `, [today + 'T00:00:00'])
    return { total: num(row?.total), failed: numOrNull(row?.failed) ?? 0 }
  }
}
