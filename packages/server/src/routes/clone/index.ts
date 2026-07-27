// packages/server/src/routes/clone/index.ts
//
// Unified clone routes — filesystem-backed clone management + DB-backed sessions.
// Mounts on /api/clones.
//
// Clone management (filesystem):
//   GET    /api/clones              — list all clones (built-in + user)
//   POST   /api/clones              — create user clone
//   GET    /api/clones/:name        — get clone details
//   DELETE /api/clones/:name        — delete user clone
//   GET    /api/clones/:name/files/:path — read clone file
//   PUT    /api/clones/:name/files/:path — write clone file
//
// Session management (DB-backed, unchanged):
//   POST   /api/clones/:name/sessions          — create session
//   GET    /api/clones/:name/sessions          — list sessions
//   GET    /api/clones/:name/sessions/:id      — get session + messages
//   POST   /api/clones/:name/sessions/:id/chat — SSE chat
//   POST   /api/clones/:name/sessions/:id/stop — stop generation
//
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { CloneDef } from '@octopus/shared'
import type { AgentSessionDAO } from '../../db/dao'
import { CloneRuntime } from '../../services/agent/clone-runtime'
import { isBuiltinClone } from '../../services/agent/builtin-clones'
import {
  listAllClones,
  resolveCloneInfo,
  createUserClone,
  deleteUserClone,
  isValidCloneName,
} from '../../services/agent/clone-resolver'
import {
  registerActiveStream,
  unregisterActiveStream,
} from '../../services/agent/agent-service'
import { getBuiltInCloneDir, getCloneDir } from '../../services/agent/paths'

// ── Route deps ─────────────────────────────────────────────────────

export interface CloneSessionRouteDeps {
  sessionDAO: AgentSessionDAO
}

// ── File route constants removed — file ops now in clone-files.ts ──

// ── Helpers ────────────────────────────────────────────────────────

function resolveCloneDefFromFs(name: string): CloneDef | null {
  const info = resolveCloneInfo(name)
  if (!info) return null

  const cloneDir = info.type === 'built-in' ? getBuiltInCloneDir(name) : getCloneDir(name)
  let persona = info.persona
  const personaPath = path.join(cloneDir, 'persona.md')
  if (fs.existsSync(personaPath)) {
    try { persona = fs.readFileSync(personaPath, 'utf-8') } catch { /* use info.persona */ }
  }

  return {
    name: info.name,
    displayName: info.display_name,
    type: info.type,
    persona,
    skills: info.skills,
    memoryScope: info.memory_scope,
    config: {},
  }
}

// ── Route factory ──────────────────────────────────────────────────

export function createCloneSessionRoutes(deps: CloneSessionRouteDeps): Hono {
  const { sessionDAO } = deps
  const app = new Hono()

  // ══════════════════════════════════════════════════════════════════
  // Clone Management (filesystem-backed)
  // ══════════════════════════════════════════════════════════════════

  // ── List all clones ──────────────────────────────────────────────
  app.get('/', (c) => {
    const clones = listAllClones()
    return c.json({ clones, total: clones.length })
  })

  // ── Create user clone ────────────────────────────────────────────
  app.post('/', async (c) => {
    try {
      const body = await c.req.json<{
        name: string
        display_name: string
        memory_scope?: 'shared' | 'isolated'
      }>()

      if (!body.name) {
        return c.json({ error: { code: 'INVALID_PARAM', message: 'name is required' } }, 400)
      }
      if (!body.display_name) {
        return c.json({ error: { code: 'INVALID_PARAM', message: 'display_name is required' } }, 400)
      }

      const result = createUserClone({
        name: body.name,
        display_name: body.display_name,
        persona: `# 分身: ${body.display_name}\n\n（请在 Chat 中描述你希望这个分身具备的特质）\n`,
        skills: [],
        memory_scope: body.memory_scope ?? 'isolated',
      })

      if (!result.ok) {
        const status = result.error.includes('already exists') ? 409 : 400
        return c.json({ error: { code: 'CLONE_ERROR', message: result.error } }, status)
      }

      return c.json({ clone: result.clone }, 201)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, 500)
    }
  })

  // ── Get clone details ────────────────────────────────────────────
  app.get('/:name', (c) => {
    const name = c.req.param('name')
    const info = resolveCloneInfo(name)
    if (!info) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Clone "${name}" not found` } }, 404)
    }
    return c.json({ clone: info })
  })

  // ── Delete user clone ────────────────────────────────────────────
  app.delete('/:name', (c) => {
    const name = c.req.param('name')
    if (!isValidCloneName(name) && !isBuiltinClone(name)) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'Invalid clone name' } }, 400)
    }

    const result = deleteUserClone(name)
    if (!result.ok) {
      return c.json({ error: { code: 'CLONE_ERROR', message: result.error } }, result.status ?? 400)
    }
    return c.json({ ok: true })
  })

  // File routes (GET/PUT/POST/DELETE /:name/files/:path) moved to clone-files.ts
  // which supports __inherited__/ virtual paths for shared skills and memory.

  // ══════════════════════════════════════════════════════════════════
  // Session Management (DB-backed, unchanged)
  // ══════════════════════════════════════════════════════════════════

  // ── Create clone session ─────────────────────────────────────────
  app.post('/:name/sessions', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || 'default'
    const cloneName = c.req.param('name')

    // Verify clone exists
    const cloneDef = resolveCloneDefFromFs(cloneName)
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

    // Resolve clone definition from filesystem
    const cloneDef = resolveCloneDefFromFs(cloneName)
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
    const cwd = runtime.getDefaultCwd()
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
