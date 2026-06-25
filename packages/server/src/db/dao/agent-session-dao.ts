import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { SessionRow, MessageRow, PaginatedResult } from "../types"

/**
 * AgentSessionDAO — agent session and message management.
 * Covers: sessions, messages, session_memory_fts tables.
 */
export class AgentSessionDAO extends BaseDAO {
  constructor(db: Database.Database) { super(db) }

  // ── sessions ────────────────────────────────────────────────────

  findById(id: string): SessionRow | null {
    return (this.stmt("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow) ?? null
  }

  findByOrg(org: string, filters?: {
    clone?: string; session_type?: string; limit?: number; cursor?: string
  }): { items: SessionRow[]; has_more: boolean; next_cursor: string | null } {
    const limit = filters?.limit ?? 20
    let sql = `SELECT * FROM sessions WHERE org = ? AND is_deleted = 0`
    const params: unknown[] = [org]
    if (filters?.clone) { sql += ` AND clone_name = ?`; params.push(filters.clone) }
    if (filters?.session_type) { sql += ` AND session_type = ?`; params.push(filters.session_type) }
    if (filters?.cursor) { sql += ` AND created_at < ?`; params.push(filters.cursor) }
    sql += ` ORDER BY last_message_at DESC, created_at DESC LIMIT ?`
    params.push(limit + 1)

    const rows = this.stmt(sql).all(...params) as SessionRow[]
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    return { items, has_more: hasMore, next_cursor: hasMore ? items[items.length - 1].created_at : null }
  }

  insertSession(row: Omit<SessionRow, "is_active" | "is_deleted" | "perspective_clone_name" | "last_message_at"> & {
    is_active?: number; is_deleted?: number; perspective_clone_name?: string | null
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO sessions (id, org, title, clone_name, perspective_clone_name, session_type, is_active, is_deleted, last_message_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.title, row.clone_name,
      row.perspective_clone_name ?? null, row.session_type,
      row.is_active ?? 1, row.is_deleted ?? 0, null,
      row.created_at, row.updated_at,
    )
  }

  updateSession(id: string, fields: Partial<SessionRow>): Database.RunResult {
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
    return this.stmt(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  softDelete(id: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE sessions SET is_deleted = 1, is_active = 0, updated_at = ? WHERE id = ?"
    ).run(now, id)
  }

  updateLastMessageAt(id: string, timestamp: string): Database.RunResult {
    return this.stmt(
      "UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?"
    ).run(timestamp, timestamp, id)
  }

  // ── messages ────────────────────────────────────────────────────

  findMessagesBySession(sessionId: string, filters?: {
    limit?: number; cursor?: string
  }): { items: MessageRow[]; has_more: boolean; next_cursor: string | null } {
    const limit = filters?.limit ?? 50
    let sql = `SELECT * FROM messages WHERE session_id = ?`
    const params: unknown[] = [sessionId]
    if (filters?.cursor) { sql += ` AND created_at < ?`; params.push(filters.cursor) }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit + 1)

    const rows = this.stmt(sql).all(...params) as MessageRow[]
    const hasMore = rows.length > limit
    const items = (hasMore ? rows.slice(0, limit) : rows).reverse()
    return { items, has_more: hasMore, next_cursor: hasMore ? rows[limit - 1]?.created_at : null }
  }

  findAllMessages(sessionId: string): MessageRow[] {
    return this.stmt(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC"
    ).all(sessionId) as MessageRow[]
  }

  countMessages(sessionId: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as count FROM messages WHERE session_id = ?"
    ).get(sessionId) as { count: number }).count
  }

  insertMessage(row: Omit<MessageRow, "is_summary" | "is_compressed" | "is_edited" | "tool_calls"> & {
    is_summary?: number; is_compressed?: number; is_edited?: number; tool_calls?: string | null
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO messages (id, session_id, role, content, tool_calls, is_summary, is_compressed, is_edited, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.session_id, row.role, row.content,
      row.tool_calls ?? null, row.is_summary ?? 0,
      row.is_compressed ?? 0, row.is_edited ?? 0, row.created_at,
    )
  }

  updateMessage(id: string, fields: Partial<MessageRow>): Database.RunResult {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    if (sets.length === 0) return { changes: 0, lastInsertRowid: 0 }
    vals.push(id)
    return this.stmt(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
  }

  // ── session_memory_fts ──────────────────────────────────────────

  searchSessionMemory(query: string, limit: number = 3): Array<{
    session_id: string; summary: string; session_title: string; created_at: string
  }> {
    try {
      return this.stmt(`
        SELECT session_id, summary, session_title, created_at
        FROM session_memory_fts WHERE session_memory_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(query, limit) as Array<{
        session_id: string; summary: string; session_title: string; created_at: string
      }>
    } catch {
      // FTS degraded: fallback to LIKE
      return this.stmt(`
        SELECT session_id, summary, session_title, created_at
        FROM session_memory_fts WHERE summary LIKE ?
        LIMIT ?
      `).all(`%${query}%`, limit) as Array<{
        session_id: string; summary: string; session_title: string; created_at: string
      }>
    }
  }

  rebuildFtsIndex(): number {
    this.stmt("DELETE FROM session_memory_fts").run()
    const summaryMessages = this.stmt(`
      SELECT m.rowid, m.session_id, m.content, m.created_at, s.title
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.is_summary = 1
      ORDER BY m.created_at
    `).all() as Array<{ rowid: number; session_id: string; content: string; created_at: string; title: string }>

    const insertFts = this.stmt(
      "INSERT INTO session_memory_fts (session_id, summary, session_title, created_at) VALUES (?, ?, ?, ?)"
    )
    for (const msg of summaryMessages) {
      insertFts.run(msg.session_id, msg.content, msg.title, msg.created_at)
    }
    return summaryMessages.length
  }

  // ── Additional methods for service migrations ────────────────────

  findSessionById(id: string): SessionRow | null {
    return (this.stmt("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow) ?? null
  }

  countUncompressedMessages(sessionId: string): { count: number; total_chars: number } {
    return this.stmt(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(LENGTH(content)), 0) as total_chars
      FROM messages
      WHERE session_id = ?
        AND is_compressed = 0
    `).get(sessionId) as { count: number; total_chars: number }
  }

  findUncompressedMessagesOrdered(sessionId: string): Array<{ id: string; role: string; content: string; created_at: string }> {
    return this.stmt(`
      SELECT id, role, content, created_at
      FROM messages
      WHERE session_id = ?
        AND is_compressed = 0
      ORDER BY created_at ASC
    `).all(sessionId) as Array<{ id: string; role: string; content: string; created_at: string }>
  }

  markMessagesCompressed(ids: string[]): Database.RunResult {
    if (ids.length === 0) return { changes: 0, lastInsertRowid: 0 }
    const placeholders = ids.map(() => "?").join(",")
    return this.stmt(`
      UPDATE messages SET is_compressed = 1 WHERE id IN (${placeholders})
    `).run(...ids)
  }

  insertSummaryMessage(id: string, sessionId: string, content: string, createdAt: string): Database.RunResult {
    return this.stmt(`
      INSERT INTO messages (id, session_id, role, content, created_at, is_summary, is_compressed)
      VALUES (?, ?, 'system', ?, ?, 1, 0)
    `).run(id, sessionId, content, createdAt)
  }

  findSummaryMessage(sessionId: string): { content: string } | null {
    return (this.stmt(`
      SELECT content FROM messages
      WHERE session_id = ? AND is_summary = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as { content: string }) ?? null
  }

  findRecentActiveMessages(sessionId: string, limit: number): Array<{ role: string; content: string }> {
    return this.stmt(`
      SELECT role, content FROM messages
      WHERE session_id = ? AND is_compressed = 0 AND is_summary = 0
      ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit) as Array<{ role: string; content: string }>
  }

  countActiveSessions(org: string): number {
    return (this.stmt(
      "SELECT COUNT(*) as count FROM sessions WHERE is_active = 1 AND is_deleted = 0 AND org = ?"
    ).get(org) as { count: number }).count
  }

  findLatestMessageTimestamp(): { last_at: string | null } | null {
    return (this.stmt("SELECT MAX(created_at) as last_at FROM messages").get() as { last_at: string | null }) ?? null
  }

  findMessagesBySessionWithCursor(sessionId: string, limit: number, cursor?: string): Array<{
    id: string; session_id: string; role: string; content: string;
    tool_calls: string | null; is_summary: number; is_compressed: number; created_at: string;
  }> {
    let sql = `SELECT * FROM messages WHERE session_id = ?`
    const params: unknown[] = [sessionId]
    if (cursor) { sql += ` AND created_at < ?`; params.push(cursor) }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit)
    return this.stmt(sql).all(...params) as Array<{
      id: string; session_id: string; role: string; content: string;
      tool_calls: string | null; is_summary: number; is_compressed: number; created_at: string;
    }>
  }

  updateSessionByOrg(id: string, org: string, fields: Record<string, unknown>): Database.RunResult {
    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(v)
    }
    vals.push(id, org)
    return this.stmt(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ? AND org = ? AND is_deleted = 0`).run(...vals)
  }

  softDeleteByOrg(id: string, org: string): Database.RunResult {
    const now = new Date().toISOString()
    return this.stmt(
      "UPDATE sessions SET is_deleted = 1, is_active = 0, updated_at = ? WHERE id = ? AND org = ? AND is_deleted = 0"
    ).run(now, id, org)
  }
}
