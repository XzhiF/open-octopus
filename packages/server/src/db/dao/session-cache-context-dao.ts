import crypto from "crypto"
import type Database from "better-sqlite3"
import { BaseDAO } from "./base"

export interface PromptSnapshot {
  systemPrompt: string
  promptHash: string
}

export interface SessionRoleState {
  activeExpert: string | null
  revision: number
  deliveredRevision: number
}

/**
 * Session-scoped cache-stability state (schema v56).
 *
 * The provider prompt cache is a prefix cache; this DAO is the persistence
 * seam for the two parts that must stay byte-identical across resumed turns:
 *   - the system prompt (persona + memory snapshot, frozen on first use)
 *   - the expert roster registered as SDK `agents` metadata
 *
 * Generic across agent sessions (sessions) and workspace task chats
 * (chat_sessions) — ids are UUIDs, so one pair of tables serves both.
 */
export class SessionCacheContextDAO extends BaseDAO {
  constructor(db: Database.Database) {
    super(db)
  }

  getPromptSnapshot(sessionId: string): PromptSnapshot | null {
    const row = this.stmt(
      "SELECT system_prompt, prompt_hash FROM session_prompt_snapshots WHERE session_id = ?",
    ).get(sessionId) as { system_prompt: string; prompt_hash: string } | undefined
    return row ? { systemPrompt: row.system_prompt, promptHash: row.prompt_hash } : null
  }

  savePromptSnapshot(sessionId: string, systemPrompt: string): PromptSnapshot {
    const promptHash = hashPrompt(systemPrompt)
    const now = new Date().toISOString()
    this.stmt(`
      INSERT INTO session_prompt_snapshots (session_id, system_prompt, prompt_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        system_prompt = excluded.system_prompt,
        prompt_hash   = excluded.prompt_hash,
        updated_at    = excluded.updated_at
    `).run(sessionId, systemPrompt, promptHash, now, now)
    return { systemPrompt, promptHash }
  }

  /** Return the frozen system prompt, building + persisting it on first use. */
  getOrCreatePromptSnapshot(sessionId: string, build: () => string): PromptSnapshot {
    const existing = this.getPromptSnapshot(sessionId)
    if (existing) return existing
    const content = build()
    // A transient empty build (missing clone file during startup, test double)
    // must not lock an empty prompt in forever — retry next turn.
    if (!content) return { systemPrompt: "", promptHash: hashPrompt("") }
    return this.savePromptSnapshot(sessionId, content)
  }

  /** Drop a snapshot (session reset / explicit memory refresh). */
  invalidatePromptSnapshot(sessionId: string): void {
    this.stmt("DELETE FROM session_prompt_snapshots WHERE session_id = ?").run(sessionId)
  }

  getExpertRoster(sessionId: string): string[] {
    const row = this.stmt(
      "SELECT experts FROM session_expert_rosters WHERE session_id = ?",
    ).get(sessionId) as { experts: string } | undefined
    if (!row) return []
    try {
      const parsed = JSON.parse(row.experts) as unknown
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
    } catch {
      return []
    }
  }

  /** Persist the roster (order-preserving, de-duplicated). */
  saveExpertRoster(sessionId: string, experts: readonly string[]): string[] {
    const next = dedupe(experts)
    this.stmt(`
      INSERT INTO session_expert_rosters (session_id, experts, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        experts = excluded.experts,
        updated_at = excluded.updated_at
    `).run(sessionId, JSON.stringify(next), new Date().toISOString())
    return next
  }

  /** Union new expert ids into the session roster; returns the stable roster. */
  addExpertsToRoster(sessionId: string, ids: readonly string[]): string[] {
    const current = this.getExpertRoster(sessionId)
    const merged = dedupe([...current, ...ids])
    if (merged.length === current.length) return current
    return this.saveExpertRoster(sessionId, merged)
  }

  // ── Role state (session-level expert identity) ────────────────────

  getRoleState(sessionId: string): SessionRoleState {
    const row = this.stmt(
      "SELECT active_expert, revision, delivered_revision FROM session_role_states WHERE session_id = ?",
    ).get(sessionId) as {
      active_expert: string | null
      revision: number
      delivered_revision: number
    } | undefined
    if (!row) return { activeExpert: null, revision: 0, deliveredRevision: 0 }
    return {
      activeExpert: row.active_expert,
      revision: row.revision,
      deliveredRevision: row.delivered_revision,
    }
  }

  /**
   * Set the session's active expert (null = back to the base role).
   * Returns the new state. Selecting the same non-null expert twice is a
   * no-op (no needless role card). Clearing an already-clear role is a no-op.
   */
  setActiveExpert(sessionId: string, expertId: string | null): SessionRoleState {
    const current = this.getRoleState(sessionId)
    if (current.activeExpert === expertId) return current
    const revision = current.revision + 1
    const now = new Date().toISOString()
    this.stmt(`
      INSERT INTO session_role_states (session_id, active_expert, revision, delivered_revision, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        active_expert = excluded.active_expert,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(sessionId, expertId, revision, current.deliveredRevision, now)
    return { activeExpert: expertId, revision, deliveredRevision: current.deliveredRevision }
  }

  /** Mark the provider transcript as having received the current role card. */
  markRoleDelivered(sessionId: string, revision: number): void {
    this.stmt(`
      UPDATE session_role_states
      SET delivered_revision = MAX(delivered_revision, ?), updated_at = ?
      WHERE session_id = ?
    `).run(revision, new Date().toISOString(), sessionId)
  }

  /** A provider session was dropped: the role card must be re-injected. */
  resetRoleDelivery(sessionId: string): void {
    this.stmt(
      "UPDATE session_role_states SET delivered_revision = 0, updated_at = ? WHERE session_id = ?",
    ).run(new Date().toISOString(), sessionId)
  }

  /** Remove both cache-stability rows when a session is physically deleted. */
  deleteSession(sessionId: string): void {
    this.stmt("DELETE FROM session_prompt_snapshots WHERE session_id = ?").run(sessionId)
    this.stmt("DELETE FROM session_expert_rosters WHERE session_id = ?").run(sessionId)
    this.stmt("DELETE FROM session_role_states WHERE session_id = ?").run(sessionId)
  }
}

export function hashPrompt(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16)
}

function dedupe(ids: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of ids) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
