import crypto from 'crypto'
import type { AgentSession, AgentPaginatedResponse } from '@octopus/shared'
import { AgentSessionDAO } from '../../db/dao'
import type { SessionRow as DBSessionRow } from '../../db/types'

// ── SessionService ─────────────────────────────────────────────

export class SessionService {
  constructor(private dao: AgentSessionDAO) {}

  /**
   * Create a new session.
   */
  async createSession(org: string, opts?: { clone_name?: string }): Promise<AgentSession> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    await this.dao.insertSession({
      id,
      org,
      title: '新会话',
      clone_name: opts?.clone_name ?? null,
      session_type: opts?.clone_name ? 'clone_direct' : 'main',
      created_at: now,
      updated_at: now,
    })

    const row = await this.dao.findSessionById(id)
    if (!row) throw new Error('Session creation failed')
    return this.rowToSession(row)
  }

  /**
   * List sessions for an org.
   */
  async listSessions(
    org: string,
    query?: { clone?: string; session_type?: string; limit?: number; cursor?: string },
  ): Promise<AgentPaginatedResponse<AgentSession>> {
    const result = await this.dao.findByOrg(org, {
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
  async getSession(org: string, id: string): Promise<AgentSession | null> {
    const row = await this.dao.findSessionById(id)
    if (!row || row.org !== org || row.is_deleted) return null
    return this.rowToSession(row)
  }

  /**
   * Update session title.
   */
  async updateSession(org: string, id: string, data: { title: string }): Promise<boolean> {
    const result = await this.dao.updateSessionByOrg(id, org, { title: data.title })
    return result.changes > 0
  }

  /**
   * Soft-delete a session.
   */
  async deleteSession(org: string, id: string): Promise<boolean> {
    const result = await this.dao.softDeleteByOrg(id, org)
    return result.changes > 0
  }

  /**
   * Get message count for a session.
   */
  async getMessageCount(org: string, sessionId: string): Promise<number> {
    return this.dao.countMessages(sessionId)
  }

  // ── Private helpers ─────────────────────────────────────────

  private rowToSession(row: DBSessionRow): AgentSession {
    return {
      id: row.id,
      title: row.title,
      // shared AgentSession 契约这三列是 `string | null`（非可选）——归一到 null，
      // JSON 输出从键缺省变为显式 null，消费方（web-app/cli）均按 falsy 判定，无行为面影响。
      clone_name: row.clone_name ?? null,
      perspective_clone_name: row.perspective_clone_name ?? null,
      session_type: row.session_type as 'main' | 'delegate' | 'clone_direct',
      is_active: row.is_active === 1,
      last_message_at: row.last_message_at ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
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
