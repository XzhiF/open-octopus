import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ScheduleRow, ScheduleWorkspaceRow, SchedulerStateRow } from "../types"

/**
 * ScheduleConfigDAO — CRUD for schedule definitions and scheduler state.
 * Covers: schedules, schedule_workspaces, scheduler_state tables.
 */
export class ScheduleConfigDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── schedules ───────────────────────────────────────────────────

  findById(id: string): ScheduleRow | null {
    return (this.stmt("SELECT * FROM schedules WHERE id = ? AND deleted_at IS NULL").get(id) as ScheduleRow) ?? null
  }

  findByIdRaw(id: string): ScheduleRow | null {
    return (this.stmt("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow) ?? null
  }

  listByWorkspace(workspaceId: string, filters?: { search?: string; status?: string }): ScheduleRow[] {
    let sql = "SELECT * FROM schedules WHERE workspace_id = ? AND deleted_at IS NULL AND (job_type = 'workflow' OR job_type IS NULL)"
    const params: unknown[] = [workspaceId]
    if (filters?.search) { sql += " AND INSTR(name, ?) > 0"; params.push(filters.search.slice(0, 200)) }
    if (filters?.status === "enabled") { sql += " AND enabled = 1" }
    else if (filters?.status === "disabled") { sql += " AND enabled = 0" }
    sql += " ORDER BY created_at DESC"
    return this.stmt(sql).all(...params) as ScheduleRow[]
  }

  listGlobal(params?: {
    search?: string; status?: string; job_type?: string; org?: string;
    workspace_id?: string; sort?: string; order?: string;
    page?: number; limit?: number;
  }): { data: ScheduleRow[]; total: number; page: number; pageSize: number } {
    const conditions: string[] = ["s.deleted_at IS NULL"]
    const queryParams: unknown[] = []
    if (params?.search) { conditions.push("INSTR(s.name, ?) > 0"); queryParams.push(params.search.slice(0, 200)) }
    if (params?.status === "enabled") { conditions.push("s.enabled = 1") }
    else if (params?.status === "disabled") { conditions.push("s.enabled = 0") }
    else if (params?.status === "failed") { conditions.push("s.enabled = 1 AND s.consecutive_failures > 0") }
    if (params?.job_type) { conditions.push("s.job_type = ?"); queryParams.push(params.job_type) }
    if (params?.org) { conditions.push("s.org = ?"); queryParams.push(params.org) }
    if (params?.workspace_id) { conditions.push("s.org = (SELECT org FROM workspaces WHERE id = ?)"); queryParams.push(params.workspace_id) }

    const where = conditions.join(" AND ")
    const page = params?.page ?? 1
    const limit = params?.limit ?? 20
    const offset = (page - 1) * limit

    const countSql = `SELECT COUNT(*) as cnt FROM schedules s WHERE ${where}`
    const dataSql = `SELECT s.* FROM schedules s WHERE ${where} ORDER BY s.next_trigger_at LIMIT ? OFFSET ?`

    return this.paginate<ScheduleRow>(dataSql, countSql, queryParams, page, limit)
  }

  checkNameConflict(org: string, name: string, excludeId?: string): boolean {
    if (excludeId) {
      const row = this.stmt(
        "SELECT id FROM schedules WHERE org = ? AND name = ? AND id != ? AND deleted_at IS NULL"
      ).get(org, name, excludeId) as { id: string } | undefined
      return !!row
    }
    const row = this.stmt(
      "SELECT id FROM schedules WHERE org = ? AND name = ? AND deleted_at IS NULL"
    ).get(org, name) as { id: string } | undefined
    return !!row
  }

  insertSchedule(row: Partial<ScheduleRow> & { id: string; org: string; name: string; cron_expression: string; timezone: string }): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone, workspace_id, workflow_ref,
        input_values, enabled, timeout_seconds, notify_on_failure,
        notify_channel, notify_target, container_execution_id,
        next_trigger_at, created_at, updated_at,
        job_type, config, parallel_policy, description, version, consecutive_failures, max_retain
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.name, row.cron_expression, row.timezone,
      row.workspace_id ?? null, row.workflow_ref ?? null,
      row.input_values ?? "{}", row.enabled ?? 1,
      row.timeout_seconds ?? 3600, row.notify_on_failure ?? 0,
      row.notify_channel ?? null, row.notify_target ?? null,
      row.container_execution_id ?? null, row.next_trigger_at ?? null,
      row.created_at ?? now, row.updated_at ?? now,
      row.job_type ?? "workflow", row.config ?? "{}",
      row.parallel_policy ?? "skip", row.description ?? null,
      row.version ?? 1, row.consecutive_failures ?? 0, row.max_retain ?? 10,
    )
  }

  updateSchedule(id: string, fields: Record<string, unknown>): Database.RunResult {
    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id)
    return this.stmt(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  updateScheduleWithVersion(id: string, fields: Record<string, unknown>, expectedVersion: number): Database.RunResult {
    const sets: string[] = ["updated_at = ?", "version = version + 1"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id, expectedVersion)
    return this.stmt(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ? AND version = ?`).run(...vals)
  }

  softDelete(id: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt("UPDATE schedules SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
  }

  findEnabledDue(): ScheduleRow[] {
    return this.stmt(
      "SELECT * FROM schedules WHERE enabled = 1 AND deleted_at IS NULL AND next_trigger_at IS NOT NULL AND next_trigger_at <= datetime('now')"
    ).all() as ScheduleRow[]
  }

  findEnabledSchedules(): ScheduleRow[] {
    return this.stmt(
      "SELECT * FROM schedules WHERE enabled = 1 AND deleted_at IS NULL"
    ).all() as ScheduleRow[]
  }

  findActiveExecutions(scheduleId: string): { id: string }[] {
    return this.stmt(
      "SELECT id FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered', 'running') LIMIT 1"
    ).all(scheduleId) as { id: string }[]
  }

  deleteByWorkspace(workspaceId: string): Database.RunResult {
    return this.stmt("DELETE FROM schedules WHERE workspace_id = ?").run(workspaceId)
  }

  // ── schedule_workspaces ─────────────────────────────────────────

  findScheduleWorkspaces(scheduleId: string, filters?: { status?: string; page?: number; limit?: number }): { data: ScheduleWorkspaceRow[]; total: number; page: number; pageSize: number } {
    const conditions = ["sw.schedule_id = ?"]
    const params: unknown[] = [scheduleId]
    if (filters?.status) { conditions.push("sw.status = ?"); params.push(filters.status) }
    const where = conditions.join(" AND ")
    const page = filters?.page ?? 1
    const limit = filters?.limit ?? 20

    const countSql = `SELECT COUNT(*) as cnt FROM schedule_workspaces sw WHERE ${where}`
    const dataSql = `SELECT sw.*, w.name as workspace_name, w.status as workspace_status
      FROM schedule_workspaces sw LEFT JOIN workspaces w ON sw.workspace_id = w.id
      WHERE ${where} ORDER BY sw.started_at DESC LIMIT ? OFFSET ?`

    return this.paginate<ScheduleWorkspaceRow & { workspace_name?: string; workspace_status?: string }>(dataSql, countSql, params, page, limit) as { data: ScheduleWorkspaceRow[]; total: number; page: number; pageSize: number }
  }

  findScheduleWorkspace(scheduleId: string, workspaceId: string): (ScheduleWorkspaceRow & { workspace_name?: string; workspace_status?: string }) | null {
    return (this.stmt(`
      SELECT sw.*, w.name as workspace_name, w.status as workspace_status
      FROM schedule_workspaces sw LEFT JOIN workspaces w ON sw.workspace_id = w.id
      WHERE sw.schedule_id = ? AND sw.id = ?
    `).get(scheduleId, workspaceId) as (ScheduleWorkspaceRow & { workspace_name?: string; workspace_status?: string })) ?? null
  }

  // ── scheduler_state ─────────────────────────────────────────────

  getSchedulerState(): SchedulerStateRow | null {
    return (this.stmt("SELECT * FROM scheduler_state WHERE id = 1").get() as SchedulerStateRow) ?? null
  }

  updateSchedulerState(fields: Partial<SchedulerStateRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    return this.stmt(`UPDATE scheduler_state SET ${sets.join(", ")} WHERE id = 1`).run(...vals)
  }

  // ── Workspace-scoped queries (for V1 WorkspaceScheduleService) ──

  findWorkspaceOrg(workspaceId: string): string | null {
    const row = this.stmt("SELECT org FROM workspaces WHERE id = ?").get(workspaceId) as { org: string } | undefined
    return row?.org ?? null
  }

  findScheduleByWorkspace(id: string, workspaceId: string): ScheduleRow | null {
    return (this.stmt("SELECT * FROM schedules WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as ScheduleRow) ?? null
  }

  findScheduleByWorkspaceNotDeleted(id: string, workspaceId: string): ScheduleRow | null {
    return (this.stmt("SELECT * FROM schedules WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL").get(id, workspaceId) as ScheduleRow) ?? null
  }

  insertWorkspaceSchedule(row: {
    id: string; org: string; workspace_id: string; name: string; workflow_ref: string;
    cron_expression: string; timezone: string; input_values: string;
    timeout_seconds: number; notify_on_failure: number;
    notify_channel: string | null; notify_target: string | null;
    container_execution_id: string; next_trigger_at: string | null;
    created_at: string; updated_at: string;
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedules (
        id, org, workspace_id, name, workflow_ref, cron_expression, timezone,
        input_values, enabled, timeout_seconds, notify_on_failure,
        notify_channel, notify_target, container_execution_id,
        next_trigger_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.workspace_id, row.name, row.workflow_ref,
      row.cron_expression, row.timezone, row.input_values,
      row.timeout_seconds, row.notify_on_failure,
      row.notify_channel, row.notify_target, row.container_execution_id,
      row.next_trigger_at, row.created_at, row.updated_at,
    )
  }

  updateScheduleByWorkspace(id: string, workspaceId: string, fields: Record<string, unknown>): Database.RunResult {
    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id, workspaceId)
    return this.stmt(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...vals)
  }

  softDeleteByWorkspace(id: string, workspaceId: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt("UPDATE schedules SET deleted_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(now, now, id, workspaceId)
  }

  updateEnabledByWorkspace(id: string, workspaceId: string, enabled: number, nextTrigger: string | null): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE schedules SET enabled = ?, next_trigger_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?"
    ).run(enabled, nextTrigger, now, id, workspaceId)
  }

  updateDismissAlert(id: string, workspaceId: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE schedules SET missed_alert_dismissed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?"
    ).run(now, now, id, workspaceId)
  }

  emergencyStopByWorkspace(workspaceId: string): number {
    const now = new Date().toISOString()
    const result = this.stmt(
      "UPDATE schedules SET enabled = 0, updated_at = ? WHERE workspace_id = ? AND enabled = 1 AND deleted_at IS NULL"
    ).run(now, workspaceId)
    return result.changes ?? 0
  }

  checkNameConflictByWorkspace(workspaceId: string, name: string, excludeId: string): boolean {
    const row = this.stmt(
      "SELECT id FROM schedules WHERE workspace_id = ? AND name = ? AND id != ? AND deleted_at IS NULL"
    ).get(workspaceId, name, excludeId) as { id: string } | undefined
    return !!row
  }

  updateNextTriggerAt(id: string, nextTrigger: string | null): Database.RunResult {
    return this.stmt("UPDATE schedules SET next_trigger_at = ? WHERE id = ?").run(nextTrigger, id)
  }

  incrementConsecutiveFailures(id: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE schedules SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?"
    ).run(now, id)
  }

  getConsecutiveFailuresAndEnabled(id: string): { consecutive_failures: number; enabled: number } | null {
    return (this.stmt("SELECT consecutive_failures, enabled FROM schedules WHERE id = ?")
      .get(id) as { consecutive_failures: number; enabled: number }) ?? null
  }

  autoDisableSchedule(id: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE schedules SET enabled = 0, next_trigger_at = NULL, updated_at = ? WHERE id = ?"
    ).run(now, id)
  }

  resetConsecutiveFailures(id: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt("UPDATE schedules SET consecutive_failures = 0, updated_at = ? WHERE id = ?").run(now, id)
  }

  // ── Schedule workspace queries (for WorkflowExecutor) ───────────

  insertScheduleWorkspace(row: {
    id: string; schedule_id: string; workspace_id: string; status: string;
    branch_suffix: string; started_at: string;
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedule_workspaces (id, schedule_id, workspace_id, status, branch_suffix, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, row.schedule_id, row.workspace_id, row.status, row.branch_suffix, row.started_at)
  }

  updateScheduleWorkspaceStatus(id: string, fields: Record<string, unknown>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    vals.push(id)
    return this.stmt(`UPDATE schedule_workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  findScheduleWorkspaceById(id: string): { workspace_id: string } | null {
    return (this.stmt("SELECT workspace_id FROM schedule_workspaces WHERE id = ?").get(id) as { workspace_id: string }) ?? null
  }

  findRetainedWorkspaces(scheduleId: string, maxRetain: number): Array<{ workspace_id: string }> {
    return this.stmt(`
      SELECT sw.workspace_id
      FROM schedule_workspaces sw
      WHERE sw.schedule_id = ?
        AND sw.status IN ('completed', 'failed')
      ORDER BY sw.started_at DESC
      LIMIT -1 OFFSET ?
    `).all(scheduleId, maxRetain) as Array<{ workspace_id: string }>
  }

  // ── Dashboard queries ───────────────────────────────────────────

  countActiveSchedules(): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM schedules WHERE enabled = 1 AND deleted_at IS NULL"
    ).get() as { cnt: number }).cnt
  }

  countFailedSchedules(): number {
    return (this.stmt(
      "SELECT COUNT(*) as cnt FROM schedules WHERE consecutive_failures > 0 AND enabled = 1 AND deleted_at IS NULL"
    ).get() as { cnt: number }).cnt
  }

  findNextTrigger(): { id: string; name: string; next_trigger_at: string } | null {
    return (this.stmt(`
      SELECT id, name, next_trigger_at FROM schedules
      WHERE enabled = 1 AND deleted_at IS NULL AND next_trigger_at IS NOT NULL
      ORDER BY next_trigger_at ASC LIMIT 1
    `).get() as { id: string; name: string; next_trigger_at: string }) ?? null
  }

  // ── Scheduler engine queries ────────────────────────────────────

  updateSchedulerHeartbeat(): Database.RunResult {
    return this.stmt("UPDATE scheduler_state SET last_heartbeat = datetime('now') WHERE id = 1").run()
  }

  setMissedAlertPending(): Database.RunResult {
    return this.stmt("UPDATE scheduler_state SET missed_alert_pending = 1 WHERE id = 1").run()
  }

  findEnabledSchedulesForMissed(): ScheduleRow[] {
    return this.stmt(
      "SELECT * FROM schedules WHERE enabled = 1 AND deleted_at IS NULL"
    ).all() as ScheduleRow[]
  }

  findLastNonMissedExecution(scheduleId: string): { triggered_at: string } | null {
    return (this.stmt(`
      SELECT triggered_at FROM schedule_executions
      WHERE schedule_id = ? AND status != 'missed'
      ORDER BY triggered_at DESC LIMIT 1
    `).get(scheduleId) as { triggered_at: string }) ?? null
  }

  findExecutionNearTime(scheduleId: string, triggeredAt: string): unknown | undefined {
    return this.stmt(`
      SELECT 1 FROM schedule_executions
      WHERE schedule_id = ?
        AND ABS(CAST((julianday(triggered_at) - julianday(?)) * 86400 AS INTEGER)) < 60
    `).get(scheduleId, triggeredAt)
  }

  findRunningExecutionsWithScheduleInfo(): Array<{
    id: string; schedule_id: string; status: string; triggered_at: string;
    execution_id: string | null; timeout_seconds: number; notify_on_failure: number;
    schedule_name: string; notify_channel: string | null; notify_target: string | null;
    job_type: string; workspace_id: string | null;
  }> {
    return this.stmt(`
      SELECT se.*, s.timeout_seconds, s.notify_on_failure, s.name as schedule_name,
             s.notify_channel, s.notify_target, s.job_type
      FROM schedule_executions se
      JOIN schedules s ON se.schedule_id = s.id
      WHERE se.status = 'running'
    `).all() as Array<{
      id: string; schedule_id: string; status: string; triggered_at: string;
      execution_id: string | null; timeout_seconds: number; notify_on_failure: number;
      schedule_name: string; notify_channel: string | null; notify_target: string | null;
      job_type: string; workspace_id: string | null;
    }>
  }

  // ── Export queries ──────────────────────────────────────────────

  findAllSchedulesWithWorkspaceInfo(): Array<{
    name: string; workspace_name: string; job_type: string; cron_expression: string;
    enabled: number; consecutive_failures: number;
    last_execution_at: string | null; last_execution_status: string | null;
  }> {
    return this.stmt(`
      SELECT
        s.name,
        COALESCE(w.name, '') as workspace_name,
        s.job_type,
        s.cron_expression,
        s.enabled,
        s.consecutive_failures,
        (SELECT se.triggered_at FROM schedule_executions se WHERE se.schedule_id = s.id ORDER BY se.triggered_at DESC LIMIT 1) as last_execution_at,
        (SELECT se.status FROM schedule_executions se WHERE se.schedule_id = s.id ORDER BY se.triggered_at DESC LIMIT 1) as last_execution_status
      FROM schedules s
      LEFT JOIN workspaces w ON s.workspace_id = w.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.name ASC
    `).all() as Array<{
      name: string; workspace_name: string; job_type: string; cron_expression: string;
      enabled: number; consecutive_failures: number;
      last_execution_at: string | null; last_execution_status: string | null;
    }>
  }

  // ── Scheduler-service queries (global job list with last-exec subqueries) ──

  listJobsQuery(params: {
    conditions: string[]; queryParams: unknown[];
    orderClause: string; limit: number; offset: number;
  }): { rows: ScheduleRow[]; total: number } {
    const whereClause = params.conditions.join(' AND ')
    const countSql = `SELECT COUNT(*) as cnt FROM schedules s WHERE ${whereClause}`
    const total = (this.stmt(countSql).get(...params.queryParams) as { cnt: number }).cnt

    const querySql = `
      SELECT s.*,
        (SELECT status FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_status,
        (SELECT triggered_at FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_triggered_at,
        (SELECT error_summary FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_error_summary
      FROM schedules s
      WHERE ${whereClause}
      ORDER BY ${params.orderClause}
      LIMIT ? OFFSET ?
    `
    const rows = this.stmt(querySql).all(...params.queryParams, params.limit, params.offset) as (ScheduleRow & {
      last_exec_status?: string | null; last_exec_triggered_at?: string | null; last_exec_error_summary?: string | null
    })[]
    return { rows, total }
  }

  getJobWithLastExec(id: string): (ScheduleRow & {
    last_exec_status?: string | null; last_exec_triggered_at?: string | null; last_exec_error_summary?: string | null
  }) | null {
    return (this.stmt(`
      SELECT s.*,
        (SELECT status FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_status,
        (SELECT triggered_at FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_triggered_at,
        (SELECT error_summary FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_error_summary
      FROM schedules s
      WHERE s.id = ? AND s.deleted_at IS NULL
    `).get(id) as (ScheduleRow & {
      last_exec_status?: string | null; last_exec_triggered_at?: string | null; last_exec_error_summary?: string | null
    })) ?? null
  }

  // ── Agent route queries ────────────────────────────────────────────

  insertAgentSchedule(id: string, org: string, name: string, cronExpression: string, jobType: string, config: string, now: string): Database.RunResult {
    return this.stmt(`
      INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(id, org, name, cronExpression, 'Asia/Shanghai', jobType, config, now, now)
  }

  listSchedulesByOrg(org: string): Array<{ id: string; name: string; cron_expression: string; enabled: number }> {
    try {
      return this.stmt(
        'SELECT id, name, cron_expression, enabled FROM schedules WHERE org = ? AND deleted_at IS NULL ORDER BY created_at DESC'
      ).all(org) as Array<{ id: string; name: string; cron_expression: string; enabled: number }>
    } catch {
      return []
    }
  }

  findScheduleConfigByIdAndOrg(id: string, org: string): { name: string; config: string } | null {
    try {
      return (this.stmt('SELECT name, config FROM schedules WHERE id = ? AND org = ?').get(id, org) as { name: string; config: string }) ?? null
    } catch {
      return null
    }
  }

  updateScheduleWorkspacesCleaned(workspaceId: string, completedAt: string): Database.RunResult {
    try {
      return this.stmt("UPDATE schedule_workspaces SET status = 'cleaned', completed_at = ? WHERE workspace_id = ?")
        .run(completedAt, workspaceId)
    } catch {
      return { changes: 0, lastInsertRowid: 0 }
    }
  }

  /**
   * Count active agent schedules for an org.
   * TC-048: Per-agent limit — max 20 active schedules.
   */
  countAgentSchedulesByOrg(org: string): number {
    try {
      const row = this.stmt(`
        SELECT COUNT(*) as count FROM schedules
        WHERE org = ? AND job_type = 'agent' AND enabled = 1 AND deleted_at IS NULL
      `).get(org) as { count: number } | undefined
      return row?.count ?? 0
    } catch {
      return 0
    }
  }
}
