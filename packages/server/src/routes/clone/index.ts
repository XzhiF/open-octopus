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
import type { AgentSessionDAO, TaskDAO } from '../../db/dao'
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
import { getMemoryService } from '../../services/agent/memory-service'
import { autosaveTaskDraft } from './autosave'
import { getSpecNotice, clearSpecNotice } from '../../services/tasks/spec-notice-store'
import { TaskAuthorSessionAugmenter } from '../../services/tasks/task-author-session-augmenter'
import { TaskHomeService } from '../../services/tasks/task-home-service'
import { getResourceRegistry } from '../../services/resource-registry'
import type { ResourceRef } from '@octopus/shared'

// ── Route deps ─────────────────────────────────────────────────────

export interface CloneSessionRouteDeps {
  sessionDAO: AgentSessionDAO
  /**
   * TaskDAO for the task-author autosave seam (04, v2-D6). Optional for
   * backwards-compat with tests that only exercise clone-file/session
   * routes — the seam skips (no-op) when absent. When present, fires at
   * turn-end for cloneName === 'task-author' sessions.
   */
  taskDAO?: TaskDAO
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
  const { sessionDAO, taskDAO } = deps
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

    let body: { message?: string; model?: string }
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

    // 05 — reverse context msg (SPIKE S1, v2-D7). If the user saved a draft
    // (PUT /api/tasks) since the last turn, TasksService.updateTask set a
    // transient, in-memory notice keyed by task_id. Resolve the task bound
    // to this session (same lookup the autosave seam uses) and read the
    // pending notice. Passed to CloneRuntime.chat below as `specUpdateNotice`
    // → sendWithProvider appends it to the system-prompt `append` string
    // (assembleContext is fresh per turn, clone-runtime.ts:261, so this
    // re-delivers only while the notice stays pending). Cleared AFTER the
    // stream (below) so a mid-stream error / abort re-delivers next turn
    // (at-least-once; the notice is an idempotent nudge, not a state change).
    // Gated by task-author + taskDAO: only task-author sessions carry spec
    // notices, and taskDAO is optional (wired only with the autosave seam).
    // This is a DIFFERENT location from 04's turn-end autosave block
    // (below, ~:416-428) — the send path reads before runtime.chat; the
    // autosave seam writes at turn-end. No overlap.
    const noticeTaskId =
      cloneName === 'task-author' && taskDAO
        ? taskDAO.getBySourceChatSession(sessionId)?.id ?? null
        : null
    const specUpdateNotice = noticeTaskId
      ? getSpecNotice(noticeTaskId)
      : undefined

    // 07 — authoring_resources prompt-inject (SG6, v2-D8/D13, SPIKE S2
    // Mechanism B). The task-author clone chat route resolves
    // `tasks.authoring_resources[]` (draft-scope, set by the agent via the
    // `update_task_spec_field` tool field='authoring_resources' — 03 built
    // that endpoint) per turn, resolves each skill's SKILL.md content via
    // TaskAuthorSessionAugmenter (ResourceManager → readFile →
    // enhancePromptWithSkills — SG11 resurrects the dead code), and passes
    // the content string to runtime.chat as `authoringResourcesContent`.
    // sendWithProvider appends it to systemPrompt.append ALONGSIDE
    // specUpdateNotice (clone-runtime.ts:346-348 — same concat seam 05 uses).
    // assembleContext is fresh per turn, so the latest authoring_resources[]
    // is re-read every turn (Mechanism B). Only skill-type refs are injected
    // (agent/command/rule are workspace-scope → workflow.requires via SG7).
    // Gated by task-author + taskDAO (same gate as specUpdateNotice); absent
    // taskDAO (older test paths) → no injection (unchanged behavior).
    let authoringResourcesContent: string | undefined
    if (noticeTaskId && taskDAO) {
      try {
        const taskRow = taskDAO.getById(noticeTaskId)
        const authoringResources: ResourceRef[] = taskRow?.authoring_resources
          ? JSON.parse(taskRow.authoring_resources) as ResourceRef[]
          : []
        if (authoringResources.length > 0) {
          const augmenter = new TaskAuthorSessionAugmenter(getResourceRegistry().get())
          authoringResourcesContent = augmenter.resolveAuthoringResourcesContent(authoringResources) || undefined
        }
      } catch (err: unknown) {
        // Non-fatal — chat reply unaffected; the agent just doesn't see
        // authoring_resources content this turn (malformed JSON, missing
        // resource, etc.). Mirrors the swallow+log pattern in spec-notice.
        console.error(
          '[clone-route] authoring_resources resolution failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // 03 (task-authoring-v3, AC6): resolve the per-task home path for the
    // task-author session so CloneRuntime.getPlugins can append it as a third
    // plugin directory (the SDK scans `{taskHomePath}/skills/` for the
    // materialized Skill-group links — ADR-0010). Gated by the same
    // `noticeTaskId` (task-author + taskDAO) already resolved above, AND a
    // filesystem existence check: only pass the path when the home actually
    // exists on disk (created by POST /api/tasks → TaskHomeService.createHome
    // — ticket 04 / 02). A non-existent home → undefined → getPlugins stays
    // at 2 plugins (no cwd-root scan, no bogus third plugin). The path is
    // derived purely from the id (no DB field — ADR-0011), so this is a
    // stat, not a query.
    let taskHomePath: string | undefined
    let taskArtifactsDir: string | undefined
    if (noticeTaskId) {
      const homeService = new TaskHomeService()
      const home = homeService.homePath(noticeTaskId)
      if (fs.existsSync(home)) {
        taskHomePath = home
        taskArtifactsDir = homeService.artifactsDir(noticeTaskId)
      }
    }

    // 05 (task-authoring-v3 code-review F1/D6): v3 task context — artifacts
    // dir + skill-group lock + locked projects — appended to the system prompt
    // every turn (随 task context 注入). The agent's cwd stays the built-in
    // clone dir, so it needs the ABSOLUTE artifacts path to Write artifact
    // files + register artifacts.json (D5/R4), the lock context so it stops
    // suggesting group changes after creation (ADR-0012), and the locked
    // project names so it knows which project(s) the user selected.
    // Non-fatal on any read/parse failure.
    let taskContextContent: string | undefined
    if (noticeTaskId && taskDAO) {
      try {
        const ctxRow = taskDAO.getById(noticeTaskId)
        const ctxSpec = ctxRow?.task_spec
          ? JSON.parse(ctxRow.task_spec) as { task_type?: string; skill_groups?: string[] }
          : null
        if (ctxSpec?.task_type) {
          const lines: string[] = ['@@task_context (task-authoring-v3):']
          // Artifacts dir — only when the task home exists
          if (taskHomePath && taskArtifactsDir) {
            lines.push(`- 产物目录: ${taskArtifactsDir} — 产物文件用绝对路径写入此目录，并在该目录的 artifacts.json 登记索引条目`)
          }
          const groups = Array.isArray(ctxSpec.skill_groups) ? ctxSpec.skill_groups : []
          if (groups.length > 0) {
            lines.push(`- Skill 组已锁定: ${groups.join(', ')}（创建时锁定，不可变更；不要建议修改）`)
          }
          // Locked projects — user's "编写语境" selection, always inject so
          // the agent knows which project(s) to work in
          const projectIds: string[] = ctxRow?.project_ids
            ? JSON.parse(ctxRow.project_ids) as string[]
            : []
          if (projectIds.length > 0) {
            lines.push(`- 项目已锁定: ${projectIds.join(', ')}（用户在"编写语境"中选定的项目，agent 应在此项目上下文中工作）`)
          }
          // Only set context if we have more than just the header
          if (lines.length > 1) {
            taskContextContent = lines.join('\n')
          }
        }
      } catch (err: unknown) {
        // Non-fatal — chat reply unaffected; agent just misses the context
        // line this turn (malformed task_spec, etc.). Mirrors the
        // authoring_resources swallow+log pattern above.
        console.error(
          '[clone-route] task context resolution failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    return streamSSE(c, async (stream) => {
      let aborted = false
      const abortStream = () => { aborted = true }
      const streamId = registerActiveStream(sessionId, abortStream)

      try {
        let fullContent = ''
        let fullThinking = ''
        let resultSessionId: string | null = null
        const toolCalls: Array<{
          id: string; name: string; input?: unknown; result?: unknown; isError?: boolean; status?: string
        }> = []
        // Arrival-ordered process timeline (2026-08-19): thinking segments /
        // text fragments / tool calls interleaved as they happened. Persisted
        // in the message metadata JSON so the UI's collapsible meta can render
        // chronologically on history reload (mirrors the client-side
        // useAgentChat streamTimeline for the live turn).
        const timeline: Array<{ kind: 'thinking' | 'text' | 'tool'; text?: string; id?: string }> = []
        const memoryToolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }> = []
        const MEMORY_TOOL_NAMES = ['record_daily']

        for await (const chunk of runtime.chat(body.message!, sessionId, providerSessionId, cwd, specUpdateNotice, authoringResourcesContent, undefined, taskHomePath, taskContextContent, body.model)) {
          if (aborted || (stream as any)._aborted) break

          switch (chunk.type) {
            case 'text_delta': {
              fullContent += chunk.content
              const lastTl = timeline[timeline.length - 1]
              if (lastTl && lastTl.kind === 'text') lastTl.text = (lastTl.text ?? '') + chunk.content
              else timeline.push({ kind: 'text', text: chunk.content })
              await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: chunk.content, content: fullContent }) })
              break
            }
            case 'thinking_start':
              await stream.writeSSE({ event: 'thinking_start', data: '{}' })
              break
            case 'thinking': {
              fullThinking += chunk.content
              const lastTh = timeline[timeline.length - 1]
              if (lastTh && lastTh.kind === 'thinking') lastTh.text = (lastTh.text ?? '') + chunk.content
              else timeline.push({ kind: 'thinking', text: chunk.content })
              await stream.writeSSE({ event: 'thinking', data: JSON.stringify({ delta: chunk.content }) })
              break
            }
            case 'thinking_done':
              await stream.writeSSE({ event: 'thinking_done', data: '{}' })
              break
            case 'context_usage':
              await stream.writeSSE({ event: 'context_usage', data: JSON.stringify(chunk.data) })
              break
            case 'tool_call_start':
              toolCalls.push({ id: chunk.toolCallId, name: chunk.toolName, status: 'start' })
              timeline.push({ kind: 'tool', id: chunk.toolCallId })
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'start', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName }) })
              break
            case 'tool_call': {
              const tc = toolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) {
                tc.input = chunk.toolInput
                // Track memory tool calls (record_daily)
                if (MEMORY_TOOL_NAMES.includes(tc.name)) {
                  memoryToolCalls.push({ id: tc.id, name: tc.name, input: chunk.toolInput as Record<string, unknown> })
                }
              }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) })
              break
            }
            case 'tool_result': {
              const tc = toolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) { tc.result = chunk.content; tc.isError = chunk.isError; tc.status = chunk.isError ? 'fail' : 'result' }
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

        // 05 — the provider has now received the system-prompt append
        // (assembled + sent during the stream above), so the one-shot notice
        // is delivered. Clear it so the NEXT turn doesn't re-deliver. Gated
        // on !aborted: an aborted stream may not have fully delivered, so
        // leave the notice pending for the next turn (at-least-once). A
        // thrown stream skips this line entirely (outer catch) — also
        // leaves the notice pending for retry. Idempotent + non-fatal.
        if (noticeTaskId && specUpdateNotice && !aborted) {
          clearSpecNotice(noticeTaskId)
        }

        // Execute memory tool calls (record_daily) with clone context
        if (memoryToolCalls.length > 0 && !aborted) {
          for (const tc of memoryToolCalls) {
            const content = String(tc.input?.content ?? '')
            if (!content) continue
            try {
              const memoryService = getMemoryService()
              // Determine clone directory from clone name + type
              const cloneDir = cloneDef.type === 'built-in'
                ? getBuiltInCloneDir(cloneName)
                : getCloneDir(cloneName)
              const result = memoryService.recordDaily(org, content, sessionId, cloneDir)
              await stream.writeSSE({
                event: 'tool_call',
                data: JSON.stringify({
                  type: 'result', tool_call_id: tc.id, tool_name: tc.name,
                  content: JSON.stringify(result), is_error: false,
                }),
              })
            } catch (e) {
              await stream.writeSSE({
                event: 'tool_call',
                data: JSON.stringify({
                  type: 'result', tool_call_id: tc.id, tool_name: tc.name,
                  content: `Memory tool error: ${e instanceof Error ? e.message : String(e)}`, is_error: true,
                }),
              })
            }
          }
        }

        // Store assistant message + update provider session
        // Persist if there's ANY content — text, tool calls, or thinking.
        // Previously only text-gated (`if (fullContent)`), so messages with
        // only tool calls / thinking (e.g. user aborts before first text
        // delta) were silently lost on restart.
        const hasAnyContent = fullContent || toolCalls.length > 0 || fullThinking
        if (hasAnyContent) {
          const assistantMsgId = crypto.randomUUID()
          const assistantNow = new Date().toISOString()

          const metadata = JSON.stringify({
            thinking: fullThinking || undefined,
            tool_calls: toolCalls.length > 0
              // Mark non-terminal tool calls as 'fail' so they don't keep
              // spinning when loaded from DB after restart. Also set ended_at
              // so the elapsed timer stops counting.
              ? toolCalls.map((tc) => {
                  const terminal = tc.status === 'success' || tc.status === 'result' || tc.status === 'fail'
                  return terminal ? tc : { ...tc, status: 'fail', ended_at: Date.now() }
                })
              : undefined,
            timeline: timeline.length > 0 ? timeline : undefined,
            interrupted: aborted || undefined,
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
            const autoTitle = body.message!.slice(0, 20).replace(/\n/g, ' ').trim() || `${cloneName} 会话`
            sessionDAO.updateSession(sessionId, { title: autoTitle })
          }

          // 04 — task-author autosave seam (v2-D6/D11/SG3/SG8).
          // Fires at turn-end (after auto-title block, before done SSE),
          // gated by cloneName === 'task-author'. Best-effort — chat reply
          // unaffected on failure. First turn → create draft row + link
          // session.scope_id (SG3). Subsequent turns → targeted UPDATE
          // name+updated_at ONLY (SG8: no version bump, no task_spec touch).
          if (cloneName === 'task-author' && taskDAO) {
            const autoTitle = sessionDAO.findById(sessionId)?.title ?? `${cloneName} 会话`
            autosaveTaskDraft(
              { taskDAO, sessionDAO },
              { sessionId, org, autoTitle },
            )
          }

          await stream.writeSSE({
            event: 'done',
            data: JSON.stringify({
              session_id: sessionId,
              message_id: assistantMsgId,
              session_title: sessionDAO.findById(sessionId)?.title,
              model: body.model ?? cloneDef.config.model ?? undefined,
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
