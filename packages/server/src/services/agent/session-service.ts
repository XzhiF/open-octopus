import crypto from 'crypto'
import type { AgentSession, AgentPaginatedResponse, AgentContextUsage } from '@octopus/shared'
import { AgentSessionDAO } from '../../db/dao'
import type { SessionRow as DBSessionRow } from '../../db/types'

/** Parse the `sessions.context_usage` JSON column. Returns null for legacy
 *  rows, malformed JSON, or payloads that don't look like a usage report. */
export function parseContextUsage(raw: string | null | undefined): AgentContextUsage | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const usage = parsed as Partial<AgentContextUsage>
    return typeof usage.percentage === 'number' && typeof usage.totalTokens === 'number'
      ? (usage as AgentContextUsage)
      : null
  } catch {
    return null
  }
}

// ── SessionService ─────────────────────────────────────────────

export class SessionService {
  constructor(private dao: AgentSessionDAO) {}

  /**
   * Create a new session.
   */
  createSession(opts?: { clone_name?: string; cwd?: string | null; workspace_id?: string | null }): AgentSession {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    this.dao.insertSession({
      id,
      title: '新会话',
      clone_name: opts?.clone_name ?? null,
      session_type: opts?.clone_name ? 'clone_direct' : 'main',
      cwd: opts?.cwd ?? null,
      workspace_id: opts?.workspace_id ?? null,
      created_at: now,
      updated_at: now,
    })

    const row = this.dao.findSessionById(id)
    if (!row) throw new Error('Session creation failed')
    return this.rowToSession(row)
  }

  /**
   * List sessions globally.
   */
  listSessions(
    query?: { clone?: string; session_type?: string; limit?: number; cursor?: string },
  ): AgentPaginatedResponse<AgentSession> {
    const result = this.dao.listSessions({
      clone: query?.clone,
      session_type: query?.session_type,
      limit: query?.limit,
      cursor: query?.cursor,
    })

    return {
      items: result.items.map(r => this.rowToSession(r)),
      total: result.items.length,
      has_more: result.has_more,
      next_cursor: result.next_cursor,
    }
  }

  /**
   * Get a single session with messages.
   */
  getSession(id: string): AgentSession | null {
    const row = this.dao.findSessionById(id)
    if (!row || row.is_deleted) return null
    // Detail reads carry the persisted ctx usage so a cold load can paint the
    // composer chip; list reads stay lean (see listSessions).
    return this.rowToSession(row, { withContextUsage: true })
  }

  /**
   * Update session title.
   */
  updateSession(id: string, data: { title: string }): boolean {
    const result = this.dao.updateSessionIfActive(id, { title: data.title })
    return result.changes > 0
  }

  /**
   * Soft-delete a session.
   */
  deleteSession(id: string): boolean {
    const result = this.dao.softDelete(id)
    return result.changes > 0
  }

  /**
   * Get message count for a session.
   */
  getMessageCount(sessionId: string): number {
    return this.dao.countMessages(sessionId)
  }

  // ── Private helpers ─────────────────────────────────────────

  private rowToSession(row: DBSessionRow, opts?: { withContextUsage?: boolean }): AgentSession {
    return {
      id: row.id,
      title: row.title,
      clone_name: row.clone_name ?? null,
      perspective_clone_name: row.perspective_clone_name ?? null,
      session_type: row.session_type as 'main' | 'delegate' | 'clone_direct',
      is_active: row.is_active === 1,
      last_message_at: row.last_message_at ?? null,
      cwd: row.cwd ?? null,
      workspace_id: row.workspace_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(opts?.withContextUsage ? { context_usage: parseContextUsage(row.context_usage) } : {}),
    }
  }
}

// Singleton
let sessionServiceInstance: SessionService | null = null

export function initSessionService(dao: AgentSessionDAO): SessionService {
  sessionServiceInstance = new SessionService(dao)
  return sessionServiceInstance
}

export function getSessionService(): SessionService {
  if (!sessionServiceInstance) {
    throw new Error('SessionService not initialized. Call initSessionService() first.')
  }
  return sessionServiceInstance
}
