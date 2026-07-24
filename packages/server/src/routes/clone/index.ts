// packages/server/src/routes/clone/index.ts
//
// Clone session routes — direct entry for Web UI pages connecting to specific clones.
// Mounts on /api/clones/:name/sessions/* and /api/clones (management).
//
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import crypto from 'crypto'
import type { CloneDef } from '@octopus/shared'
import type { AgentSessionDAO, CloneDAO } from '../../db/dao'
import { CloneRuntime } from '../../services/agent/clone-runtime'
import { getBuiltinCloneDef, isBuiltinClone, BUILTIN_CLONES } from '../../services/agent/builtin-clones'
import {
  registerActiveStream,
  unregisterActiveStream,
} from '../../services/agent/agent-service'
import { getAgentDir } from '../../services/agent/paths'

// ── Route deps ─────────────────────────────────────────────────────

export interface CloneSessionRouteDeps {
  sessionDAO: AgentSessionDAO
  cloneDAO: CloneDAO
}

// ── Helpers ────────────────────────────────────────────────────────

function resolveCloneDef(name: string, cloneDAO: CloneDAO): CloneDef | null {
  // Built-in clone: use static definition
  if (isBuiltinClone(name)) {
    return getBuiltinCloneDef(name)
  }
  // User clone: read from DB
  const row = cloneDAO.findByName(name)
  if (!row) return null
  return {
    name: row.name,
    type: (row.type as 'built-in' | 'user') ?? 'user',
    persona: row.persona,
    skills: JSON.parse(row.skills || '[]'),
    memoryScope: (row.memory_scope as 'shared' | 'isolated') ?? 'isolated',
    workspaceRef: row.workspace_ref ? JSON.parse(row.workspace_ref) : undefined,
    config: {},
  }
}

// ── Route factory ──────────────────────────────────────────────────

export function createCloneSessionRoutes(deps: CloneSessionRouteDeps): Hono {
  const { sessionDAO, cloneDAO } = deps
  const app = new Hono()

  // ── List all clones ──────────────────────────────────────────────
  app.get('/', (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'
    const clones: CloneDef[] = [...BUILTIN_CLONES]

    // Add user clones from DB
    try {
      const userClones = cloneDAO.listByOrg(org)
      for (const row of userClones) {
        if (!clones.some(c => c.name === row.name)) {
          clones.push({
            name: row.name,
            type: (row.type as 'built-in' | 'user') ?? 'user',
            persona: row.persona,
            skills: JSON.parse(row.skills || '[]'),
            memoryScope: (row.memory_scope as 'shared' | 'isolated') ?? 'isolated',
            config: {},
          })
        }
      }
    } catch {
      // DB read failure is non-fatal
    }

    return c.json({ clones, total: clones.length })
  })

  // ── Get clone details ────────────────────────────────────────────
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    const cloneDef = resolveCloneDef(name, cloneDAO)
    if (!cloneDef) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Clone "${name}" not found` } }, 404)
    }
    return c.json(cloneDef)
  })

  // ── Create clone session ─────────────────────────────────────────
  app.post('/:name/sessions', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'
    const cloneName = c.req.param('name')

    // Verify clone exists
    const cloneDef = resolveCloneDef(cloneName, cloneDAO)
    if (!cloneDef) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Clone "${cloneName}" not found` } }, 404)
    }

    let body: { title?: string; scope_id?: string } = {}
    try {
      body = await c.req.json()
    } catch {
      // Optional body
    }

    const now = new Date().toISOString()
    const sessionId = crypto.randomUUID()
    const title = body.title ?? `${cloneName} 会话`

    sessionDAO.insertSession({
      id: sessionId,
      org,
      title,
      clone_name: cloneName,
      session_type: 'clone_direct',
      scope_id: body.scope_id ?? null,
      created_at: now,
      updated_at: now,
    })

    const session = sessionDAO.findById(sessionId)
    return c.json({
      ...session,
      clone_name: cloneName,
      scope_id: body.scope_id ?? null,
      provider_session_id: null,
    }, 201)
  })

  // ── List clone sessions ──────────────────────────────────────────
  app.get('/:name/sessions', (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'
    const cloneName = c.req.param('name')
    const limit = parseInt(c.req.query('limit') ?? '20', 10)
    const cursor = c.req.query('cursor')

    const result = sessionDAO.findByClone(cloneName, { org, limit, cursor })
    return c.json({
      sessions: result.items,
      has_more: result.has_more,
      next_cursor: result.next_cursor,
    })
  })

  // ── Get session with messages ────────────────────────────────────
  app.get('/:name/sessions/:id', (c) => {
    const cloneName = c.req.param('name')
    const sessionId = c.req.param('id')
    const limit = parseInt(c.req.query('limit') ?? '50', 10)
    const before = c.req.query('before')

    const session = sessionDAO.findById(sessionId)
    if (!session || session.is_deleted || session.clone_name !== cloneName) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Session ${sessionId} not found` } }, 404)
    }

    const messagesResult = sessionDAO.findMessagesBySession(sessionId, { limit, cursor: before })
    return c.json({
      session: {
        ...session,
        clone_name: session.clone_name,
      },
      messages: messagesResult.items,
      has_more: messagesResult.has_more,
      next_cursor: messagesResult.next_cursor,
    })
  })

  // ── Chat SSE streaming ──────────────────────────────────────────
  app.post('/:name/sessions/:id/chat', async (c) => {
    const cloneName = c.req.param('name')
    const sessionId = c.req.param('id')
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'

    let body: { message?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid JSON body' } }, 400)
    }

    if (!body.message) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'message is required' } }, 400)
    }

    // Verify session exists and belongs to clone
    const session = sessionDAO.findById(sessionId)
    if (!session || session.is_deleted || session.clone_name !== cloneName) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Session ${sessionId} not found` } }, 404)
    }

    // Resolve clone definition
    const cloneDef = resolveCloneDef(cloneName, cloneDAO)
    if (!cloneDef) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Clone "${cloneName}" not found` } }, 404)
    }

    // Store user message
    const userMsgId = crypto.randomUUID()
    const now = new Date().toISOString()
    sessionDAO.insertCloneMessage({
      id: userMsgId, session_id: sessionId, role: 'user',
      type: 'text', content: body.message, metadata: null, created_at: now,
    })
    sessionDAO.updateLastMessageAt(sessionId, now)

    // Instantiate CloneRuntime
    const runtime = new CloneRuntime(cloneDef, org)
    const cwd = getAgentDir()
    const providerSessionId = session.provider_session_id ?? null

    return streamSSE(c, async (stream) => {
      let aborted = false
      const abortStream = () => { aborted = true }
      const streamId = registerActiveStream(sessionId, abortStream)

      try {
        let fullContent = ''
        let fullThinking = ''
        let resultSessionId: string | null = null
        const toolCalls: Array<{
          id: string; name: string; input?: unknown; result?: unknown; isError?: boolean
        }> = []

        for await (const chunk of runtime.chat(body.message!, sessionId, providerSessionId, cwd)) {
          if (aborted || (stream as any)._aborted) break

          switch (chunk.type) {
            case 'text_delta':
              fullContent += chunk.content
              await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: chunk.content, content: fullContent }) })
              break
            case 'thinking_start':
              await stream.writeSSE({ event: 'thinking_start', data: '{}' })
              break
            case 'thinking':
              fullThinking += chunk.content
              await stream.writeSSE({ event: 'thinking', data: JSON.stringify({ delta: chunk.content }) })
              break
            case 'thinking_done':
              await stream.writeSSE({ event: 'thinking_done', data: '{}' })
              break
            case 'tool_call_start':
              toolCalls.push({ id: chunk.toolCallId, name: chunk.toolName })
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'start', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName }) })
              break
            case 'tool_call': {
              const tc = toolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) tc.input = chunk.toolInput
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) })
              break
            }
            case 'tool_result': {
              const tc = toolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) { tc.result = chunk.content; tc.isError = chunk.isError }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'result', tool_call_id: chunk.toolCallId, content: chunk.content, is_error: chunk.isError }) })
              break
            }
            case 'status':
              await stream.writeSSE({ event: 'status', data: JSON.stringify({ status: chunk.status }) })
              break
            case 'result':
              resultSessionId = chunk.sessionId ?? null
              break
            case 'error':
              await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: chunk.code, message: chunk.message }) })
              break
          }
        }

        // Store assistant message + update provider session
        if (fullContent) {
          const assistantMsgId = crypto.randomUUID()
          const assistantNow = new Date().toISOString()

          const metadata = JSON.stringify({
            thinking: fullThinking || undefined,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          })

          sessionDAO.insertCloneMessage({
            id: assistantMsgId, session_id: sessionId, role: 'assistant',
            type: 'text', content: fullContent, metadata, created_at: assistantNow,
          })
          sessionDAO.updateLastMessageAt(sessionId, assistantNow)

          // Update provider_session_id for future resume
          if (resultSessionId) {
            sessionDAO.updateProviderSession(sessionId, resultSessionId)
          }

          // Auto-generate title on first message
          if (session.title === `${cloneName} 会话` || session.title === '新会话') {
            const autoTitle = body.message!.slice(0, 40).replace(/\n/g, ' ').trim() || `${cloneName} 会话`
            sessionDAO.updateSession(sessionId, { title: autoTitle })
          }

          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              session_id: sessionId,
              message_id: assistantMsgId,
              session_title: sessionDAO.findById(sessionId)?.title,
            }),
          })
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'STREAM_ERROR', message: msg }) })
      } finally {
        unregisterActiveStream(sessionId, streamId)
      }
    })
  })

  // ── Stop generation ──────────────────────────────────────────────
  app.post('/:name/sessions/:id/stop', async (c) => {
    const sessionId = c.req.param('id')

    try {
      const { getAgentService } = await import('../../services/agent/agent-service')
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'
      const result = await getAgentService().stopChat(org, sessionId)
      return c.json({ success: true, ...result })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
    }
  })

  return app
}
