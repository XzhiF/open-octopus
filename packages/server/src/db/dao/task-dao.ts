import { BasePgDAO, type PgSql } from "./base-pg"
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
 *
 * P1 B2 (better-sqlite3 → postgres.js) 行形态契约 —— 读出全部保持 SQLite 时代的
 * string/number 语义（types.ts TaskRow 不动）：
 *   - timestamptz 列经 to_char(… AT TIME ZONE 'UTC') 投影回 `…Z` ISO 文本
 *     （p1-batch-plan §3 S4 的「B 期保留 text 降风险」裁决；写入仍收 ISO 串）。
 *   - trigger_enabled 列 PG 为 boolean：读出 ::int 归 0/1；写入侧 SQL 里
 *     裸 `=1` 字面量全部改 `= true`（PG 无 int→bool 表达式杆面）。
 *     ⚠ 参数面同坑（实测）：postgres.js unsafe 把 JS number 1/0 绑成 int8 送进
 *     boolean 列会**静默存成 false**（不报错）—— 旧行契约的 0/1 必须先转真 boolean
 *     （toBool）。这是 B2 实测出的最大语义地雷，B3-B5 凡 0/1→bool 列都要过 toBool。
 *   - jsonb 列（task_spec/…）经 `#>> '{}'` 归一为 TEXT 返回：postgres.js 对 jsonb
 *     直读会在 string（未命中解析器）/ object（命中）间漂移，且 PG 输出是规范化
 *     JSON（键按长度重排、冒号后带空格）—— 行契约锁 string，调用方 JSON.parse
 *     零改动；「读出串 === 写入串」断言一律改语义比对（键序/空白会变）。
 */
/** 旧 0/1（或已是 boolean）→ PG boolean 列参数；undefined = DDL 默认 (true)。 */
const toBool = (v: unknown): boolean | undefined =>
  v === undefined || v === null ? undefined : (typeof v === "boolean" ? v : Number(v) !== 0)

const TS = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const TASK_COLS = `id, org, name, status, source_chat_session_id,
  -- jsonb 读出经 #>> '{}' 归 text：postgres.js 对 jsonb 的返回型在 string/object 间
  -- 随解析路径漂移（实测两种都有），且 PG 会按长度重排键序 + 规范化空白 ——
  -- 行契约锁定「紧凑无关的 JSON 文本」：调用方 JSON.parse 链路不变，
  -- 但「读出串 === 写入串」式断言必须改语义比对（键序会变）。
  task_spec #>> '{}' AS task_spec, authoring_resources #>> '{}' AS authoring_resources,
  resources #>> '{}' AS resources, skills #>> '{}' AS skills, project_ids #>> '{}' AS project_ids,
  workflow_ref, version,
  ${TS("deleted_at")} AS deleted_at, ${TS("created_at")} AS created_at,
  ${TS("updated_at")} AS updated_at, ${TS("completed_at")} AS completed_at,
  workspace_id, trigger_mode, ${TS("trigger_at")} AS trigger_at,
  cron_expression, cron_timezone, trigger_enabled::int AS trigger_enabled,
  ${TS("next_fire_at")} AS next_fire_at, ${TS("last_fired_at")} AS last_fired_at`

export class TaskDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  /** Insert a new task row. JSON columns default to their empty shapes. */
  insert(row: Partial<TaskRow> & { id: string; org: string; name: string }): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(`
      INSERT INTO tasks (
        id, org, name, status, source_chat_session_id,
        task_spec, authoring_resources, resources, skills, project_ids,
        workflow_ref, version, deleted_at, created_at, updated_at, completed_at,
        workspace_id,
        trigger_mode, trigger_at, cron_expression, cron_timezone,
        trigger_enabled, next_fire_at, last_fired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
      // v41 (ADR-0021): a caller that hands us a full row keeps its trigger fields. Before
      // this, insert() wrote 17 columns and the 7 new ones silently took their DDL
      // defaults — so a restore/import path carrying an armed schedule lost the arming.
      // trigger_enabled：PG bool 列 —— 0/1 必须经 toBool 转真 boolean（见头注地雷）。
      row.trigger_mode ?? "manual",
      row.trigger_at ?? null,
      row.cron_expression ?? null,
      row.cron_timezone ?? "Asia/Shanghai",
      toBool(row.trigger_enabled) ?? true,
      row.next_fire_at ?? null,
      row.last_fired_at ?? null,
    ])
  }

  /** Active task (deleted_at IS NULL). Null if missing or soft-deleted. */
  async getById(id: string): Promise<TaskRow | null> {
    return (await this.q1<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = ? AND deleted_at IS NULL`, [id])) ?? null
  }

  /** Raw row including soft-deleted (for reaper / audit / restore flows). */
  async getByIdRaw(id: string): Promise<TaskRow | null> {
    return (await this.q1<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`, [id])) ?? null
  }

  /**
   * Find the active (non-deleted) task bound to a chat session. Used by the
   * autosave seam (clone/index.ts:406) to decide whether to create a new draft
   * row or update the title of the existing one (v2-D6/D11/SG3).
   */
  async getBySourceChatSession(sessionId: string): Promise<TaskRow | null> {
    return (await this.q1<TaskRow>(
      `SELECT ${TASK_COLS} FROM tasks WHERE source_chat_session_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    )) ?? null
  }

  /** Batch variant of getBySourceChatSession — returns (session_id, task_id,
   *  name, status) for every task row bound to any of the given sessions.
   *  Deleted tasks are EXCLUDED (a discarded draft's session returns to the
   *  clone's own chat pool). Used by GET /api/clones/:name/sessions to hide
   *  task-owned sessions from the clone chatbot (the task modal fetches them
   *  by id directly). */
  getLinksBySourceChatSessions(sessionIds: string[]): Promise<{ session_id: string; task_id: string; name: string; status: string }[]> {
    if (sessionIds.length === 0) return Promise.resolve([])
    const placeholders = sessionIds.map(() => "?").join(", ")
    return this.q<{ session_id: string; task_id: string; name: string; status: string }>(
      `SELECT source_chat_session_id AS session_id, id AS task_id, name, status
       FROM tasks WHERE source_chat_session_id IN (${placeholders}) AND deleted_at IS NULL`,
      sessionIds,
    )
  }

  /**
   * Optimistic-concurrency update: bumps `version` and applies `fields`.
   * Rejects stale writers — returns changes=0 when the row's version doesn't
   * match `expectedVersion` (or the task is soft-deleted). Callers (spec-field
   * tool, [save draft]) detect 0 changes → 409 → re-GET + retry (v2-D12).
   */
  updateWithVersion(id: string, fields: Record<string, unknown>, expectedVersion: number): Promise<{ changes: number }> {
    const sets: string[] = ["updated_at = ?", "version = version + 1"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id, expectedVersion)
    return this.exec(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      vals,
    )
  }

  /**
   * Targeted autosave UPDATE — writes ONLY name + updated_at (SG8). Does NOT
   * bump version and does NOT touch task_spec/resources/authoring_resources,
   * so it cannot race with the spec-field tool on the same turn (autosave fires
   * at turn-end, after tool calls have already landed).
   */
  updateAutosave(id: string, name: string): Promise<{ changes: number }> {
    return this.exec(
      "UPDATE tasks SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [name, new Date().toISOString(), id],
    )
  }

  /** List active tasks by status (kanban columns), ordered by created_at ASC then id. */
  listByStatus(status: string): Promise<TaskRow[]> {
    return this.q<TaskRow>(
      `SELECT ${TASK_COLS} FROM tasks WHERE status = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`,
      [status],
    )
  }

  /** List active tasks for an org (kanban board), most recently updated first. */
  listByOrg(org: string): Promise<TaskRow[]> {
    return this.q<TaskRow>(
      `SELECT ${TASK_COLS} FROM tasks WHERE org = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC`,
      [org],
    )
  }

  /** Soft-delete (discard draft/ready). Sets deleted_at; does NOT change status. */
  softDelete(id: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [now, now, id],
    )
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
  //
  // B2 note: `trigger_enabled=1` 裸字面量在 PG 下非法（int 表达式不能进 bool 列），
  // 全部改 `= true`；读出侧 ::int 归一（TASK_COLS）。

  /** Arm a one-shot fire. `atIso` = now for 立即触发, a future ISO for 定时触发. */
  async armOnce(id: string, atIso: string): Promise<boolean> {
    const now = new Date().toISOString()
    const r = await this.exec(
      `UPDATE tasks
       SET trigger_mode='once', trigger_at=?, next_fire_at=?, trigger_enabled=true, updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
      [atIso, atIso, now, id],
    )
    return r.changes > 0
  }

  /** Arm a recurring fire. `nextFireAt` is computed by the caller (cron-utils). */
  async armCron(id: string, cronExpression: string, timezone: string, nextFireAt: string): Promise<boolean> {
    const now = new Date().toISOString()
    const r = await this.exec(
      `UPDATE tasks
       SET trigger_mode='cron', cron_expression=?, cron_timezone=?, trigger_at=NULL,
           next_fire_at=?, trigger_enabled=true, updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
      [cronExpression, timezone, nextFireAt, now, id],
    )
    return r.changes > 0
  }

  /** Withdraw any armed trigger → back to 人工触发 (no due cursor). */
  async disarmTrigger(id: string): Promise<boolean> {
    const now = new Date().toISOString()
    const r = await this.exec(
      `UPDATE tasks
       SET trigger_mode='manual', trigger_at=NULL, cron_expression=NULL,
           next_fire_at=NULL, updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
      [now, id],
    )
    return r.changes > 0
  }

  /** Pause/resume a recurring task without losing its cron expression. */
  async setTriggerEnabled(id: string, enabled: boolean): Promise<boolean> {
    const now = new Date().toISOString()
    const r = await this.exec(
      "UPDATE tasks SET trigger_enabled=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
      [enabled, now, id],
    )
    return r.changes > 0
  }

  /**
   * The due scan. The scheduler reaches tasks ONLY through this task-domain query —
   * it never reads the tasks table itself, which is what keeps the ownership cut
   * one-directional (ADR-0021 §5). `status='ready'` is the task's own precondition for
   * "allowed to run", stated here rather than in the pump.
   */
  findDueTriggers(nowIso: string, limit = 20): Promise<TaskRow[]> {
    return this.q<TaskRow>(
      `SELECT ${TASK_COLS} FROM tasks
       WHERE status = 'ready' AND deleted_at IS NULL AND trigger_enabled = true
         AND next_fire_at IS NOT NULL AND next_fire_at <= ?
       ORDER BY next_fire_at ASC, created_at ASC LIMIT ?`,
      [nowIso, limit],
    )
  }

  /**
   * Post-hand-off bookkeeping: stamp last_fired_at and move the cursor.
   * once/manual → `nextFireAt = NULL` (fires exactly once; leaving the cursor set would
   * make the pump re-enqueue after the run finishes). cron → the next computed time.
   */
  async markFired(id: string, nextFireAt: string | null, firedAtIso: string): Promise<boolean> {
    const r = await this.exec(
      `UPDATE tasks
       SET last_fired_at=?, next_fire_at=?, trigger_at=CASE WHEN trigger_mode='once' THEN NULL ELSE trigger_at END,
           updated_at=?
       WHERE id=? AND deleted_at IS NULL`,
      [firedAtIso, nextFireAt, firedAtIso, id],
    )
    return r.changes > 0
  }

  // ── P1 B2：吸收 tasks-service.ts 的 4 个 tasks 表直写逃生口 ──────────────
  //
  // 这些 UPDATE 此前以 `taskDAO.getDb().prepare(...)` 直写 SQLite；TaskDAO 迁 PG 后
  // 直写句柄不复存在（BasePgDAO 无 getDb()），收编为显式 DAO 方法。语义保持：
  // 不 bump version（系统事件写不是规格编辑，updateAutosave 纪律同源），
  // 返回 changes>0 供调用方做冲突判定（仅 revertReadyToDraft 用）。

  /** reopen：ready（未被领取）→ draft。条件更新，changes=0 = 状态已变，调用方 409。 */
  async revertReadyToDraft(id: string, nowIso: string): Promise<boolean> {
    const r = await this.exec(
      "UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND status = 'ready' AND deleted_at IS NULL",
      ["draft", nowIso, id],
    )
    return r.changes > 0
  }

  /**
   * 系统事件状态写：status + updated_at (+ completed_at 覆写或清空)，无 version bump。
   * 覆盖 cancelScheduled 回 ready / endArchiving 落 done / setPersistedTaskStatus /
   * abortTask 落 aborted 四类直写（B2 前它们是 service 层 prepare 逃生口）。
   */
  setStatusDirect(id: string, status: string, nowIso: string, completedAt: string | null): Promise<{ changes: number }> {
    return this.exec(
      "UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND deleted_at IS NULL",
      [status, nowIso, completedAt, id],
    )
  }

  /** armTask 绑定位：workspace 首建后把 id 钉到任务上（系统事件，不 bump version）。 */
  setWorkspaceId(id: string, workspaceId: string, nowIso: string): Promise<{ changes: number }> {
    return this.exec(
      "UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      [workspaceId, nowIso, id],
    )
  }

  /** cron 任务跑完一轮后的续命：回 ready + 推进 next_fire_at（trigger_enabled 复位）。
   *  B2 收编自 task-lifecycle 的 prepare 逃生口；`trigger_enabled=1` 裸字面量 → true。 */
  rearmCronAsReady(id: string, nextFireAt: string, nowIso: string): Promise<{ changes: number }> {
    return this.exec(
      `UPDATE tasks SET status = 'ready', next_fire_at = ?, trigger_enabled = true,
         completed_at = NULL, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [nextFireAt, nowIso, id],
    )
  }

  /** 引擎态镜像（running/done/failed/aborted）：仅当状态真的变了才写 + 返回 changes
   *  （changes=0 = 未变，调用方据此抑制 SSE）。completed_at 终态盖 now，非终态清空。 */
  async mirrorStatus(
    id: string,
    status: string,
    nowIso: string,
    completedAt: string | null,
  ): Promise<boolean> {
    const r = await this.exec(
      `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND deleted_at IS NULL AND status <> ?`,
      [status, nowIso, completedAt, id, status],
    )
    return r.changes > 0
  }
}
