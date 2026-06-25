import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { ChatSessionRow, ChatMessageRow } from "../types"

/**
 * ChatDAO — chat sessions and messages.
 * Covers: chat_sessions, chat_messages tables.
 */
export class ChatDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── chat_sessions ───────────────────────────────────────────────

  findSessionById(id: string): ChatSessionRow | null {
    return (this.stmt("SELECT * FROM chat_sessions WHERE id = ?").get(id) as ChatSessionRow) ?? null
  }

  listSessions(workspaceId: string): ChatSessionRow[] {
    return this.stmt(
      "SELECT * FROM chat_sessions WHERE workspace_id = ? ORDER BY updated_at DESC"
    ).all(workspaceId) as ChatSessionRow[]
  }

  insertSession(row: Omit<ChatSessionRow, "is_active" | "provider" | "provider_session_id"> & {
    is_active?: number; provider?: string; provider_session_id?: string | null
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO chat_sessions (id, workspace_id, title, is_active, created_at, updated_at, provider, provider_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.workspace_id, row.title, row.is_active ?? 1,
      row.created_at, row.updated_at, row.provider ?? "claude",
      row.provider_session_id ?? null,
    )
  }

  updateSession(id: string, fields: Partial<ChatSessionRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(id)
    return this.stmt(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  updateProviderSession(id: string, providerSessionId: string): Database.RunResult {
    return this.stmt(
      "UPDATE chat_sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?"
    ).run(providerSessionId, new Date().toISOString(), id)
  }

  deleteSession(id: string): Database.RunResult {
    return this.stmt("DELETE FROM chat_sessions WHERE id = ?").run(id)
  }

  deleteSessionsByWorkspace(workspaceId: string): Database.RunResult {
    return this.stmt("DELETE FROM chat_sessions WHERE workspace_id = ?").run(workspaceId)
  }

  // ── chat_messages ───────────────────────────────────────────────

  findMessagesBySession(sessionId: string): ChatMessageRow[] {
    return this.stmt(
      "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId) as ChatMessageRow[]
  }

  findLatestMessages(sessionId: string, limit: number): ChatMessageRow[] {
    return this.stmt(
      "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?"
    ).all(sessionId, limit) as ChatMessageRow[]
  }

  findOlderMessages(sessionId: string, limit: number, beforeCreatedAt: string): ChatMessageRow[] {
    return this.stmt(
      "SELECT * FROM chat_messages WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?"
    ).all(sessionId, beforeCreatedAt, limit) as ChatMessageRow[]
  }

  findMessageById(id: string): ChatMessageRow | null {
    return (this.stmt("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow) ?? null
  }

  countMessages(sessionId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as count FROM chat_messages WHERE session_id = ?"
    ).get(sessionId) as { count: number }).count
  }

  insertMessage(row: Omit<ChatMessageRow, "type"> & { type?: string }): Database.RunResult {
    return this.stmt(`
      INSERT INTO chat_messages (id, session_id, role, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.session_id, row.role, row.type ?? "text",
      row.content, row.metadata ?? null, row.created_at,
    )
  }

  updateMessageMetadata(id: string, metadata: string): Database.RunResult {
    return this.stmt("UPDATE chat_messages SET metadata = ? WHERE id = ?").run(metadata, id)
  }

  deleteMessagesBySession(sessionId: string): Database.RunResult {
    return this.stmt("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId)
  }
}
