import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { TaskRow } from "../types"

/**
 * TaskDAO — CRUD for the first-class `tasks` table (schema v38, v2-D1).
 *
 * Owns the draft→ready→running→done/failed/aborted lifecycle + task_spec (WHAT) +
 * resource/skill bindings. S2 polymorphic origin: there is NO schedule_id /
 * execution_id / claimed_at on this row — the link to schedules is via
 * `schedules WHERE origin_type='task' AND origin_id=task.id`, maintained at the
 * app level (cascade-reap on delete/abort + orphan reaper, SG12 — implemented in
 * the service layer, not here).
 *
 * Concurrency: `updateWithVersion` bumps `version` and rejects stale writes
 * (changes=0) so the spec-field tool ([save draft]) can detect conflicts and
 * return 409 → agent re-GET + retry (v2-D12). The autosave seam writes ONLY
 * name+updated_at via {@link updateAutosave} — it does NOT bump version or touch
 * task_spec/resources (SG8), avoiding races with the spec-field tool.
 */
export class TaskDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  /** Insert a new task row. JSON columns default to their empty shapes. */
  insert(row: Partial<TaskRow> & { id: string; org: string; name: string }): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(`
      INSERT INTO tasks (
        id, org, name, status, source_chat_session_id,
        task_spec, authoring_resources, resources, skills, project_ids,
        workflow_ref, version, deleted_at, created_at, updated_at, completed_at,
        workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.name,
      row.status ?? "draft",
      row.source_chat_session_id ?? null,
      row.task_spec ?? "{}",
      row.authoring_resources ?? "[]",
      row.resources ?? "[]",
      row.skills ?? "[]",
      row.project_ids ?? "[]",
      row.workflow_ref ?? null,
      row.version ?? 1,
      row.deleted_at ?? null,
      row.created_at ?? now,
      row.updated_at ?? now,
      row.completed_at ?? null,
      row.workspace_id ?? null,
    )
  }

  /** Active task (deleted_at IS NULL). Null if missing or soft-deleted. */
  getById(id: string): TaskRow | null {
    return (this.stmt("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL").get(id) as TaskRow | undefined) ?? null
  }

  /** Raw row including soft-deleted (for reaper / audit / restore flows). */
  getByIdRaw(id: string): TaskRow | null {
    return (this.stmt("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null
  }

  /**
   * Find the active (non-deleted) task bound to a chat session. Used by the
   * autosave seam (clone/index.ts:406) to decide whether to create a new draft
   * row or update the title of the existing one (v2-D6/D11/SG3).
   */
  getBySourceChatSession(sessionId: string): TaskRow | null {
    return (this.stmt(
      "SELECT * FROM tasks WHERE source_chat_session_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).get(sessionId) as TaskRow | undefined) ?? null
  }

  /** Batch variant of getBySourceChatSession — returns (session_id, task_id,
   *  name, status) for every task row bound to any of the given sessions.
   *  Deleted tasks are EXCLUDED (a discarded draft's session returns to the
   *  clone's own chat pool). Used by GET /api/clones/:name/sessions to hide
   *  task-owned sessions from the clone chatbot (the task modal fetches them
   *  by id directly). */
  getLinksBySourceChatSessions(sessionIds: string[]): { session_id: string; task_id: string; name: string; status: string }[] {
    if (sessionIds.length === 0) return []
    const placeholders = sessionIds.map(() => "?").join(", ")
    return this.stmt(
      `SELECT source_chat_session_id AS session_id, id AS task_id, name, status
       FROM tasks WHERE source_chat_session_id IN (${placeholders}) AND deleted_at IS NULL`,
    ).all(...sessionIds) as { session_id: string; task_id: string; name: string; status: string }[]
  }

  /**
   * Optimistic-concurrency update: bumps `version` and applies `fields`.
   * Rejects stale writers — returns changes=0 when the row's version doesn't
   * match `expectedVersion` (or the task is soft-deleted). Callers (spec-field
   * tool, [save draft]) detect 0 changes → 409 → re-GET + retry (v2-D12).
   */
  updateWithVersion(id: string, fields: Record<string, unknown>, expectedVersion: number): Database.RunResult {
    const sets: string[] = ["updated_at = ?", "version = version + 1"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id, expectedVersion)
    return this.stmt(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    ).run(...vals)
  }

  /**
   * Targeted autosave UPDATE — writes ONLY name + updated_at (SG8). Does NOT
   * bump version and does NOT touch task_spec/resources/authoring_resources,
   * so it cannot race with the spec-field tool on the same turn (autosave fires
   * at turn-end, after tool calls have already landed).
   */
  updateAutosave(id: string, name: string): Database.RunResult {
    return this.stmt(
      "UPDATE tasks SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(name, new Date().toISOString(), id)
  }

  /** List active tasks by status (kanban columns), ordered by created_at ASC then id. */
  listByStatus(status: string): TaskRow[] {
    return this.stmt(
      "SELECT * FROM tasks WHERE status = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC",
    ).all(status) as TaskRow[]
  }

  /** List active tasks for an org (kanban board), most recently updated first. */
  listByOrg(org: string): TaskRow[] {
    return this.stmt(
      "SELECT * FROM tasks WHERE org = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC",
    ).all(org) as TaskRow[]
  }

  /** Soft-delete (discard draft/ready). Sets deleted_at; does NOT change status. */
  softDelete(id: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(now, now, id)
  }

  // ── schema v41 (ADR-0021): 触发意图 = 任务自己的数据 ──────────────────
  //
  // Pre-v41 these facts lived on a private `schedules` envelope row that readyTask
  // pre-created and parked; "arming" meant flipping that row, which is how the task
  // ended up owning scheduler state. Now the task owns WHEN, and `next_fire_at` is the
  // single cursor the scheduler's due-scan reads (once: = trigger_at; cron: advanced by
  // markFired after each hand-off; NULL: nothing armed).
  //
  // None of these bump `version` — a trigger write is not a spec edit, and it must not
  // 409 against a concurrent autosave/spec-field write (updateAutosave precedent).

  /** Arm a one-shot fire. `atIso` = now for 立即触发, a future ISO for 定时触发. */
  armOnce(id: string, atIso: string): boolean {
    const now = new Date().toISOString()
    return this.stmt(
      `UPDATE tasks
       SET trigger_mode='once', trigger_at=?, next_fire_at=?, trigger_enabled=1, updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
    ).run(atIso, atIso, now, id).changes > 0
  }

  /** Arm a recurring fire. `nextFireAt` is computed by the caller (cron-utils). */
  armCron(id: string, cronExpression: string, timezone: string, nextFireAt: string): boolean {
    const now = new Date().toISOString()
    return this.stmt(
      `UPDATE tasks
       SET trigger_mode='cron', cron_expression=?, cron_timezone=?, trigger_at=NULL,
           next_fire_at=?, trigger_enabled=1, updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
    ).run(cronExpression, timezone, nextFireAt, now, id).changes > 0
  }

  /** Withdraw any armed trigger → back to 人工触发 (no due cursor). */
  disarmTrigger(id: string): boolean {
    const now = new Date().toISOString()
    return this.stmt(
      `UPDATE tasks
       SET trigger_mode='manual', trigger_at=NULL, cron_expression=NULL,
           next_fire_at=NULL, updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
    ).run(now, id).changes > 0
  }

  /** Pause/resume a recurring task without losing its cron expression. */
  setTriggerEnabled(id: string, enabled: boolean): boolean {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE tasks SET trigger_enabled=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
    ).run(enabled ? 1 : 0, now, id).changes > 0
  }

  /**
   * The due scan. The scheduler reaches tasks ONLY through this task-domain query —
   * it never reads the tasks table itself, which is what keeps the ownership cut
   * one-directional (ADR-0021 §5). `status='ready'` is the task's own precondition for
   * "allowed to run", stated here rather than in the pump.
   */
  findDueTriggers(nowIso: string, limit = 20): TaskRow[] {
    return this.stmt(
      `SELECT * FROM tasks
       WHERE status = 'ready' AND deleted_at IS NULL AND trigger_enabled = 1
         AND next_fire_at IS NOT NULL AND next_fire_at <= ?
       ORDER BY next_fire_at ASC, created_at ASC LIMIT ?`,
    ).all(nowIso, limit) as TaskRow[]
  }

  /**
   * Post-hand-off bookkeeping: stamp last_fired_at and move the cursor.
   * once/manual → `nextFireAt = NULL` (fires exactly once; leaving the cursor set would
   * make the pump re-enqueue after the run finishes). cron → the next computed time.
   */
  markFired(id: string, nextFireAt: string | null, firedAtIso: string): boolean {
    return this.stmt(
      `UPDATE tasks
       SET last_fired_at=?, next_fire_at=?, trigger_at=CASE WHEN trigger_mode='once' THEN NULL ELSE trigger_at END,
           updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
    ).run(firedAtIso, nextFireAt, firedAtIso, id).changes > 0
  }
}
