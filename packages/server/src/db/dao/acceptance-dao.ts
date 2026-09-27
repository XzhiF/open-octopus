import { BasePgDAO, type PgSql } from "./base-pg"
import type { TaskPhaseAcceptanceRow } from "../types"

/**
 * AcceptanceDAO — append-only ledger for the phase 验收 Gate (schema v40, K4).
 *
 * One row per human decision on a phase round: accepted (放行) or rejected
 * (打回 + feedback). A round's decision is historical fact, so this DAO exposes
 * INSERT + LIST only — no update/delete surface. Enforcement is doubled:
 * DB-level triggers (prevent_task_phase_acceptance_update/_delete — SQLite
 * schema.ts / PG db/pg/schema.sql `octopus_assert_append_only`) reject raw
 * UPDATE/DELETE even if a future caller reaches past this class.
 *
 * P1 B2：better-sqlite3 → postgres.js。语义映射：
 *   - insert() 旧返 Database.RunResult → {changes}（调用方无人用 lastInsertRowid，id 自带）。
 *   - decided_at 列 PG 侧为 timestamptz（SQLite 存 ISO 文本）：写入仍收 ISO 字符串，
 *     读出经 ISO_UTC 投影归一为 `...Z` 文本，Row 契约（decided_at: string）不变。
 *   - append-only 触发器报错文案 PG 是 RAISE（25000/触发器消息），SQLite 是
 *     "attempt to ... a table that is append-only" 风格 —— 断言别锁文案，锁「抛错」。
 *
 * task_id has no FK (S2 polymorphic-integrity convention — app-level, same as
 * schedules.origin_id): the ledger outlives task soft-deletes and survives
 * future tasks rebuilds.
 */
const ISO = (col: string) =>
  `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const COLS = `id, task_id, phase_index, round_index, decision, feedback, ${ISO("decided_at")} AS decided_at`

export class AcceptanceDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  /** Append one acceptance row. decided_at defaults to now (ISO). */
  async insert(row: {
    id: string
    task_id: string
    phase_index: number
    round_index: number
    decision: "accepted" | "rejected"
    feedback?: string | null
    decided_at?: string
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.task_id, row.phase_index, row.round_index,
      row.decision, row.feedback ?? null, row.decided_at ?? new Date().toISOString(),
    ])
  }

  /** Full ledger for a task, chronological by (phase, round, decided_at, id). */
  listByTask(taskId: string): Promise<TaskPhaseAcceptanceRow[]> {
    return this.q<TaskPhaseAcceptanceRow>(
      `SELECT ${COLS} FROM task_phase_acceptances WHERE task_id = ? ORDER BY phase_index ASC, round_index ASC, decided_at ASC, id ASC`,
      [taskId],
    )
  }

  /** Ledger rows for one phase of a task, ordered by round. */
  listByPhase(taskId: string, phaseIndex: number): Promise<TaskPhaseAcceptanceRow[]> {
    return this.q<TaskPhaseAcceptanceRow>(
      `SELECT ${COLS} FROM task_phase_acceptances WHERE task_id = ? AND phase_index = ? ORDER BY round_index ASC, decided_at ASC, id ASC`,
      [taskId, phaseIndex],
    )
  }

  /** Ledger rows for one exact (task, phase, round) — append-only means a round
   *  can carry multiple rows (e.g. a duplicate submission); the service layer
   *  uses this for the idempotency/409 check (票 07 AC4). */
  listByRound(taskId: string, phaseIndex: number, roundIndex: number): Promise<TaskPhaseAcceptanceRow[]> {
    return this.q<TaskPhaseAcceptanceRow>(
      `SELECT ${COLS} FROM task_phase_acceptances WHERE task_id = ? AND phase_index = ? AND round_index = ? ORDER BY decided_at ASC, id ASC`,
      [taskId, phaseIndex, roundIndex],
    )
  }
}
