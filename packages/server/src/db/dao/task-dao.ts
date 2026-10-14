import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import { escapeLikeParam } from "../like-escape"
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
        workspace_id, semantic_summary,
        trigger_mode, trigger_at, cron_expression, cron_timezone,
        trigger_enabled, next_fire_at, last_fired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      // 票06: 语义摘要列（ADDITIVE）——insert 默认 NULL（未归档无摘要），归档链后经
      // setSemanticSummary 定向写入；insert 携带 full-row（restore/import）时保留原值。
      row.semantic_summary ?? null,
      // v41 (ADR-0021): a caller that hands us a full row keeps its trigger fields. Before
      // this, insert() wrote 17 columns and the 7 new ones silently took their DDL
      // defaults — so a restore/import path carrying an armed schedule lost the arming.
      row.trigger_mode ?? "manual",
      row.trigger_at ?? null,
      row.cron_expression ?? null,
      row.cron_timezone ?? "Asia/Shanghai",
      row.trigger_enabled ?? 1,
      row.next_fire_at ?? null,
      row.last_fired_at ?? null,
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

  /**
   * schema v50 (ADR-0025, taskboard-modal-v2 票01): bind the task's single
   * task-doer chat session. Targeted UPDATE like updateAutosave — does NOT bump
   * version: opening a chat is not a spec edit and must not 409 against a
   * concurrent [save draft]/spec-field write (v2-D12 discipline).
   */
  bindDoerSession(id: string, sessionId: string): boolean {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE tasks SET doer_session_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(sessionId, now, id).changes > 0
  }

  /**
   * 归档资产化 P3 票06 (语义摘要进任务板): 写归档总结的多面语义摘要。Targeted UPDATE
   * like bindDoerSession/updateAutosave — 只动 semantic_summary + updated_at，NOT bump
   * version、NOT touch status: 摘要写是派生元数据、非 spec 编辑（不得对并发 spec-field
   * 写 409），且归档链永不参与 done 判定（K11 零触碰、done 唯一写者不变）。
   * 归档链失败语义要求本方法永不抛（调用方 fire-and-forget）；软删/缺失行 changes=0 返 false。
   */
  setSemanticSummary(id: string, summary: string): boolean {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE tasks SET semantic_summary = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
    ).run(summary, now, id).changes > 0
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

  /**
   * 归档资产化 P3 票06 (语义摘要进任务板): 服务端 LIKE 搜索（零新基建、非 FTS——LIKE 即
   * 现状最小档）。对 name ∨ semantic_summary 子串匹配，叠加可选 status/org。
   *  - 未归档/无摘要 task：semantic_summary 为 NULL，IFNULL 兜成 '' 不参与匹配、不报错
   *    （宽容读，历史已归档 task 天然不进「按摘要」的结果但按 name 仍可命中）。
   *  - 排序 updated_at DESC（搜索结果「最近改动优先」；空 q 由调用方走原 listTasks 路径，
   *    本方法仅在 q 非空时被调用）。
   *  转义 % / _ / \ 防用户串里的通配符误命中（ESCAPE '\'）。
   */
  searchActive(opts: { status?: string; org?: string; q: string }): TaskRow[] {
    const like = `%${escapeLikeParam(opts.q)}%`
    const clauses: string[] = [
      "deleted_at IS NULL",
      "(name LIKE ? ESCAPE '\\' OR IFNULL(semantic_summary, '') LIKE ? ESCAPE '\\')",
    ]
    const vals: unknown[] = [like, like]
    if (opts.status) { clauses.push("status = ?"); vals.push(opts.status) }
    if (opts.org) { clauses.push("org = ?"); vals.push(opts.org) }
    return this.stmt(
      `SELECT * FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC`,
    ).all(...vals) as TaskRow[]
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
