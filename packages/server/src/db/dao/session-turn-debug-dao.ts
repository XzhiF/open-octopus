import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

/** One row per chat turn: what was actually handed to the SDK. */
export interface SessionTurnDebugRow {
  id: string
  session_id: string
  turn_index: number
  user_message_id: string | null
  assistant_message_id: string | null
  started_at: string
  ended_at: string | null
  status: string
  model: string | null
  effort: string | null
  cwd: string | null
  identity: string | null
  role_revision: number
  role_card: string | null
  provider_message: string | null
  system_prompt: string | null
  system_prompt_hash: string | null
  sdk_options: string | null
  context_usage: string | null
  system_init: string | null
  usage: string | null
  ttft_ms: number | null
  duration_ms: number | null
  error: string | null
  events: string | null
  created_at: string
  updated_at: string
}

export interface SessionTurnDebugInsert {
  id: string
  session_id: string
  turn_index: number
  user_message_id?: string | null
  assistant_message_id?: string | null
  started_at: string
  status?: string
  model?: string | null
  effort?: string | null
  cwd?: string | null
  identity?: string | null
  role_revision?: number
  role_card?: string | null
  provider_message?: string | null
  system_prompt?: string | null
  system_prompt_hash?: string | null
  sdk_options?: string | null
  context_usage?: string | null
  system_init?: string | null
  usage?: string | null
  ttft_ms?: number | null
  duration_ms?: number | null
  error?: string | null
  events?: string | null
}

export type SessionTurnDebugSummaryRow = Pick<
  SessionTurnDebugRow,
  | "id"
  | "session_id"
  | "turn_index"
  | "user_message_id"
  | "assistant_message_id"
  | "started_at"
  | "ended_at"
  | "status"
  | "model"
  | "effort"
  | "identity"
  | "role_revision"
  | "usage"
  | "ttft_ms"
  | "duration_ms"
  | "error"
> & { has_switch: number }

const MUTABLE_COLUMNS = new Set([
  "assistant_message_id",
  "ended_at",
  "status",
  "context_usage",
  "system_init",
  "usage",
  "ttft_ms",
  "duration_ms",
  "error",
  "events",
])

/**
 * Persistence for the dock's per-turn debug inspector.
 *
 * Deliberately a separate table: `sessions.context_usage` is overwritten every
 * turn, and neither the provider message nor the SDK init snapshot is stored
 * anywhere else. The inspector lists summaries (no large text) and loads one
 * turn's full payload on demand.
 */
export class SessionTurnDebugDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  nextTurnIndex(sessionId: string): number {
    const row = this.stmt(
      "SELECT COALESCE(MAX(turn_index), 0) + 1 AS next FROM session_turn_debug WHERE session_id = ?",
    ).get(sessionId) as { next: number }
    return row.next
  }

  insert(row: SessionTurnDebugInsert): void {
    const now = new Date().toISOString()
    this.stmt(`
      INSERT INTO session_turn_debug (
        id, session_id, turn_index, user_message_id, assistant_message_id,
        started_at, ended_at, status, model, effort, cwd, identity,
        role_revision, role_card, provider_message, system_prompt,
        system_prompt_hash, sdk_options, context_usage, system_init,
        usage, ttft_ms, duration_ms, error, events, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
        NULL, NULL, NULL, NULL, ?, ?, ?
      )
    `).run(
      row.id, row.session_id, row.turn_index,
      row.user_message_id ?? null, row.assistant_message_id ?? null,
      row.started_at, row.status ?? "running",
      row.model ?? null, row.effort ?? null, row.cwd ?? null,
      row.identity ?? null, row.role_revision ?? 0, row.role_card ?? null,
      row.provider_message ?? null, row.system_prompt ?? null,
      row.system_prompt_hash ?? null, row.sdk_options ?? null,
      row.events ?? null, now, now,
    )
  }

  update(id: string, patch: Partial<SessionTurnDebugRow>): void {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (!MUTABLE_COLUMNS.has(key)) continue
      sets.push(`${key} = ?`)
      vals.push(value)
    }
    if (sets.length === 0) return
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString(), id)
    this.stmt(`UPDATE session_turn_debug SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  findByTurn(sessionId: string, turnIndex: number): SessionTurnDebugRow | null {
    return (this.stmt(
      "SELECT * FROM session_turn_debug WHERE session_id = ? AND turn_index = ?",
    ).get(sessionId, turnIndex) as SessionTurnDebugRow | undefined) ?? null
  }

  findById(id: string): SessionTurnDebugRow | null {
    return (this.stmt(
      "SELECT * FROM session_turn_debug WHERE id = ?",
    ).get(id) as SessionTurnDebugRow | undefined) ?? null
  }

  /** Nearest earlier recorded turn — powers the identity-switch diff. */
  findPrevious(sessionId: string, turnIndex: number): SessionTurnDebugRow | null {
    return (this.stmt(`
      SELECT * FROM session_turn_debug
       WHERE session_id = ? AND turn_index < ?
       ORDER BY turn_index DESC LIMIT 1
    `).get(sessionId, turnIndex) as SessionTurnDebugRow | undefined) ?? null
  }

  /** Newest first. Large text columns are intentionally excluded. */
  listSummaries(sessionId: string): SessionTurnDebugSummaryRow[] {
    return this.stmt(`
      SELECT id, session_id, turn_index, user_message_id, assistant_message_id,
             started_at, ended_at, status, model, effort, identity,
             role_revision, usage, ttft_ms, duration_ms, error,
             CASE WHEN role_card IS NOT NULL AND role_card <> '' THEN 1 ELSE 0 END AS has_switch
        FROM session_turn_debug
       WHERE session_id = ?
       ORDER BY turn_index DESC
    `).all(sessionId) as SessionTurnDebugSummaryRow[]
  }

  /** Keep the newest N turns (default 50, matching the inspector's retention
   *  guidance) so a long session cannot grow forever. */
  prune(sessionId: string, keep = 50): number {
    const result = this.stmt(`
      DELETE FROM session_turn_debug
       WHERE session_id = ?
         AND id NOT IN (
           SELECT id FROM session_turn_debug
            WHERE session_id = ?
            ORDER BY turn_index DESC
            LIMIT ?
         )
    `).run(sessionId, sessionId, Math.max(1, keep))
    return result.changes
  }

  deleteBySession(sessionId: string): void {
    this.stmt("DELETE FROM session_turn_debug WHERE session_id = ?").run(sessionId)
  }
}