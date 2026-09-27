import type Database from "better-sqlite3"
import { BaseDAO } from "./base"
import type { SessionRow, MessageRow, PaginatedResult } from "../types"
import { segIndex, buildFtsMatch, bm25ToScore } from "../../cjk-segmenter"

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

  insertSession(row: Omit<SessionRow, "is_active" | "is_deleted" | "perspective_clone_name" | "last_message_at" | "scope_id" | "provider_session_id"> & {
    is_active?: number; is_deleted?: number; perspective_clone_name?: string | null;
    scope_id?: string | null; provider_session_id?: string | null
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO sessions (id, org, title, clone_name, perspective_clone_name, session_type, is_active, is_deleted, scope_id, provider_session_id, last_message_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.org, row.title, row.clone_name,
      row.perspective_clone_name ?? null, row.session_type,
      row.is_active ?? 1, row.is_deleted ?? 0,
      row.scope_id ?? null, row.provider_session_id ?? null,
      null,
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

  insertMessage(row: Omit<MessageRow, "is_summary" | "is_compressed" | "is_edited" | "tool_calls" | "type" | "metadata" | "source"> & {
    is_summary?: number; is_compressed?: number; is_edited?: number; tool_calls?: string | null;
    type?: string; metadata?: string | null; source?: string
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO messages (id, session_id, role, content, type, metadata, tool_calls, is_summary, is_compressed, is_edited, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.session_id, row.role, row.content,
      row.type ?? 'text', row.metadata ?? null,
      row.tool_calls ?? null, row.is_summary ?? 0,
      row.is_compressed ?? 0, row.is_edited ?? 0, row.source ?? 'main', row.created_at,
    )
  }

  findMessageById(id: string): MessageRow | null {
    return (this.stmt("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow) ?? null
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

  /**
   * FTS5 search over session summaries (jieba 预分词后中文可命中)。
   *
   * 语义（KB P0 静默路径修复）：
   * - MATCH 表达式由 buildFtsMatch 逐 token 转义构造 —— 中文/引号/NEAR 等一律
   *   是字符串字面量，语法永远合法；不再有「不命中也不报错」的降级。
   * - AND 无结果时 OR 兜底（切词歧义腿）。
   * - 空/纯标点查询 → 显式空数组。
   * - 真正的 DB 异常（表缺失/索引损坏）直接上抛，由调用方（REST 层）决定
   *   rebuild + 重试，不在这里吞。
   * - score 为 bm25() 映射出的 (0,1) 真实相关度。
   * - summary 经 rowid 关联回 messages 原文（索引里存的是切词串，展示必须
   *   是原文）；session_title 同理回连 sessions。
   */
  searchSessionMemory(query: string, limit: number = 3, source?: string, org?: string): Array<{
    session_id: string; summary: string; session_title: string; created_at: string; source: string; score: number
  }> {
    const andMatch = buildFtsMatch(query, 'and', 'summary')
    if (!andMatch) return []

    const rows = this.runSessionFts(andMatch, limit, source, org)
    if (rows.length > 0) return rows

    const orMatch = buildFtsMatch(query, 'or', 'summary')
    if (!orMatch || orMatch === andMatch) return []
    return this.runSessionFts(orMatch, limit, source, org)
  }

  private runSessionFts(match: string, limit: number, source?: string, org?: string): Array<{
    session_id: string; summary: string; session_title: string; created_at: string; source: string; score: number
  }> {
    let sql = `
      SELECT session_memory_fts.session_id AS session_id,
             COALESCE(m.content, session_memory_fts.summary) AS summary,
             COALESCE(s.title, session_memory_fts.session_title) AS session_title,
             session_memory_fts.created_at AS created_at,
             session_memory_fts.source AS source,
             bm25(session_memory_fts) AS rank
      FROM session_memory_fts
      LEFT JOIN messages m ON m.rowid = session_memory_fts.rowid
      LEFT JOIN sessions s ON s.id = session_memory_fts.session_id
      WHERE session_memory_fts MATCH ?`
    const params: unknown[] = [match]

    if (source) {
      sql += ` AND session_memory_fts.source = ?`
      params.push(source)
    }
    if (org) {
      sql += ` AND s.org = ?`
      params.push(org)
    }

    sql += ` ORDER BY rank LIMIT ?`
    params.push(limit)

    const rows = this.stmt(sql).all(...params) as Array<{
      session_id: string; summary: string; session_title: string; created_at: string; source: string; rank: number
    }>
    return rows.map(({ rank, ...rest }) => ({ ...rest, score: bm25ToScore(rank) }))
  }

  /**
   * Rebuild session_memory_fts from messages(is_summary=1).
   * 索引内容为 jieba 预分词串；rowid 显式对齐 messages.rowid 供查询侧回连原文。
   */
  rebuildFtsIndex(): number {
    this.stmt("DELETE FROM session_memory_fts").run()
    const summaryMessages = this.stmt(`
      SELECT m.rowid AS msg_rowid, m.session_id, m.content, m.created_at, m.source, s.title
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.is_summary = 1
      ORDER BY m.created_at
    `).all() as Array<{ msg_rowid: number; session_id: string; content: string; created_at: string; source: string; title: string }>

    const insertFts = this.stmt(
      "INSERT INTO session_memory_fts (rowid, session_id, summary, session_title, created_at, source) VALUES (?, ?, ?, ?, ?, ?)"
    )
    for (const msg of summaryMessages) {
      insertFts.run(
        msg.msg_rowid, msg.session_id,
        segIndex(msg.content), segIndex(msg.title ?? ''),
        msg.created_at, msg.source || 'main',
      )
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

  insertSummaryMessage(id: string, sessionId: string, content: string, createdAt: string, source: string = 'main'): Database.RunResult {
    return this.stmt(`
      INSERT INTO messages (id, session_id, role, content, created_at, is_summary, is_compressed, source)
      VALUES (?, ?, 'system', ?, ?, 1, 0, ?)
    `).run(id, sessionId, content, createdAt, source)
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
    type: string; metadata: string | null;
    tool_calls: string | null; is_summary: number; is_compressed: number; created_at: string;
  }> {
    let sql = `SELECT * FROM messages WHERE session_id = ?`
    const params: unknown[] = [sessionId]
    if (cursor) { sql += ` AND created_at < ?`; params.push(cursor) }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit)
    return this.stmt(sql).all(...params) as Array<{
      id: string; session_id: string; role: string; content: string;
      type: string; metadata: string | null;
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

  // ── Clone session methods ────────────────────────────────────────

  /** Update provider_session_id for SDK resume */
  updateProviderSession(id: string, providerSessionId: string): Database.RunResult {
    return this.stmt(
      "UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?"
    ).run(providerSessionId, new Date().toISOString(), id)
  }

  /** Insert message with type + metadata (clone-specific) */
  insertCloneMessage(row: {
    id: string; session_id: string; role: string;
    type: string; content: string; metadata: string | null;
    created_at: string;
  }): Database.RunResult {
    return this.stmt(`
      INSERT INTO messages (id, session_id, role, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.session_id, row.role, row.type,
      row.content, row.metadata, row.created_at,
    )
  }

  /** Whether the session has an unfinished streaming assistant partial
   *  (metadata JSON written by the clone chat route with streaming:true).
   *  LIKE substring is acceptable here: the flag key is only ever written by
   *  that route's own JSON.stringify of a controlled object shape. */
  hasStreamingMessage(sessionId: string): boolean {
    const row = this.stmt(
      `SELECT 1 FROM messages WHERE session_id = ? AND metadata LIKE '%"streaming":true%' LIMIT 1`,
    ).get(sessionId)
    return row !== undefined
  }

  /** All streaming partial rows across sessions (server-startup orphan sweep). */
  findStreamingMessages(): Array<{ id: string; metadata: string }> {
    return this.stmt(
      `SELECT id, metadata FROM messages WHERE metadata LIKE '%"streaming":true%'`,
    ).all() as Array<{ id: string; metadata: string }>
  }

  /** Find sessions by clone_name */
  findByClone(cloneName: string, filters?: {
    org?: string; limit?: number; cursor?: string
  }): { items: SessionRow[]; has_more: boolean; next_cursor: string | null } {
    const limit = filters?.limit ?? 20
    let sql = `SELECT * FROM sessions WHERE clone_name = ? AND is_deleted = 0`
    const params: unknown[] = [cloneName]
    if (filters?.org) { sql += ` AND org = ?`; params.push(filters.org) }
    if (filters?.cursor) { sql += ` AND created_at < ?`; params.push(filters.cursor) }
    sql += ` ORDER BY last_message_at DESC, created_at DESC LIMIT ?`
    params.push(limit + 1)

    const rows = this.stmt(sql).all(...params) as SessionRow[]
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    return { items, has_more: hasMore, next_cursor: hasMore ? items[items.length - 1].created_at : null }
  }
}
