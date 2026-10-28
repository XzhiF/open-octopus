import { Hono } from 'hono'
import { getSessionService } from '../../services/agent/session-service'
import { listActiveStreams } from '../../services/agent/agent-service'
import { AgentSessionDAO } from '../../db/dao'
import { WorkspaceDAO } from '../../db/dao/workspace-dao'
import { WorkspaceService } from '../../services/workspace'
import { SessionCacheContextDAO } from '../../db/dao/session-cache-context-dao'
import { isCloneRoleTarget, roleResponse } from '../../services/agent/role-response'
import { resolveCloneHomeDir } from '../../services/agent/clone-resolver'
import { estimateContextUsageFromLedger } from '../../services/agent/context-usage'
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

      let body: { clone_name?: string; cwd?: string; workspace_id?: string; identity_clone?: string } = {}
      try {
        const raw = await c.req.json()
        body = raw ?? {}
      } catch {
        // Empty body is fine
      }

      // v58 lazy cwd/workspace binding: main sessions default to the persistent
      // main-agent workspace; an explicit workspace or directory wins.
      let cwd = body.cwd ?? null
      let workspaceId = body.workspace_id ?? null
      if (!body.clone_name) {
        const wsService = new WorkspaceService(new WorkspaceDAO(sessionDAO.getDb()))
        if (workspaceId) {
          const ws = wsService.getById(workspaceId)
          if (ws) cwd = ws.path.replace(/^~/, require('os').homedir())
          else workspaceId = null
        }
        if (!workspaceId && cwd) {
          const ws = wsService.attachDirectory({ org, path: cwd })
          workspaceId = ws.id
          cwd = ws.path.replace(/^~/, require('os').homedir())
        }
        // 新会话选了分身但没手动挑目录：落在该分身自己的工作区
        // （与 clone session 的 getDefaultCwd() 同源），不是 Main Agent 的目录。
        // ~/.octopus 在目录选择策略的黑名单里（不能注册成 workspace 行），
        // 所以这里只写 cwd —— chat 路由读 session.cwd 即可。分身未知 → 回落默认。
        if (!workspaceId && !cwd && body.identity_clone) {
          cwd = resolveCloneHomeDir(body.identity_clone)
        }
        if (!workspaceId && !cwd) {
          const ws = wsService.ensureMainWorkspace(org)
          workspaceId = ws.id
          cwd = ws.path.replace(/^~/, require('os').homedir())
        }
      }

      const session = getSessionService().createSession(org, {
        clone_name: body.clone_name,
        cwd,
        workspace_id: workspaceId,
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
   * GET /sessions/running — Sessions with an in-memory generation stream.
   * Literal route, must be registered before `GET /sessions/:id`.
   */
  sessions.get('/sessions/running', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }
      const requested = parseInt(c.req.query('limit') ?? '100', 10)
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 100

      const items: Array<{
        id: string
        title: string
        clone_name: string | null
        session_type: string
        started_at: string
        stream_count: number
      }> = []

      for (const active of listActiveStreams()) {
        const session = getSessionService().getSession(org, active.sessionId)
        if (!session) continue
        items.push({
          id: session.id,
          title: session.title,
          clone_name: session.clone_name ?? null,
          session_type: session.session_type,
          started_at: new Date(active.startedAt).toISOString(),
          stream_count: active.streamCount,
        })
        if (items.length >= limit) break
      }

      return c.json({ items })
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
        // Parse the tool_calls column — wrapper { thinking?, tool_calls? } for
        // turns with extras, legacy plain array otherwise. Anything that is not
        // an array is handed out as null: the transcript UI iterates this
        // field, and a stray object (older writers serialized an empty wrapper
        // as "{}") blanks the whole app on mount.
        let toolCalls: unknown[] | null = null
        let thinking: string | undefined
        if (r.tool_calls) {
          try {
            const parsed = JSON.parse(r.tool_calls) as unknown
            if (Array.isArray(parsed)) {
              toolCalls = parsed
            } else if (parsed && typeof parsed === 'object') {
              const wrapper = parsed as { thinking?: unknown; tool_calls?: unknown }
              thinking = typeof wrapper.thinking === 'string' ? wrapper.thinking : undefined
              toolCalls = Array.isArray(wrapper.tool_calls) ? wrapper.tool_calls : null
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
          metadata: r.metadata ?? null,
        }
      })

      return c.json({
        ...session,
        // The provider's own report when this session has run a turn since the
        // column existed; otherwise a read-only estimate from the token ledger
        // so ANY browser paints a number instead of `ctx --%`. The estimate is
        // never written back — the next turn replaces it with exact numbers.
        context_usage: session.context_usage
          ?? estimateContextUsageFromLedger(sessionDAO.getDb(), id),
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
   * GET /sessions/:id/role — current expert identity for this session.
   * PUT /sessions/:id/role — switch identity (body { expert: string | null }).
   * Identity is persisted here; the actual role card is appended to the next
   * user message by the chat route (system prompt/tools stay frozen).
   */
  sessions.get('/sessions/:id/role', (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
    const id = c.req.param('id')
    const session = sessionDAO.findById(id)
    if (!session || session.is_deleted || (org && session.org !== org)) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    const state = new SessionCacheContextDAO(sessionDAO.getDb()).getRoleState(id)
    return c.json(roleResponse(id, state))
  })

  sessions.put('/sessions/:id/role', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
    const id = c.req.param('id')
    const session = sessionDAO.findById(id)
    if (!session || session.is_deleted || (org && session.org !== org)) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    let body: { expert?: unknown } = {}
    try {
      body = await c.req.json<{ expert?: unknown }>()
    } catch {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid JSON body'), 400)
    }
    const expert = body.expert == null ? null : String(body.expert)
    if (expert && !isCloneRoleTarget(expert)) {
      return c.json(createAgentError('INVALID_PARAM', `Unknown clone: ${expert}`), 400)
    }
    const state = new SessionCacheContextDAO(sessionDAO.getDb()).setActiveExpert(id, expert, 'clone')
    return c.json(roleResponse(id, state))
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


  return sessions
}
