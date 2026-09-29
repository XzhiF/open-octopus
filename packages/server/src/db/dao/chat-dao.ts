import type { ChatSessionRow, ChatMessageRow } from "../types"
import { BasePgDAO } from "./base-pg"
import { bool, flag, iso, isoOrNull, jsonStr, num } from "./pg-mappers"

/**
 * ChatDAO — chat sessions and messages. (P1 B1: postgres.js / BasePgDAO)
 * Covers: chat_sessions, chat_messages tables.
 *
 * 方言差异（DAO 出口归一，旧契约不变，见 pg-mappers.ts 头注释）：
 *   - chat_sessions.is_active: PG boolean ↔ 旧 0/1 number
 *   - chat_messages.metadata: PG jsonb ↔ 旧 JSON 文本
 *   - created_at/updated_at: PG timestamptz(Date) ↔ 旧 ISO 文本
 */

interface ChatSessionPgRow {
  id: string
  workspace_id: string
  title: string | null
  is_active: boolean | number
  created_at: Date | string
  updated_at: Date | string
  provider: string
  provider_session_id: string | null
}

interface ChatMessagePgRow {
  id: string
  session_id: string
  role: string
  type: string
  content: string
  metadata: unknown
  created_at: Date | string
}

function fromSession(r: ChatSessionPgRow): ChatSessionRow {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    title: r.title,
    is_active: flag(r.is_active),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    provider: r.provider,
    provider_session_id: r.provider_session_id,
  }
}

function fromMessage(r: ChatMessagePgRow): ChatMessageRow {
  return {
    id: r.id,
    session_id: r.session_id,
    role: r.role,
    type: r.type,
    content: r.content,
    metadata: jsonStr(r.metadata),
    created_at: iso(r.created_at),
  }
}

/** updateSession 的动态 SET 白名单 —— 列名不允许从任意对象键流入 SQL。 */
const SESSION_UPDATABLE = new Set<keyof ChatSessionRow>([
  "workspace_id", "title", "is_active", "created_at", "updated_at", "provider", "provider_session_id",
])

/**
 * 把 JS 值归一为 PG 列类型可接受的参数：
 *   is_active 列是 boolean —— 旧契约传 0/1 number，这里翻成 true/false；
 *   其余保持原值（ISO 串在 PG 端按 timestamptz 上下文解析）。
 */
function sessionParam(key: string, v: unknown): unknown {
  if (key === "is_active") return bool(v as number | boolean | undefined)
  return v
}

export class ChatDAO extends BasePgDAO {
  // ── chat_sessions ───────────────────────────────────────────────

  async findSessionById(id: string): Promise<ChatSessionRow | null> {
    const row = await this.q1<ChatSessionPgRow>("SELECT * FROM chat_sessions WHERE id = ?", [id])
    return row ? fromSession(row) : null
  }

  async listSessions(workspaceId: string): Promise<ChatSessionRow[]> {
    const rows = await this.q<ChatSessionPgRow>(
      "SELECT * FROM chat_sessions WHERE workspace_id = ? ORDER BY updated_at DESC",
      [workspaceId],
    )
    return rows.map(fromSession)
  }

  async insertSession(row: Omit<ChatSessionRow, "is_active" | "provider" | "provider_session_id"> & {
    is_active?: number; provider?: string; provider_session_id?: string | null
  }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO chat_sessions (id, workspace_id, title, is_active, created_at, updated_at, provider, provider_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.workspace_id, row.title, bool(row.is_active),
      row.created_at, row.updated_at, row.provider ?? "claude",
      row.provider_session_id ?? null,
    ])
  }

  async updateSession(id: string, fields: Partial<ChatSessionRow>): Promise<{ changes: number }> {
    const sets: string[] = []
    const vals: unknown[] = []
    for (const [k, v] of Object.entries(fields)) {
      if (k === "id") continue
      if (!SESSION_UPDATABLE.has(k as keyof ChatSessionRow)) continue
      // 方言差异：SQLite 允许 UPDATE 对同列重复赋值且**后者胜**（旧行为 = 末尾自动
      // 追加的 updated_at 覆盖调用方传入值）；PG 直接报 multiple assignments。
      // 这里跳过调用方的 updated_at，保留末尾自动值 —— 语义与旧 SQLite 一致。
      if (k === "updated_at") continue
      sets.push(`${k} = ?`)
      vals.push(sessionParam(k, v))
    }
    if (sets.length === 0 && !Object.keys(fields).some((k) => k === "updated_at")) return { changes: 0 }
    sets.push("updated_at = ?")
    vals.push(new Date().toISOString())
    vals.push(id)
    return this.exec(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`, vals)
  }

  async updateProviderSession(id: string, providerSessionId: string): Promise<{ changes: number }> {
    return this.exec(
      "UPDATE chat_sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?",
      [providerSessionId, new Date().toISOString(), id],
    )
  }

  async deleteSession(id: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM chat_sessions WHERE id = ?", [id])
  }

  async deleteSessionsByWorkspace(workspaceId: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM chat_sessions WHERE workspace_id = ?", [workspaceId])
  }

  // ── chat_messages ───────────────────────────────────────────────

  async findMessagesBySession(sessionId: string): Promise<ChatMessageRow[]> {
    const rows = await this.q<ChatMessagePgRow>(
      "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC",
      [sessionId],
    )
    return rows.map(fromMessage)
  }

  async findLatestMessages(sessionId: string, limit: number): Promise<ChatMessageRow[]> {
    const rows = await this.q<ChatMessagePgRow>(
      "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
      [sessionId, limit],
    )
    return rows.map(fromMessage)
  }

  async findOlderMessages(sessionId: string, limit: number, beforeCreatedAt: string): Promise<ChatMessageRow[]> {
    const rows = await this.q<ChatMessagePgRow>(
      "SELECT * FROM chat_messages WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?",
      [sessionId, beforeCreatedAt, limit],
    )
    return rows.map(fromMessage)
  }

  async findMessageById(id: string): Promise<ChatMessageRow | null> {
    const row = await this.q1<ChatMessagePgRow>("SELECT * FROM chat_messages WHERE id = ?", [id])
    return row ? fromMessage(row) : null
  }

  /** S11: PG COUNT 返回 bigint（postgres.js 给 string）→ num() 归一。 */
  async countMessages(sessionId: string): Promise<number> {
    const row = await this.q1<{ count: string | number }>(
      "SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?",
      [sessionId],
    )
    return num(row?.count)
  }

  async insertMessage(row: Omit<ChatMessageRow, "type"> & { type?: string }): Promise<{ changes: number }> {
    return this.exec(`
      INSERT INTO chat_messages (id, session_id, role, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      row.id, row.session_id, row.role, row.type ?? "text",
      row.content, row.metadata ?? null, row.created_at,
    ])
  }

  async updateMessageMetadata(id: string, metadata: string): Promise<{ changes: number }> {
    return this.exec("UPDATE chat_messages SET metadata = ? WHERE id = ?", [metadata, id])
  }

  async deleteMessagesBySession(sessionId: string): Promise<{ changes: number }> {
    return this.exec("DELETE FROM chat_messages WHERE session_id = ?", [sessionId])
  }
}
