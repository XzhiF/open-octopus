import { BasePgDAO, type PgSql } from "./base-pg"
import type { SessionRow, MessageRow } from "../types"
import { bool, flag, iso, isoOrNull, jsonStr, num } from "./pg-mappers"
import { queryTokens, scoreNorm } from "./query-tokens"

/**
 * AgentSessionDAO — agent session and message management.
 * Covers: sessions, messages tables (P1 B3: better-sqlite3 → postgres.js).
 *
 * 行形态契约（pg-mappers 出口归一，旧 Row 接口不动直到 B6）：
 *   - sessions.is_active/is_deleted、messages.is_summary/is_compressed/is_edited
 *     PG boolean ↔ 旧 0/1 number（写侧必须显式 bool() —— postgres.js 把 JS number
 *     0/1 绑进 boolean 列会静默存 false）。
 *   - created_at/updated_at/last_message_at: PG timestamptz(Date) ↔ 旧 ISO 文本。
 *   - metadata/tool_calls: PG jsonb(解析后 object) ↔ 旧 JSON 文本
 *     （读回是 jsonb 规范化文本：键序/空白与写入串可能不同）。
 *   - messages.metadata 的 `"streaming":true` 探测由旧 LIKE 子串改为
 *     `metadata->>'streaming' = 'true'`（jsonb::text 会把冒号后补空格，LIKE 形态
 *     在 PG 不可移植；JSON 语义判定等价）。
 *
 * FTS 面（P1 B3 段2 终态）：SQLite 侧 session_memory_fts 虚表 + jieba 预分词影子列
 *   整体退役 —— PG 侧不再有影子表；检索打在 messages.content（is_summary=true）
 *   真表的 pg_search BM25 索引 idx_messages_bm25 上（&&& 全 token 命中 +
 *   paradedb.score 降序）；tantivy 解析器抛错（a:b/括号等语法 token）或零命中时
 *   退回 ILIKE 两段式（AND 保精度 → OR 保召回，见 db/pg/README.md B3 节）。
 *   rebuildFtsIndex() 语义为「幂等计数」（BM25 索引由 PG 引擎自动维护）。
 */

/** ILIKE 模式串转义（% _ 与反斜杠 —— PG LIKE 默认转义符是反斜杠）。 */
function likePattern(token: string): string {
  return `%${token.replace(/[%_\\]/g, '\\$&')}%`
}

/** sessions 表的 boolean 列（动态 SET 时需要 0/1 → bool 翻面）。 */
const SESSION_BOOL_COLS = new Set(["is_active", "is_deleted"])
const MSG_BOOL_COLS = new Set(["is_summary", "is_compressed", "is_edited"])
/**
 * messages 表的 jsonb 列。postgres.js 实测（octopus-pg / jsonb probe）：JS string
 * 绑进 jsonb 参数（含 `?::jsonb` 显式转换 —— PG 把参数类型推断为 jsonb 本身）会被
 * 再 JSON.stringify 成 **jsonb 字符串标量**（jsonb_typeof='string'），`metadata->>
 * 'streaming'` 等算子全瞎。唯一正确姿势：绑前 JSON.parse 成对象。读侧 jsonStr 归一
 * 回旧契约（键序/空白为 jsonb 规范化文本，调用方本就 JSON.parse）。
 */
const MSG_JSON_COLS = new Set(["metadata", "tool_calls"])

/** JSON 文本 → 对象（jsonb 参数专用）；非文本原样透传，解析失败退回原文。 */
function jsonbParam(v: unknown): unknown {
  if (typeof v !== "string") return v
  try { return JSON.parse(v) } catch { return v }
}

interface SessionPgRow {
  id: string
  org: string
  title: string
  clone_name: string | null
  perspective_clone_name: string | null
  session_type: string
  is_active: boolean | number
  is_deleted: boolean | number
  scope_id: string | null
  provider_session_id: string | null
  last_message_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

interface MessagePgRow {
  id: string
  session_id: string
  role: string
  content: string
  type: string
  metadata: unknown
  tool_calls: unknown
  is_summary: boolean | number
  is_compressed: boolean | number
  is_edited: boolean | number
  source: string
  created_at: Date | string
}

function fromSession(r: SessionPgRow): SessionRow {
  return {
    id: r.id,
    org: r.org,
    title: r.title,
    clone_name: r.clone_name,
    perspective_clone_name: r.perspective_clone_name,
    session_type: r.session_type,
    is_active: flag(r.is_active),
    is_deleted: flag(r.is_deleted),
    scope_id: r.scope_id,
    provider_session_id: r.provider_session_id,
    last_message_at: isoOrNull(r.last_message_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  }
}

function fromMessage(r: MessagePgRow): MessageRow {
  return {
    id: r.id,
    session_id: r.session_id,
    role: r.role,
    content: r.content,
    type: r.type,
    metadata: jsonStr(r.metadata),
    tool_calls: jsonStr(r.tool_calls),
    is_summary: flag(r.is_summary),
    is_compressed: flag(r.is_compressed),
    is_edited: flag(r.is_edited),
    source: r.source,
    created_at: iso(r.created_at),
  }
}

export class AgentSessionDAO extends BasePgDAO {
  constructor(db: PgSql) { super(db) }

  // ── sessions ────────────────────────────────────────────────────

  async findById(id: string): Promise<SessionRow | null> {
    const r = await this.q1<SessionPgRow>("SELECT * FROM sessions WHERE id = ?", [id])
    return r ? fromSession(r) : null
  }

  async findByOrg(org: string, filters?: {
    clone?: string; session_type?: string; limit?: number; cursor?: string
  }): Promise<{ items: SessionRow[]; has_more: boolean; next_cursor: string | null }> {
    const limit = filters?.limit ?? 20
    let sql = `SELECT * FROM sessions WHERE org = ? AND is_deleted = false`
    const params: unknown[] = [org]
    if (filters?.clone) { sql += ` AND clone_name = ?`; params.push(filters.clone) }
    if (filters?.session_type) { sql += ` AND session_type = ?`; params.push(filters.session_type) }
    if (filters?.cursor) { sql += ` AND created_at < ?`; params.push(filters.cursor) }
    // NULLS LAST：SQLite 把 NULL 当最小值排 DESC 末位；PG DESC 默认 NULL 首位
    sql += ` ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT ?`
    params.push(limit + 1)

    const rows = (await this.q<SessionPgRow>(sql, params)).map(fromSession)
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    return { items, has_more: hasMore, next_cursor: hasMore ? items[items.length - 1].created_at : null }
  }

  async insertSession(row: Omit<SessionRow, "is_active" | "is_deleted" | "perspective_clone_name" | "last_message_at" | "scope_id" | "provider_session_id"> & {
    is_active?: number; is_deleted?: number; perspective_clone_name?: string | null;
    scope_id?: string | null; provider_session_id?: string | null
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO sessions (id, org, title, clone_name, perspective_clone_name, session_type, is_active, is_deleted, scope_id, provider_session_id, last_message_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.org, row.title, row.clone_name,
      row.perspective_clone_name ?? null, row.session_type,
      bool(row.is_active ?? 1), bool(row.is_deleted ?? 0),
      row.scope_id ?? null, row.provider_session_id ?? null,
      null,
      row.created_at, row.updated_at,
    ])
  }

  async updateSession(id: string, fields: Partial<SessionRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(SESSION_BOOL_COLS.has(k) ? bool(v as number) : v)
    }
    if (sets.length === 0) return { changes: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(id)
    return this.exec(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  async softDelete(id: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE sessions SET is_deleted = true, is_active = false, updated_at = ? WHERE id = ?",
      [now, id],
    )
  }

  async updateLastMessageAt(id: string, timestamp: string): Promise<{ changes: number }> {
    return this.exec(
      "UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?",
      [timestamp, timestamp, id],
    )
  }

  // ── messages ────────────────────────────────────────────────────

  async findMessagesBySession(sessionId: string, filters?: {
    limit?: number; cursor?: string
  }): Promise<{ items: MessageRow[]; has_more: boolean; next_cursor: string | null }> {
    const limit = filters?.limit ?? 50
    let sql = `SELECT * FROM messages WHERE session_id = ?`
    const params: unknown[] = [sessionId]
    if (filters?.cursor) { sql += ` AND created_at < ?`; params.push(filters.cursor) }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit + 1)

    const rows = (await this.q<MessagePgRow>(sql, params)).map(fromMessage)
    const hasMore = rows.length > limit
    const items = (hasMore ? rows.slice(0, limit) : rows).reverse()
    return { items, has_more: hasMore, next_cursor: hasMore ? rows[limit - 1]?.created_at : null }
  }

  async findAllMessages(sessionId: string): Promise<MessageRow[]> {
    const rows = await this.q<MessagePgRow>(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
      [sessionId],
    )
    return rows.map(fromMessage)
  }

  async countMessages(sessionId: string): Promise<number> {
    const r = await this.q1<{ count: number | string }>(
      "SELECT COUNT(*)::int AS count FROM messages WHERE session_id = ?",
      [sessionId],
    )
    return num(r?.count)
  }

  async insertMessage(row: Omit<MessageRow, "is_summary" | "is_compressed" | "is_edited" | "tool_calls" | "type" | "metadata" | "source"> & {
    is_summary?: number; is_compressed?: number; is_edited?: number; tool_calls?: string | null;
    type?: string; metadata?: string | null; source?: string
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO messages (id, session_id, role, content, type, metadata, tool_calls, is_summary, is_compressed, is_edited, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.session_id, row.role, row.content,
      row.type ?? 'text', jsonbParam(row.metadata) ?? null,
      jsonbParam(row.tool_calls) ?? null, bool(row.is_summary ?? 0),
      bool(row.is_compressed ?? 0), bool(row.is_edited ?? 0), row.source ?? 'main', row.created_at,
    ])
  }

  async findMessageById(id: string): Promise<MessageRow | null> {
    const r = await this.q1<MessagePgRow>("SELECT * FROM messages WHERE id = ?", [id])
    return r ? fromMessage(r) : null
  }

  async updateMessage(id: string, fields: Partial<MessageRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      sets.push(`${k} = ?`)
      vals.push(MSG_BOOL_COLS.has(k) ? bool(v as number) : MSG_JSON_COLS.has(k) ? jsonbParam(v) : v)
    }
    if (sets.length === 0) return { changes: 0 }
    vals.push(id)
    return this.exec(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  // ── 会话记忆检索（原 session_memory_fts 面） ────────────────────

  /**
   * 会话摘要检索（原 FTS5 session_memory_fts.summary 列的替身 · B3 段2 BM25 终态）。
   * 主路径：idx_messages_bm25 上 `content &&& 原查询串`（tantivy 逐 token AND，
   * CJK 文档侧单字切 —— 旧 jieba 词面命中必被字符面覆盖，召回只增不减），
   * 排序 paradedb.score DESC（越大越相关）+ created_at 兜平，score 归一 s/(1+s) 进 (0,1)。
   * 兜底路径：BM25 抛错（`a:b`/括号等 tantivy 语法）或零命中 → ILIKE 两段式
   *   （AND 保精度 → OR 保召回，token 用 queryTokens —— 非 jieba，CJK 整段子串）。
   * 语义锚点：
   *   - 空/纯标点查询 → 显式空数组；真 DB 异常上抛由 REST 层决定重试。
   *   - summary/session_title 返回原文（真表列，不存在切词串泄漏）。
   *   - source 过滤打在 messages.source；org 过滤经 sessions.org 回连。
   */
  async searchSessionMemory(query: string, limit: number = 3, source?: string, org?: string): Promise<Array<{
    session_id: string; summary: string; session_title: string; created_at: string; source: string; score: number
  }>> {
    const tokens = queryTokens(query)
    if (tokens.length === 0) return []

    try {
      let sql = `
        SELECT m.session_id AS session_id,
               m.content AS summary,
               s.title AS session_title,
               m.created_at AS created_at,
               m.source AS source,
               paradedb.score(m.id) AS score
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE m.is_summary = true AND m.content &&& ?`
      const params: unknown[] = [query]
      if (source) { sql += ` AND m.source = ?`; params.push(source) }
      if (org) { sql += ` AND s.org = ?`; params.push(org) }
      sql += ` ORDER BY paradedb.score(m.id) DESC, m.created_at DESC LIMIT ?`
      params.push(limit)

      const rows = await this.q<{
        session_id: string; summary: string; session_title: string;
        created_at: Date | string; source: string; score: unknown
      }>(sql, params)
      if (rows.length > 0) {
        return rows.map((r) => ({
          session_id: r.session_id, summary: r.summary, session_title: r.session_title,
          created_at: iso(r.created_at), source: r.source, score: scoreNorm(r.score),
        }))
      }
    } catch {
      // tantivy 解析失败 —— 走与零命中同一条 ILIKE 兜底腿
    }

    const andRows = await this.runSessionSearch(tokens, 'and', 0.9, limit, source, org)
    if (andRows.length > 0) return andRows
    return this.runSessionSearch(tokens, 'or', 0.4, limit, source, org)
  }

  private async runSessionSearch(tokens: string[], mode: 'and' | 'or', score: number, limit: number, source?: string, org?: string): Promise<Array<{
    session_id: string; summary: string; session_title: string; created_at: string; source: string; score: number
  }>> {
    const joiner = mode === 'and' ? ' AND ' : ' OR '
    let sql = `
      SELECT m.session_id AS session_id,
             m.content AS summary,
             s.title AS session_title,
             m.created_at AS created_at,
             m.source AS source
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.is_summary = true AND (${tokens.map(() => `m.content ILIKE ?`).join(joiner)})`
    const params: unknown[] = tokens.map(likePattern)

    if (source) {
      sql += ` AND m.source = ?`
      params.push(source)
    }
    if (org) {
      sql += ` AND s.org = ?`
      params.push(org)
    }

    sql += ` ORDER BY m.created_at DESC LIMIT ?`
    params.push(limit)

    const rows = await this.q<{ session_id: string; summary: string; session_title: string; created_at: Date | string; source: string }>(sql, params)
    return rows.map((r) => ({ ...r, created_at: iso(r.created_at), score }))
  }

  /**
   * 摘要索引维护入口（原 FTS5 影子表重灌）。PG 侧 BM25 索引由引擎自动维护，
   * 本方法退化为「is_summary 消息计数」—— 保持返回条数与幂等语义
   * （chinese-recall-regression / memory 路由 rebuild 端点依赖）。
   */
  async rebuildFtsIndex(): Promise<number> {
    const r = await this.q1<{ cnt: number | string }>(
      "SELECT COUNT(*)::int AS cnt FROM messages WHERE is_summary = true",
    )
    return num(r?.cnt)
  }

  // ── Additional methods for service migrations ────────────────────

  async findSessionById(id: string): Promise<SessionRow | null> {
    return this.findById(id)
  }

  async countUncompressedMessages(sessionId: string): Promise<{ count: number; total_chars: number }> {
    const r = await this.q1<{ count: number | string; total_chars: number | string }>(`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(LENGTH(content)), 0)::int AS total_chars
      FROM messages
      WHERE session_id = ?
        AND is_compressed = false
    `, [sessionId])
    return { count: num(r?.count), total_chars: num(r?.total_chars) }
  }

  async findUncompressedMessagesOrdered(sessionId: string): Promise<Array<{ id: string; role: string; content: string; created_at: string }>> {
    const rows = await this.q<{ id: string; role: string; content: string; created_at: Date | string }>(`
      SELECT id, role, content, created_at
      FROM messages
      WHERE session_id = ?
        AND is_compressed = false
      ORDER BY created_at ASC
    `, [sessionId])
    return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }))
  }

  async markMessagesCompressed(ids: string[]): Promise<{ changes: number }> {
    if (ids.length === 0) return { changes: 0 }
    const placeholders = ids.map(() => "?").join(",")
    return this.exec(`
      UPDATE messages SET is_compressed = true WHERE id IN (${placeholders})
    `, ids)
  }

  async insertSummaryMessage(id: string, sessionId: string, content: string, createdAt: string, source: string = 'main'): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO messages (id, session_id, role, content, created_at, is_summary, is_compressed, source)
      VALUES (?, ?, 'system', ?, ?, true, false, ?)
    `, [id, sessionId, content, createdAt, source])
  }

  async findSummaryMessage(sessionId: string): Promise<{ content: string } | null> {
    const r = await this.q1<{ content: string }>(`
      SELECT content FROM messages
      WHERE session_id = ? AND is_summary = true
      ORDER BY created_at DESC LIMIT 1
    `, [sessionId])
    return r ?? null
  }

  async findRecentActiveMessages(sessionId: string, limit: number): Promise<Array<{ role: string; content: string }>> {
    return this.q<{ role: string; content: string }>(`
      SELECT role, content FROM messages
      WHERE session_id = ? AND is_compressed = false AND is_summary = false
      ORDER BY created_at DESC LIMIT ?
    `, [sessionId, limit])
  }

  async countActiveSessions(org: string): Promise<number> {
    const r = await this.q1<{ count: number | string }>(
      "SELECT COUNT(*)::int AS count FROM sessions WHERE is_active = true AND is_deleted = false AND org = ?",
      [org],
    )
    return num(r?.count)
  }

  async findLatestMessageTimestamp(): Promise<{ last_at: string | null } | null> {
    const r = await this.q1<{ last_at: Date | string | null }>("SELECT MAX(created_at) AS last_at FROM messages")
    if (!r) return null
    return { last_at: isoOrNull(r.last_at) }
  }

  async findMessagesBySessionWithCursor(sessionId: string, limit: number, cursor?: string): Promise<Array<{
    id: string; session_id: string; role: string; content: string;
    type: string; metadata: string | null;
    tool_calls: string | null; is_summary: number; is_compressed: number; created_at: string;
  }>> {
    let sql = `SELECT * FROM messages WHERE session_id = ?`
    const params: unknown[] = [sessionId]
    if (cursor) { sql += ` AND created_at < ?`; params.push(cursor) }
    sql += ` ORDER BY created_at DESC LIMIT ?`
    params.push(limit)
    const rows = (await this.q<MessagePgRow>(sql, params)).map(fromMessage)
    return rows.map((r) => ({
      id: r.id, session_id: r.session_id, role: r.role, content: r.content,
      type: r.type, metadata: r.metadata, tool_calls: r.tool_calls,
      is_summary: r.is_summary, is_compressed: r.is_compressed, created_at: r.created_at,
    }))
  }

  async updateSessionByOrg(id: string, org: string, fields: Record<string, unknown>): Promise<{ changes: number }> {
    const sets: string[] = ["updated_at = ?"]
    const vals: unknown[] = [new Date().toISOString()]
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`)
      vals.push(SESSION_BOOL_COLS.has(k) ? bool(v as number) : v)
    }
    vals.push(id, org)
    return this.exec(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ? AND org = ? AND is_deleted = false`, vals)
  }

  async softDeleteByOrg(id: string, org: string): Promise<{ changes: number }> {
    const now = new Date().toISOString()
    return this.exec(
      "UPDATE sessions SET is_deleted = true, is_active = false, updated_at = ? WHERE id = ? AND org = ? AND is_deleted = false",
      [now, id, org],
    )
  }

  // ── Clone session methods ────────────────────────────────────────

  /** Update provider_session_id for SDK resume */
  async updateProviderSession(id: string, providerSessionId: string): Promise<{ changes: number }> {
    return this.exec(
      "UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?",
      [providerSessionId, new Date().toISOString(), id],
    )
  }

  /** Insert message with type + metadata (clone-specific) */
  async insertCloneMessage(row: {
    id: string; session_id: string; role: string;
    type: string; content: string; metadata: string | null;
    created_at: string;
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO messages (id, session_id, role, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.session_id, row.role, row.type,
      row.content, jsonbParam(row.metadata), row.created_at,
    ])
  }

  /** Whether the session has an unfinished streaming assistant partial
   *  (metadata JSON written by the clone chat route with streaming:true).
   *  PG jsonb 面用 `metadata->>'streaming'` 语义判定 —— 旧 LIKE 子串在 PG 不可
   *  移植（jsonb::text 冒号后会补空格）。 */
  async hasStreamingMessage(sessionId: string): Promise<boolean> {
    const row = await this.q1(
      `SELECT 1 AS one FROM messages WHERE session_id = ? AND metadata->>'streaming' = 'true' LIMIT 1`,
      [sessionId],
    )
    return row !== undefined
  }

  /** All streaming partial rows across sessions (server-startup orphan sweep). */
  async findStreamingMessages(): Promise<Array<{ id: string; metadata: string }>> {
    const rows = await this.q<{ id: string; metadata: unknown }>(
      `SELECT id, metadata FROM messages WHERE metadata->>'streaming' = 'true'`,
    )
    return rows.map((r) => ({ id: r.id, metadata: jsonStr(r.metadata) ?? '{}' }))
  }

  /** Find sessions by clone_name */
  async findByClone(cloneName: string, filters?: {
    org?: string; limit?: number; cursor?: string
  }): Promise<{ items: SessionRow[]; has_more: boolean; next_cursor: string | null }> {
    const limit = filters?.limit ?? 20
    let sql = `SELECT * FROM sessions WHERE clone_name = ? AND is_deleted = false`
    const params: unknown[] = [cloneName]
    if (filters?.org) { sql += ` AND org = ?`; params.push(filters.org) }
    if (filters?.cursor) { sql += ` AND created_at < ?`; params.push(filters.cursor) }
    sql += ` ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT ?`
    params.push(limit + 1)

    const rows = (await this.q<SessionPgRow>(sql, params)).map(fromSession)
    const hasMore = rows.length > limit
    const items = hasMore ? rows.slice(0, limit) : rows
    return { items, has_more: hasMore, next_cursor: hasMore ? items[items.length - 1].created_at : null }
  }
}
