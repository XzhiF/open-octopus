import { Hono } from 'hono'
import { getSessionService } from '../../services/agent/session-service'
import { AgentSessionDAO } from '../../db/dao'
import { createAgentError, mapErrorToStatus } from './middleware'

export function createSessionRoutes(sessionDAO: AgentSessionDAO): Hono {
  const sessions = new Hono()

  /**
   * POST /sessions — Create a new session
   */
  sessions.post('/sessions', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      let body: { clone_name?: string } = {}
      try {
        const raw = await c.req.json()
        body = raw ?? {}
      } catch {
        // Empty body is fine
      }

      const session = getSessionService().createSession(org, {
        clone_name: body.clone_name,
      })

      return c.json(session, 201)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * GET /sessions — List sessions
   */
  sessions.get('/sessions', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const limit = parseInt(c.req.query('limit') ?? '20', 10)
      const cursor = c.req.query('cursor')
      const clone = c.req.query('clone')
      const session_type = c.req.query('session_type')

      const result = getSessionService().listSessions(org, {
        limit: Math.min(limit, 100),
        cursor,
        clone,
        session_type,
      })

      return c.json(result)
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * GET /sessions/:id — Get session details
   */
  sessions.get('/sessions/:id', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const id = c.req.param('id')
      const session = getSessionService().getSession(org, id)
      if (!session) {
        return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
      }

      // Fetch paginated messages (PRD A2: cursor-paginated, 50 per page)
      const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)
      const cursor = c.req.query('cursor')

      const msgRows = sessionDAO.findMessagesBySessionWithCursor(id, limit + 1, cursor)
      const hasMore = msgRows.length > limit
      const messages = (hasMore ? msgRows.slice(0, limit) : msgRows).reverse().map((r) => {
        // Parse tool_calls column — may be new format { thinking, tool_calls } or old format (plain array)
        let toolCalls = null
        let thinking: string | undefined
        if (r.tool_calls) {
          try {
            const parsed = JSON.parse(r.tool_calls)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              // New format: { thinking?: string, tool_calls: [...] }
              if ('thinking' in parsed || 'tool_calls' in parsed) {
                thinking = parsed.thinking ?? undefined
                toolCalls = parsed.tool_calls ?? null
              } else {
                // Old format: plain array
                toolCalls = parsed
              }
            } else {
              toolCalls = parsed
            }
          } catch {
            toolCalls = null
          }
        }

        return {
          id: r.id,
          session_id: r.session_id,
          role: r.role,
          content: r.content,
          tool_calls: toolCalls,
          thinking,
          is_summary: r.is_summary === 1,
          is_compressed: r.is_compressed === 1,
          created_at: r.created_at,
        }
      })

      return c.json({
        ...session,
        messages: {
          items: messages,
          total: messages.length,
          has_more: hasMore,
          next_cursor: hasMore ? msgRows[limit - 1]?.created_at : null,
        },
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * PUT /sessions/:id — Update session title
   */
  sessions.put('/sessions/:id', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const id = c.req.param('id')
      const body = await c.req.json<{ title: string }>()

      const updated = getSessionService().updateSession(org, id, { title: body.title })
      if (!updated) {
        return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
      }

      return c.json({ ok: true })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * DELETE /sessions/:id — Delete session
   */
  sessions.delete('/sessions/:id', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const id = c.req.param('id')
      const deleted = getSessionService().deleteSession(org, id)
      if (!deleted) {
        return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
      }

      return c.json({ ok: true })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * GET /sessions/:id/messages/count — Get message count
   */
  sessions.get('/sessions/:id/messages/count', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const id = c.req.param('id')
      const count = getSessionService().getMessageCount(org, id)

      return c.json({ count })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return sessions
}
