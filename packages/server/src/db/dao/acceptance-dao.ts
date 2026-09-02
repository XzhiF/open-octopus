import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { TaskPhaseAcceptanceRow } from "../types"

/**
 * AcceptanceDAO — append-only ledger for the phase 验收 Gate (schema v40, K4).
 *
 * One row per human decision on a phase round: accepted (放行) or rejected
 * (打回 + feedback). A round's decision is historical fact, so this DAO exposes
 * INSERT + LIST only — no update/delete surface. Enforcement is doubled:
 * DB-level triggers (prevent_task_phase_acceptance_update/_delete in schema.sql,
 * mirrors the schedule_audit_logs precedent) reject raw UPDATE/DELETE even if a
 * future caller reaches past this class.
 *
 * task_id has no FK (S2 polymorphic-integrity convention — app-level, same as
 * schedules.origin_id): the ledger outlives task soft-deletes and survives
 * future tasks rebuilds.
 */
export class AcceptanceDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  /** Append one acceptance row. decided_at defaults to now (ISO). */
  insert(row: {
    id: string
    task_id: string
    phase_index: number
    round_index: number
    decision: "accepted" | "rejected"
    feedback?: string | null
    decided_at?: string
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO task_phase_acceptances (id, task_id, phase_index, round_index, decision, feedback, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.task_id, row.phase_index, row.round_index,
      row.decision, row.feedback ?? null, row.decided_at ?? new Date().toISOString(),
    )
  }

  /** Full ledger for a task, chronological by (phase, round, decided_at, id). */
  listByTask(taskId: string): TaskPhaseAcceptanceRow[] {
    return this.stmt(
      "SELECT * FROM task_phase_acceptances WHERE task_id = ? ORDER BY phase_index ASC, round_index ASC, decided_at ASC, id ASC",
    ).all(taskId) as TaskPhaseAcceptanceRow[]
  }

  /** Ledger rows for one phase of a task, ordered by round. */
  listByPhase(taskId: string, phaseIndex: number): TaskPhaseAcceptanceRow[] {
    return this.stmt(
      "SELECT * FROM task_phase_acceptances WHERE task_id = ? AND phase_index = ? ORDER BY round_index ASC, decided_at ASC, id ASC",
    ).all(taskId, phaseIndex) as TaskPhaseAcceptanceRow[]
  }

  /** Ledger rows for one exact (task, phase, round) — append-only means a round
   *  can carry multiple rows (e.g. a duplicate submission); the service layer
   *  uses this for the idempotency/409 check (票 07 AC4). */
  listByRound(taskId: string, phaseIndex: number, roundIndex: number): TaskPhaseAcceptanceRow[] {
    return this.stmt(
      "SELECT * FROM task_phase_acceptances WHERE task_id = ? AND phase_index = ? AND round_index = ? ORDER BY decided_at ASC, id ASC",
    ).all(taskId, phaseIndex, roundIndex) as TaskPhaseAcceptanceRow[]
  }
}
