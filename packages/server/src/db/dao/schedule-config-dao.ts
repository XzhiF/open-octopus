import { BasePgDAO, type PgSql } from "./base-pg"
import { iso, isoOrNull, jsonStr, num, flag, bool } from "./pg-mappers"
import type { ScheduleRow, ScheduleWorkspaceRow, SchedulerStateRow } from "../types"

/** A `schedules` row plus its most recent fire, as the job list/get read model needs it.
 *  The four `last_exec_*` fields are correlated subqueries over `schedule_executions` —
 *  named once here so the list query and the single-get query cannot drift apart. */
export type ScheduleRowWithLastExec = ScheduleRow & {
  last_exec_status?: string | null
  last_exec_triggered_at?: string | null
  last_exec_error_summary?: string | null
  last_exec_duration_ms?: number | null
}

/**
 * ScheduleConfigDAO — CRUD for schedule definitions and scheduler state.
 * Covers: schedules, schedule_workspaces, scheduler_state tables.
 *
 * P1 B5 票1：BaseDAO → BasePgDAO。布尔列（enabled/notify_on_failure/
 * missed_alert_pending）写侧经 bool() 显式转换（postgres.js number→boolean
 * 静默存 false 雷区）、读侧经 flag() 归一回 0/1；jsonb（input_values/config）
 * 出口归一 JSON 串；`enabled = 1` 谓词 → `= true`；datetime('now')→now()；
 * INSTR→strpos；json_extract→#>>；julianday→EXTRACT(EPOCH)；LIMIT -1→OFFSET。
 */

/** schedules 的 PG 原始行（经 fromSchedule 归一回 ScheduleRow 旧契约）。 */
interface ScPg {
  id: string
  org: string
  name: string
  cron_expression: string | null
  timezone: string
  workspace_id: string | null
  workflow_ref: string | null
  input_values: unknown
  enabled: boolean | number
  timeout_seconds: number
  notify_on_failure: boolean | number
  notify_channel: string | null
  notify_target: string | null
  container_execution_id: string | null
  missed_alert_dismissed_at: Date | string | null
  deleted_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  next_trigger_at: Date | string | null
  job_type: string
  config: unknown
  parallel_policy: string
  description: string | null
  version: number
  consecutive_failures: number
  max_retain: number
  status: string
  claimed_at: Date | string | null
}

function fromSchedule(r: ScPg): ScheduleRow {
  return {
    ...r,
    input_values: jsonStr(r.input_values) ?? "{}",
    config: jsonStr(r.config) ?? "{}",
    enabled: flag(r.enabled),
    notify_on_failure: flag(r.notify_on_failure),
    missed_alert_dismissed_at: isoOrNull(r.missed_alert_dismissed_at),
    deleted_at: isoOrNull(r.deleted_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    next_trigger_at: isoOrNull(r.next_trigger_at),
    claimed_at: isoOrNull(r.claimed_at),
  }
}

/** 动态 SET 里需要 0/1→boolean 显式转换的列（postgres.js number→bool 静默 false 雷区）。 */
const SCHEDULE_BOOL_COLS = new Set(["enabled", "notify_on_failure"])

function normScheduleField(k: string, v: unknown): unknown {
  return SCHEDULE_BOOL_COLS.has(k) && typeof v === "number" ? bool(v) : v
}

export class ScheduleConfigDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── schedules ───────────────────────────────────────────────────

  async findById(id: string): Promise<ScheduleRow | null> {
    const row = await this.q1<ScPg>("SELECT * FROM schedules WHERE id = ? AND deleted_at IS NULL", [id])
    return row ? fromSchedule(row) : null
  }

  async findByIdRaw(id: string): Promise<ScheduleRow | null> {
    const row = await this.q1<ScPg>("SELECT * FROM schedules WHERE id = ?", [id])
    return row ? fromSchedule(row) : null
  }


  /**
   * Ticket 10 (JobDetail composite view): find ALL child schedules dispatched by a
   * task_dispatch node whose persisted `parent_task_dispatch` marker points at the
   * given parent composition-wf execution. Mirrors findFailedChildSchedules but
   * returns children of every status (draft/queued/claimed/running/done/failed/aborted)
   * so GET /jobs/:id can render the composite kanban's children[] regardless of state.
   */
  async findChildSchedules(parentExecutionId: string): Promise<ScheduleRow[]> {
    const rows = await this.q<ScPg>(
      `SELECT * FROM schedules
       WHERE deleted_at IS NULL
         AND config #>> '{parent_task_dispatch,execution_id}' = ?
       ORDER BY created_at ASC`,
      [parentExecutionId],
    )
    return rows.map(fromSchedule)
  }


  async findByName(name: string): Promise<ScheduleRow | null> {
    const row = await this.q1<ScPg>("SELECT * FROM schedules WHERE name = ? AND deleted_at IS NULL", [name])
    return row ? fromSchedule(row) : null
  }

  async listByWorkspace(workspaceId: string, filters?: { search?: string; status?: string }): Promise<ScheduleRow[]> {
    let sql = "SELECT * FROM schedules WHERE workspace_id = ? AND deleted_at IS NULL AND (job_type = 'workflow' OR job_type IS NULL)"
    const params: unknown[] = [workspaceId]
    if (filters?.search) { sql += " AND strpos(name, ?) > 0"; params.push(filters.search.slice(0, 200)) }
    if (filters?.status === "enabled") { sql += " AND enabled = true" }
    else if (filters?.status === "disabled") { sql += " AND enabled = false" }
    sql += " ORDER BY created_at DESC"
    const rows = await this.q<ScPg>(sql, params)
    return rows.map(fromSchedule)
  }

  async listGlobal(params?: {
    search?: string; status?: string; job_type?: string; org?: string;
    workspace_id?: string; sort?: string; order?: string;
    page?: number; limit?: number;
  }): Promise<{ data: ScheduleRow[]; total: number; page: number; pageSize: number }> {
    const conditions: string[] = ["s.deleted_at IS NULL"]
    const queryParams: unknown[] = []
    if (params?.search) { conditions.push("strpos(s.name, ?) > 0"); queryParams.push(params.search.slice(0, 200)) }
    if (params?.status === "enabled") { conditions.push("s.enabled = true") }
    else if (params?.status === "disabled") { conditions.push("s.enabled = false") }
    else if (params?.status === "failed") { conditions.push("s.enabled = true AND s.consecutive_failures > 0") }
    if (params?.job_type) { conditions.push("s.job_type = ?"); queryParams.push(params.job_type) }
    if (params?.org) { conditions.push("s.org = ?"); queryParams.push(params.org) }
    if (params?.workspace_id) { conditions.push("s.org = (SELECT org FROM workspaces WHERE id = ?)"); queryParams.push(params.workspace_id) }

    const where = conditions.join(" AND ")
    const page = params?.page ?? 1
    const limit = params?.limit ?? 20

    const countSql = `SELECT COUNT(*) as cnt FROM schedules s WHERE ${where}`
    // NULLS FIRST 对齐 SQLite ASC 的 NULL 前置语义（next_trigger_at 可空）
    const dataSql = `SELECT s.* FROM schedules s WHERE ${where} ORDER BY s.next_trigger_at NULLS FIRST LIMIT ? OFFSET ?`

    const r = await this.paginate<ScPg>(dataSql, countSql, queryParams, page, limit)
    return { ...r, data: r.data.map(fromSchedule) }
  }

  async checkNameConflict(org: string, name: string, excludeId?: string): Promise<boolean> {
    if (excludeId) {
      const row = await this.q1<{ id: string }>(
        "SELECT id FROM schedules WHERE org = ? AND name = ? AND id != ? AND deleted_at IS NULL",
        [org, name, excludeId],
      )
      return !!row
    }
    const row = await this.q1<{ id: string }>(
      "SELECT id FROM schedules WHERE org = ? AND name = ? AND deleted_at IS NULL",
      [org, name],
    )
    return !!row
  }

  async insertSchedule(row: Partial<ScheduleRow> & {
    id: string; org: string; name: string;
    cron_expression: string | null; timezone: string;
  }): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    // v42 (ADR-0021 票03): origin_type / origin_id / origin_role / assoc_meta and
    // scheduled_at are dropped from the INSERT along with the columns. Callers that used
    // to bind a schedule to a task through them (readyTask's envelope, task-dispatch
    // children) no longer create schedule rows at all, so there is nothing to pass.
    return this.exec(`
      INSERT INTO schedules (
        id, org, name, cron_expression, timezone, workspace_id, workflow_ref,
        input_values, enabled, timeout_seconds, notify_on_failure,
        notify_channel, notify_target, container_execution_id,
        next_trigger_at, created_at, updated_at,
        job_type, config, parallel_policy, description, version, consecutive_failures, max_retain,
        status, claimed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.org, row.name, row.cron_expression, row.timezone,
      row.workspace_id ?? null, row.workflow_ref ?? null,
      row.input_values ?? "{}", bool(row.enabled ?? 1),
      row.timeout_seconds ?? 3600, bool(row.notify_on_failure ?? 0),
      row.notify_channel ?? null, row.notify_target ?? null,
      row.container_execution_id ?? null, row.next_trigger_at ?? null,
      row.created_at ?? now, row.updated_at ?? now,
      row.job_type ?? "workflow", row.config ?? "{}",
      row.parallel_policy ?? "skip", row.description ?? null,
      row.version ?? 1, row.consecutive_failures ?? 0, row.max_retain ?? 10,
      row.status ?? "queued",
      row.claimed_at ?? null,
    ])
  }

  async updateSchedule(id: string, fields: Record<string, unknown>): Promise<{ changes: number }> {
    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(normScheduleField(k, v))
    }
    vals.push(id)
    return this.exec(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  async updateScheduleWithVersion(id: string, fields: Record<string, unknown>, expectedVersion: number): Promise<{ changes: number }> {
    const sets: string[] = ["updated_at = ?", "version = version + 1"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(normScheduleField(k, v))
    }
    vals.push(id, expectedVersion)
    return this.exec(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ? AND version = ?`, vals)
  }

  /** Clear a soft delete. Used by the built-in job seed: a row the operator deleted
   *  stays deleted, but a built-in whose row got soft-deleted (by API, by hand, by an
   *  older build that lacked the guard) must come back at next boot — see the WHY in
   *  seedBuiltinCodeJobs. */
  async undelete(id: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec("UPDATE schedules SET deleted_at = NULL, updated_at = ? WHERE id = ?", [now, id])
  }

  async softDelete(id: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec("UPDATE schedules SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id])
  }

  async findEnabledDue(): Promise<ScheduleRow[]> {
    const rows = await this.q<ScPg>(
      "SELECT * FROM schedules WHERE enabled = true AND deleted_at IS NULL AND next_trigger_at IS NOT NULL AND next_trigger_at <= now()"
    )
    return rows.map(fromSchedule)
  }

  async findEnabledSchedules(): Promise<ScheduleRow[]> {
    const rows = await this.q<ScPg>(
      "SELECT * FROM schedules WHERE enabled = true AND deleted_at IS NULL"
    )
    return rows.map(fromSchedule)
  }




  // T-5 AC11: stale claimed/running — claimed_at older than cutoff ISO string.
  // Includes 'running' so a task that crashed mid-execution (status advanced past
  // 'claimed' but the process died) also rolls back to queued for re-dispatch.
  async findStaleClaimed(cutoffIso: string): Promise<ScheduleRow[]> {
    const rows = await this.q<ScPg>(
      "SELECT * FROM schedules WHERE status IN ('claimed', 'running') AND claimed_at IS NOT NULL AND claimed_at < ? AND deleted_at IS NULL",
      [cutoffIso],
    )
    return rows.map(fromSchedule)
  }

  async findActiveExecutions(scheduleId: string): Promise<{ id: string }[]> {
    return this.q<{ id: string }>(
      "SELECT id FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered', 'running') LIMIT 1",
      [scheduleId],
    )
  }

  /** Execution + workspace links of the schedule's ACTIVE runs. Callers that
   *  are about to flip schedule_executions rows out of ('triggered','running')
   *  (abort/cleanup) MUST capture with this BEFORE the mutation — a later
   *  findActiveExecutions would return nothing and the engine cancel would be
   *  silently skipped (2026-09-08 task-abort regression; mirrors the capture
   *  discipline documented in SchedulerService.abortJob). */
  async findActiveExecutionLinks(scheduleId: string): Promise<{ execution_id: string; workspace_id: string }[]> {
    return this.q<{ execution_id: string; workspace_id: string }>(
      "SELECT execution_id, workspace_id FROM schedule_executions WHERE schedule_id = ? AND status IN ('triggered', 'running') AND execution_id IS NOT NULL AND workspace_id IS NOT NULL",
      [scheduleId],
    )
  }

  async deleteByWorkspace(workspaceId: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM schedules WHERE workspace_id = ?", [workspaceId])
  }

  // ── schedule_workspaces ─────────────────────────────────────────

  async findScheduleWorkspaces(scheduleId: string, filters?: { status?: string; page?: number; limit?: number }): Promise<{ data: ScheduleWorkspaceRow[]; total: number; page: number; pageSize: number }> {
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

    const r = await this.paginate<SwPg & { workspace_name?: string; workspace_status?: string }>(dataSql, countSql, params, page, limit)
    return { ...r, data: r.data.map(fromSw) } as { data: ScheduleWorkspaceRow[]; total: number; page: number; pageSize: number }
  }

  async findScheduleWorkspace(scheduleId: string, workspaceId: string): Promise<(ScheduleWorkspaceRow & { workspace_name?: string; workspace_status?: string }) | null> {
    const row = await this.q1<SwPg & { workspace_name?: string; workspace_status?: string }>(`
      SELECT sw.*, w.name as workspace_name, w.status as workspace_status
      FROM schedule_workspaces sw LEFT JOIN workspaces w ON sw.workspace_id = w.id
      WHERE sw.schedule_id = ? AND sw.id = ?
    `, [scheduleId, workspaceId])
    return row ? fromSw(row) : null
  }

  // ── scheduler_state ─────────────────────────────────────────────

  async getSchedulerState(): Promise<SchedulerStateRow | null> {
    const row = await this.q1<SchedulerStateRow & { last_heartbeat: Date | string | null; missed_alert_pending: boolean | number }>(
      "SELECT * FROM scheduler_state WHERE id = 1",
    )
    if (!row) return null
    return { ...row, last_heartbeat: isoOrNull(row.last_heartbeat), missed_alert_pending: flag(row.missed_alert_pending) }
  }

  async updateSchedulerState(fields: Partial<SchedulerStateRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(k === "missed_alert_pending" && typeof v === "number" ? bool(v) : v)
    }
    if (sets.length === 0) return { changes: 0 }
    return this.exec(`UPDATE scheduler_state SET ${sets.join(", ")} WHERE id = 1`, vals)
  }

  // ── Workspace-scoped queries (for V1 WorkspaceScheduleService) ──

  async findWorkspaceOrg(workspaceId: string): Promise<string | null> {
    const row = await this.q1<{ org: string }>("SELECT org FROM workspaces WHERE id = ?", [workspaceId])
    return row?.org ?? null
  }

  async findScheduleByWorkspace(id: string, workspaceId: string): Promise<ScheduleRow | null> {
    const row = await this.q1<ScPg>("SELECT * FROM schedules WHERE id = ? AND workspace_id = ?", [id, workspaceId])
    return row ? fromSchedule(row) : null
  }

  async findScheduleByWorkspaceNotDeleted(id: string, workspaceId: string): Promise<ScheduleRow | null> {
    const row = await this.q1<ScPg>("SELECT * FROM schedules WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL", [id, workspaceId])
    return row ? fromSchedule(row) : null
  }

  async insertWorkspaceSchedule(row: {
    id: string; org: string; workspace_id: string; name: string; workflow_ref: string;
    cron_expression: string; timezone: string; input_values: string;
    timeout_seconds: number; notify_on_failure: number;
    notify_channel: string | null; notify_target: string | null;
    container_execution_id: string; next_trigger_at: string | null;
    created_at: string; updated_at: string;
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedules (
        id, org, workspace_id, name, workflow_ref, cron_expression, timezone,
        input_values, enabled, timeout_seconds, notify_on_failure,
        notify_channel, notify_target, container_execution_id,
        next_trigger_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, true, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.org, row.workspace_id, row.name, row.workflow_ref,
      row.cron_expression, row.timezone, row.input_values,
      row.timeout_seconds, bool(row.notify_on_failure),
      row.notify_channel, row.notify_target, row.container_execution_id,
      row.next_trigger_at, row.created_at, row.updated_at,
    ])
  }

  async updateScheduleByWorkspace(id: string, workspaceId: string, fields: Record<string, unknown>): Promise<{ changes: number }> {
    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(normScheduleField(k, v))
    }
    vals.push(id, workspaceId)
    return this.exec(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`, vals)
  }

  async softDeleteByWorkspace(id: string, workspaceId: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec("UPDATE schedules SET deleted_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?", [now, now, id, workspaceId])
  }

  async updateEnabledByWorkspace(id: string, workspaceId: string, enabled: number, nextTrigger: string | null): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE schedules SET enabled = ?, next_trigger_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      [bool(enabled), nextTrigger, now, id, workspaceId],
    )
  }

  async updateDismissAlert(id: string, workspaceId: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE schedules SET missed_alert_dismissed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      [now, now, id, workspaceId],
    )
  }

  async emergencyStopByWorkspace(workspaceId: string): Promise<number> {
    const now = new Date().toISOString()
    const result = await this.exec(
      "UPDATE schedules SET enabled = false, updated_at = ? WHERE workspace_id = ? AND enabled = true AND deleted_at IS NULL",
      [now, workspaceId],
    )
    return result.changes
  }

  async checkNameConflictByWorkspace(workspaceId: string, name: string, excludeId: string): Promise<boolean> {
    const row = await this.q1<{ id: string }>(
      "SELECT id FROM schedules WHERE workspace_id = ? AND name = ? AND id != ? AND deleted_at IS NULL",
      [workspaceId, name, excludeId],
    )
    return !!row
  }

  async updateNextTriggerAt(id: string, nextTrigger: string | null): Promise<{ changes: number }> {
    return this.exec("UPDATE schedules SET next_trigger_at = ? WHERE id = ?", [nextTrigger, id])
  }

  async incrementConsecutiveFailures(id: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE schedules SET consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?",
      [now, id],
    )
  }

  async getConsecutiveFailuresAndEnabled(id: string): Promise<{ consecutive_failures: number; enabled: number } | null> {
    const row = await this.q1<{ consecutive_failures: number; enabled: boolean | number }>(
      "SELECT consecutive_failures, enabled FROM schedules WHERE id = ?", [id],
    )
    return row ? { consecutive_failures: row.consecutive_failures, enabled: flag(row.enabled) } : null
  }

  async autoDisableSchedule(id: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE schedules SET enabled = false, next_trigger_at = NULL, updated_at = ? WHERE id = ?",
      [now, id],
    )
  }

  async resetConsecutiveFailures(id: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec("UPDATE schedules SET consecutive_failures = 0, updated_at = ? WHERE id = ?", [now, id])
  }

  // ── Schedule workspace queries (for WorkflowExecutor) ───────────

  async insertScheduleWorkspace(row: {
    id: string; schedule_id: string; workspace_id: string; status: string;
    branch_suffix: string; started_at: string;
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedule_workspaces (id, schedule_id, workspace_id, status, branch_suffix, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [row.id, row.schedule_id, row.workspace_id, row.status, row.branch_suffix, row.started_at])
  }

  async updateScheduleWorkspaceStatus(id: string, fields: Record<string, unknown>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0 }
    vals.push(id)
    return this.exec(`UPDATE schedule_workspaces SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  async findScheduleWorkspaceById(id: string): Promise<{ workspace_id: string } | null> {
    return (await this.q1<{ workspace_id: string }>("SELECT workspace_id FROM schedule_workspaces WHERE id = ?", [id])) ?? null
  }

  async findRetainedWorkspaces(scheduleId: string, maxRetain: number): Promise<Array<{ workspace_id: string }>> {
    // 旧 `LIMIT -1 OFFSET ?`（SQLite 取尾语法）→ PG 直接 OFFSET，LIMIT 缺省即无上限
    return this.q<{ workspace_id: string }>(`
      SELECT sw.workspace_id
      FROM schedule_workspaces sw
      WHERE sw.schedule_id = ?
        AND sw.status IN ('completed', 'failed')
      ORDER BY sw.started_at DESC
      OFFSET ?
    `, [scheduleId, maxRetain])
  }

  // ── Dashboard queries ───────────────────────────────────────────

  async countActiveSchedules(): Promise<number> {
    const row = await this.q1<{ cnt: string | number }>(
      "SELECT COUNT(*) as cnt FROM schedules WHERE enabled = true AND deleted_at IS NULL",
    )
    return num(row?.cnt)
  }

  async countFailedSchedules(): Promise<number> {
    const row = await this.q1<{ cnt: string | number }>(
      "SELECT COUNT(*) as cnt FROM schedules WHERE consecutive_failures > 0 AND enabled = true AND deleted_at IS NULL",
    )
    return num(row?.cnt)
  }

  async findNextTrigger(): Promise<{ id: string; name: string; next_trigger_at: string } | null> {
    const row = await this.q1<{ id: string; name: string; next_trigger_at: Date | string }>(`
      SELECT id, name, next_trigger_at FROM schedules
      WHERE enabled = true AND deleted_at IS NULL AND next_trigger_at IS NOT NULL
      ORDER BY next_trigger_at ASC LIMIT 1
    `)
    return row ? { id: row.id, name: row.name, next_trigger_at: iso(row.next_trigger_at) } : null
  }

  // ── Scheduler engine queries ────────────────────────────────────

  async updateSchedulerHeartbeat(): Promise<{ changes: number }> {
    return this.exec("UPDATE scheduler_state SET last_heartbeat = now() WHERE id = 1")
  }

  async setMissedAlertPending(): Promise<{ changes: number }> {
    return this.exec("UPDATE scheduler_state SET missed_alert_pending = true WHERE id = 1")
  }

  async findEnabledSchedulesForMissed(): Promise<ScheduleRow[]> {
    const rows = await this.q<ScPg>(
      "SELECT * FROM schedules WHERE enabled = true AND deleted_at IS NULL"
    )
    return rows.map(fromSchedule)
  }

  async findLastNonMissedExecution(scheduleId: string): Promise<{ triggered_at: string } | null> {
    const row = await this.q1<{ triggered_at: Date | string }>(`
      SELECT triggered_at FROM schedule_executions
      WHERE schedule_id = ? AND status != 'missed'
      ORDER BY triggered_at DESC LIMIT 1
    `, [scheduleId])
    return row ? { triggered_at: iso(row.triggered_at) } : null
  }

  async findExecutionNearTime(scheduleId: string, triggeredAt: string): Promise<unknown | undefined> {
    // 旧 julianday 秒差 → PG EXTRACT(EPOCH FROM ...)；±60s 容差语义不变
    return this.q1(`
      SELECT 1 FROM schedule_executions
      WHERE schedule_id = ?
        AND ABS(EXTRACT(EPOCH FROM (triggered_at - (?::timestamptz)))) < 60
    `, [scheduleId, triggeredAt])
  }

  async findRunningExecutionsWithScheduleInfo(): Promise<Array<{
    id: string; schedule_id: string; status: string; triggered_at: string;
    execution_id: string | null; timeout_seconds: number; notify_on_failure: number;
    schedule_name: string; notify_channel: string | null; notify_target: string | null;
    job_type: string; workspace_id: string | null;
  }>> {
    const rows = await this.q<{
      id: string; schedule_id: string; status: string; triggered_at: Date | string;
      execution_id: string | null; timeout_seconds: number; notify_on_failure: boolean | number;
      schedule_name: string; notify_channel: string | null; notify_target: string | null;
      job_type: string; workspace_id: string | null;
    }>(`
      SELECT se.*, s.timeout_seconds, s.notify_on_failure, s.name as schedule_name,
             s.notify_channel, s.notify_target, s.job_type
      FROM schedule_executions se
      JOIN schedules s ON se.schedule_id = s.id
      WHERE se.status = 'running'
    `)
    return rows.map(r => ({ ...r, triggered_at: iso(r.triggered_at), notify_on_failure: flag(r.notify_on_failure) }))
  }

  // ── Export queries ──────────────────────────────────────────────

  async findAllSchedulesWithWorkspaceInfo(): Promise<Array<{
    name: string; workspace_name: string; job_type: string; cron_expression: string;
    enabled: number; consecutive_failures: number;
    last_execution_at: string | null; last_execution_status: string | null;
  }>> {
    const rows = await this.q<{
      name: string; workspace_name: string; job_type: string; cron_expression: string;
      enabled: boolean | number; consecutive_failures: number;
      last_execution_at: Date | string | null; last_execution_status: string | null;
    }>(`
      SELECT
        s.name,
        COALESCE(w.name, '') as workspace_name,
        s.job_type,
        s.cron_expression,
        s.enabled,
        s.consecutive_failures,
        (SELECT triggered_at FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) as last_execution_at,
        (SELECT status FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) as last_execution_status
      FROM schedules s
      LEFT JOIN workspaces w ON s.workspace_id = w.id
      WHERE s.deleted_at IS NULL
      ORDER BY s.name ASC
    `)
    return rows.map(r => ({
      ...r,
      enabled: flag(r.enabled),
      last_execution_at: isoOrNull(r.last_execution_at),
    }))
  }

  // ── Scheduler-service queries (global job list with last-exec subqueries) ──

  /** The last-exec projection, shared by the list and the single-get query: four
   *  correlated subqueries over the same "newest fire" row, so a column added here shows
   *  up in both paths (and cannot be added to one only). */
  private static readonly LAST_EXEC_SELECT = `
        (SELECT status FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_status,
        (SELECT triggered_at FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_triggered_at,
        (SELECT error_summary FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_error_summary,
        (SELECT duration_ms FROM schedule_executions WHERE schedule_id = s.id ORDER BY triggered_at DESC LIMIT 1) AS last_exec_duration_ms`

  async listJobsQuery(params: {
    conditions: string[]; queryParams: unknown[];
    orderClause: string; limit: number; offset: number;
  }): Promise<{ rows: ScheduleRowWithLastExec[]; total: number }> {
    const whereClause = params.conditions.join(' AND ')
    const countSql = `SELECT COUNT(*) as cnt FROM schedules s WHERE ${whereClause}`
    const countRow = await this.q1<{ cnt: string | number }>(countSql, params.queryParams)
    const total = num(countRow?.cnt)

    const querySql = `
      SELECT s.*, ${ScheduleConfigDAO.LAST_EXEC_SELECT}
      FROM schedules s
      WHERE ${whereClause}
      ORDER BY ${params.orderClause}
      LIMIT ? OFFSET ?
    `
    const rows = await this.q<ScPg & LastExecPg>(querySql, [...params.queryParams, params.limit, params.offset])
    return { rows: rows.map(fromScheduleWithLastExec), total }
  }

  async getJobWithLastExec(id: string): Promise<ScheduleRowWithLastExec | null> {
    const row = await this.q1<ScPg & LastExecPg>(`
      SELECT s.*, ${ScheduleConfigDAO.LAST_EXEC_SELECT}
      FROM schedules s
      WHERE s.id = ? AND s.deleted_at IS NULL
    `, [id])
    return row ? fromScheduleWithLastExec(row) : null
  }

  // ── Agent route queries ────────────────────────────────────────────

  async insertAgentSchedule(id: string, org: string, name: string, cronExpression: string, jobType: string, config: string, now: string): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO schedules (id, org, name, cron_expression, timezone, enabled, job_type, config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, true, ?, ?, ?, ?)
    `, [id, org, name, cronExpression, 'Asia/Shanghai', jobType, config, now, now])
  }

  async listSchedulesByOrg(org: string): Promise<Array<{ id: string; name: string; cron_expression: string; enabled: number }>> {
    try {
      const rows = await this.q<{ id: string; name: string; cron_expression: string; enabled: boolean | number }>(
        'SELECT id, name, cron_expression, enabled FROM schedules WHERE org = ? AND deleted_at IS NULL ORDER BY created_at DESC',
        [org],
      )
      return rows.map(r => ({ ...r, enabled: flag(r.enabled) }))
    } catch {
      return []
    }
  }

  async findScheduleConfigByIdAndOrg(id: string, org: string): Promise<{ name: string; config: string } | null> {
    try {
      const row = await this.q1<{ name: string; config: unknown }>('SELECT name, config FROM schedules WHERE id = ? AND org = ?', [id, org])
      return row ? { name: row.name, config: jsonStr(row.config) ?? "{}" } : null
    } catch {
      return null
    }
  }

  async updateScheduleWorkspacesCleaned(workspaceId: string, completedAt: string): Promise<{ changes: number }> {
    try {
      return await this.exec("UPDATE schedule_workspaces SET status = 'cleaned', completed_at = ? WHERE workspace_id = ?", [completedAt, workspaceId])
    } catch {
      return { changes: 0 }
    }
  }

  // T-5 AC11: mark all incomplete schedule_workspaces for a schedule as cleaned
  // (used when rolling back stale claimed tasks; workspace dir cleanup is deferred to the retain loop)
  async markScheduleWorkspacesCleanedBySchedule(scheduleId: string, completedAt: string): Promise<{ changes: number }> {
    try {
      return await this.exec(
        "UPDATE schedule_workspaces SET status = 'cleaned', completed_at = ? WHERE schedule_id = ? AND status IN ('running', 'started')",
        [completedAt, scheduleId],
      )
    } catch {
      return { changes: 0 }
    }
  }
}

/** schedule_workspaces 的 PG 原始行（started_at/completed_at timestamptz）。 */
interface SwPg {
  id: string
  schedule_id: string
  workspace_id: string
  execution_id: string | null
  status: string
  branch_suffix: string
  started_at: Date | string
  completed_at: Date | string | null
  error: string | null
}

function fromSw(r: SwPg & { workspace_name?: string; workspace_status?: string }): ScheduleWorkspaceRow & { workspace_name?: string; workspace_status?: string } {
  return {
    ...r,
    started_at: iso(r.started_at),
    completed_at: isoOrNull(r.completed_at),
  }
}

/** LAST_EXEC_SELECT 四列的 PG 原始形态（triggered_at timestamptz、duration_ms bigint）。 */
interface LastExecPg {
  last_exec_status?: string | null
  last_exec_triggered_at?: Date | string | null
  last_exec_error_summary?: string | null
  last_exec_duration_ms?: string | number | null
}

function fromScheduleWithLastExec(r: ScPg & LastExecPg): ScheduleRowWithLastExec {
  return {
    ...fromSchedule(r),
    last_exec_status: r.last_exec_status ?? null,
    last_exec_triggered_at: isoOrNull(r.last_exec_triggered_at),
    last_exec_error_summary: r.last_exec_error_summary ?? null,
    last_exec_duration_ms: r.last_exec_duration_ms == null ? null : num(r.last_exec_duration_ms),
  }
}
