// Transcript marker for a delivered identity switch (v59, UI-only).
//
// The role card itself never lands in the DB — the stored user message stays
// raw (see prompt-reminder.ts). This row exists so the transcript can show
// WHEN an identity took effect, with the whole pack collapsible.
//
// Cache discipline: the row is display-only. It is excluded from context
// rebuilding (is_compressed = 1) and never reaches the provider transcript,
// whose continuity is owned by resume. Idempotent per (session, revision) so a
// transcript-loss re-delivery does not duplicate the marker.

import crypto from "crypto"
import type Database from "better-sqlite3"
import { expertName } from "@octopus/shared"
import type { SessionRoleState } from "../../db/dao/session-cache-context-dao"
import { resolveCloneInfo } from "./clone-resolver"

export interface RoleSwitchEventPayload {
  kind: "clone" | "reset"
  id: string | null
  displayName: string | null
  revision: number
  /** The full role card exactly as delivered (岗位包全文). */
  card: string
}

export function roleSwitchEventPayload(state: SessionRoleState, card: string): RoleSwitchEventPayload {
  if (!state.activeExpert) {
    return { kind: "reset", id: null, displayName: null, revision: state.revision, card }
  }
  const displayName = state.activeKind === "clone"
    ? (resolveCloneInfo(state.activeExpert)?.display_name ?? state.activeExpert)
    : expertName(state.activeExpert)
  return { kind: "clone", id: state.activeExpert, displayName, revision: state.revision, card }
}

export function appendRoleSwitchEvent(
  db: Database.Database,
  sessionId: string,
  payload: RoleSwitchEventPayload,
): void {
  const marker = `"role_revision":${payload.revision}`
  const existing = db.prepare(
    "SELECT 1 FROM messages WHERE session_id = ? AND type = 'role-switch' AND metadata LIKE ? LIMIT 1",
  ).get(sessionId, `%${marker}%`)
  if (existing) return

  // Sit right after the turn's user message (before the answer) so the marker
  // reads as "这一轮起换了身份".
  const lastUser = db.prepare(
    "SELECT created_at FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
  ).get(sessionId) as { created_at: string } | undefined
  const base = lastUser ? Date.parse(lastUser.created_at) : Number.NaN
  const at = new Date(Number.isFinite(base) ? base + 1 : Date.now()).toISOString()

  const content = payload.displayName
    ? `已切换分身身份 · ${payload.displayName}`
    : "已解除分身身份"

  db.prepare(`
    INSERT INTO messages
      (id, session_id, role, content, type, metadata, tool_calls, is_summary, is_compressed, is_edited, source, created_at)
    VALUES (?, ?, 'system', ?, 'role-switch', ?, NULL, 0, 1, 0, 'main', ?)
  `).run(
    crypto.randomUUID(), sessionId, content,
    JSON.stringify({ displayType: "role-switch", role_revision: payload.revision, role_switch: payload }),
    at,
  )
}