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
        workflow_ref, version, deleted_at, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
}
