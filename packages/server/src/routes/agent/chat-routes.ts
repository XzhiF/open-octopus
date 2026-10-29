// packages/server/src/routes/agent/chat-routes.ts
//
// Agent chat SSE streaming endpoint + stop generation.
// The chat handler orchestrates intent classification, LLM streaming (Claude SDK),
// session compression, workspace rules injection, and debug logging.
//
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getProvider } from '@octopus/providers'
import type { OctopusAgentDef } from '@octopus/providers'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createAgentError } from './middleware'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import { getNotificationService } from '../../services/agent/notification-service'
import { getSessionCompressService } from '../../services/agent/session-compress-service'
import { getAgentService, isStreamActive, registerActiveStream, unregisterActiveStream } from '../../services/agent/agent-service'
import { getSafetyInterceptor } from '../../services/agent/safety-interceptor'
import { getAgentDir, getDailyMemoryDir, getExperiencesDir, getDebugTracesDir } from '../../services/agent/paths'
import { deriveSessionTitle } from '../../services/agent/session-title'
import { isResumeFailureMessage, migrateProviderTranscript, usableResumeId } from '../../services/agent/resume'
import type { AgentSessionDAO, SafetyDAO, ScheduleConfigDAO } from '../../db/dao'
import { SessionCacheContextDAO } from '../../db/dao/session-cache-context-dao'
import { resolveSessionExpertRoster } from '../../services/agent/session-expert-roster'
import { parseCloneMentions, resolveCloneSubagents } from '../../services/agent/clone-resolver'
import { pendingRoleCard } from '../../services/agent/role-card'
import { appendRoleSwitchEvent, roleSwitchEventPayload } from '../../services/agent/role-switch-event'
import { withTransientReminder } from '../../services/agent/prompt-reminder'
import { recordProviderResultUsage } from '../../services/llm-call-ledger'
import { createWorkflowToolServer } from '../../services/chat/workflow-tools'
import { createTaskToolServer } from '../../services/chat/task-tools'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import type { EffortLevel } from '@octopus/shared'
import { parseComposerContext, parseComposerEffort, resolveChatModel } from './composer-options'
import type { TaskThreadService } from '../../services/tasks/task-thread-service'
import { commitWorkspaceEdits, quickEditMarkerFor } from '../../services/tasks/quick-edit'

export interface ChatRouteDeps {
  sessionDAO: AgentSessionDAO
  safetyDAO: SafetyDAO
  scheduleConfigDAO: ScheduleConfigDAO
  /** 会话 token 角标（llm_calls 账本）—— 与 clone / main-agent 路由共用落账 helper。 */
  tokenUsageDao?: TokenUsageDAO
  /** 服务端唤醒（ChatEventBridge）→ 前端 session SSE 通知。 */
  sse?: import('../../services/sse').SSEService
  /** 2026-10-28 task-thread: one main chat per task, identity by task state. */
  taskThread?: TaskThreadService
}

export function createChatRoutes(deps: ChatRouteDeps): Hono {
  const { sessionDAO: sessionDao, safetyDAO, scheduleConfigDAO, tokenUsageDao, sse, taskThread } = deps
  const app = new Hono()

  // ── Session running state（"关闭不丢失"）──────────────────────────
  // running = 内存里仍有该会话的生成流；partial = DB 里还有 streaming partial。
  // 刷新/重开页面时前端先探测这里，再轮询 messages 续看上一条回复。
  app.get('/sessions/:id/running', (c) => {
    const id = c.req.param('id')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    return c.json({
      running: isStreamActive(id),
      partial: sessionDao.hasStreamingMessage(id),
    })
  })

  // ── Chat SSE streaming ─────────────────────────────────────────────
  app.post('/sessions/:id/chat', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || ''

    const id = c.req.param('id')

    let body: {
      message?: string; system_prompt?: string; model?: string; effort?: string; maxContext?: string
      subagents?: Array<{ id: string; label?: string }>
      /** Server-originated activity wake (ChatEventBridge). */
      wake?: boolean
      activity?: Record<string, unknown>
      /** 2026-10-28 task-thread: the bridge already appended the deterministic
       *  event card, so the wake turn must not persist a second copy. */
      ephemeral?: boolean
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid JSON body'), 400)
    }

    if (!body.message) {
      return c.json(createAgentError('INVALID_PARAM', 'message is required'), 400)
    }

    const effort = parseComposerEffort(body.effort)
    const model = resolveChatModel(body.model, parseComposerContext(body.maxContext))

    // Verify session exists
    const session = sessionDao.findSessionById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }

    // Store user message. Ephemeral wakes (task-thread event cards) reach the
    // model but are NOT persisted — the bridge already wrote the card.
    const userMsgId = crypto.randomUUID()
    const now = new Date().toISOString()
    if (!body.ephemeral) {
      sessionDao.insertMessage({
        id: userMsgId, session_id: id, role: 'user',
        content: body.message, created_at: now,
        ...(body.wake
          ? { metadata: JSON.stringify({ displayType: 'event', activity: body.activity ?? null }) }
          : {}),
      })
      sessionDao.updateLastMessageAt(id, now)
    }

    // ── Safety: detect dangerous commands in user message (B5 fix) ────
    try {
      const interceptor = getSafetyInterceptor()
      if (interceptor.isDangerousCommand(body.message)) {
        const reason = interceptor.getDangerReason(body.message)
        safetyDAO.insertSafetyEvent({
          type: 'dangerous_command',
          operation: body.message.slice(0, 200),
          decision: 'intercept',
          actor: 'user',
          context: JSON.stringify({ reason, session_id: id }),
          timestamp: now,
        })
      }
    } catch {
      // Safety check failure is non-fatal — proceed with chat
    }

    // v58: the session's cwd (selected workspace/directory) is the agent's
    // working directory; legacy sessions fall back to the agent home.
    const sessionCwd = session.cwd
      ? path.resolve(session.cwd.replace(/^~/, os.homedir()))
      : getAgentDir()

    // 2026-10-28 task-thread: a MAIN session bound to a task gets a per-turn
    // profile (identity / cwd / guard / plugins / context). Legacy clone
    // sessions and free chat sessions resolve to null and are untouched.
    const thread = taskThread?.resolveForSession({
      id,
      clone_name: session.clone_name ?? null,
    }) ?? null
    const effectiveCwd = thread?.cwd ?? sessionCwd
    // The SDK keys its transcript by cwd. Identity switches move the thread
    // task home → execution workspace; carry the provider transcript across so
    // the one-chat promise survives the switch. Best-effort + idempotent.
    if (thread && session.provider_session_id && path.resolve(sessionCwd) !== path.resolve(effectiveCwd)) {
      migrateProviderTranscript(sessionCwd, effectiveCwd, session.provider_session_id)
    }

    // Assemble system prompt. The prompt is part of the provider's cached
    // prefix, so a resumed session freezes it on first use: re-reading persona
    // / memory / skills every turn would invalidate the whole transcript cache.
    // Task-thread identity is a ROLE CARD (below), never a rebuilt prompt.
    const assembler = new SystemPromptAssembler(org)
    const cacheCtx = new SessionCacheContextDAO(sessionDao.getDb())
    // 2026-10-28 task-thread: keep the session role aligned with the task state.
    // The full task-author / task-doer personas are delivered ONCE per identity
    // transition as a role card (cache discipline), never re-injected per turn.
    // A user-picked third clone is respected until the next task transition.
    if (thread) {
      const desired = thread.identity === 'author'
        ? 'task-author'
        : thread.identity === 'doer'
          ? 'task-doer'
          : null
      const currentRole = cacheCtx.getRoleState(id)
      const taskRoles = new Set(['task-author', 'task-doer'])
      if (
        (currentRole.activeExpert == null || taskRoles.has(currentRole.activeExpert)) &&
        currentRole.activeExpert !== desired
      ) {
        cacheCtx.setActiveExpert(id, desired, 'clone')
      }
    }
    const systemPrompt = body.system_prompt ?? cacheCtx.getOrCreatePromptSnapshot(
      id,
      () => assembler.assemble({ clone_name: session.clone_name ?? undefined }),
    ).systemPrompt
    // Native SDK resume: the transcript (and its cache prefix) continues
    // across turns. A pointer whose transcript is gone is treated as cold and
    // cleared, so a restored DB never bricks the conversation.
    const resumeSessionId = usableResumeId(effectiveCwd, session.provider_session_id)
    if (session.provider_session_id && !resumeSessionId) {
      sessionDao.clearProviderSession(id)
      // The provider transcript is gone → the active role card must be replayed.
      cacheCtx.resetRoleDelivery(id)
    }

    // Identity switch (role card) and @ delegation (one-turn subagent consult)
    // both ride the user message. system prompt / tools / agents stay stable.
    const roleState = cacheCtx.getRoleState(id)
    const roleCard = pendingRoleCard(roleState)
    const self = session.clone_name ?? null
    const consults = [
      ...parseCloneMentions(body.message!),
      ...(body.subagents ?? []).map((ref) => ({ name: ref.id, displayName: ref.label ?? ref.id })),
    ].filter((c, i, all) => c.name !== self && all.findIndex((x) => x.name === c.name) === i)
    const roster = resolveSessionExpertRoster(cacheCtx, {
      sessionId: id,
      requested: consults.map((c) => c.name),
    })
    const agents = resolveCloneSubagents(roster)
    const mentionReminder = consults.length > 0
      ? `用户本轮委派了以下分身：${consults.map((c) => c.displayName).join('、')}。请调用对应的 subagent 获取其专业意见，再整合成最终回答；不要简单拼接。`
      : undefined
    // Task state is injected per turn (never into the frozen system prompt).
    const turnReminder = [roleCard, mentionReminder, thread?.context].filter(Boolean).join('\n\n')
    const providerMessage = withTransientReminder(body.message!, turnReminder)
    // Workflow control tools (list/run/status/cancel/approve/retry) are
    // registered as an in-process MCP server bound to this chat's workspace.
    // A task thread also gets the read/action tools (spec + confirm cards).
    const mcpWorkspaceId = thread?.task.workspaceId ?? session.workspace_id
    const toolServers: Record<string, unknown> = {}
    if (mcpWorkspaceId) {
      toolServers['octopus-workflow'] = createWorkflowToolServer(mcpWorkspaceId, { sessionId: id, org })
    }
    if (thread) {
      toolServers['octopus-task'] = createTaskToolServer({
        db: sessionDao.getDb(),
        sessionId: id,
        profile: thread,
        identity: thread.identity,
      })
    }
    const mcpServers = Object.keys(toolServers).length > 0 ? toolServers : undefined

    // ── Trigger self-check on first message (E2E-055) ──────────────
    runSelfCheck()

    // Stream SSE response
    return streamSSE(c, async (stream) => {
      let aborted = false
      const abortStream = () => { aborted = true }
      const streamId = registerActiveStream(id, abortStream)
      // Wake turns have no client-owned SSE; tell the open chat to tail the
      // server-side partial (same stream-resume path as reopening a dialog).
      const notifyWake = (phase: 'started' | 'done') => {
        if (!body.wake || !session.workspace_id || !sse) return
        sse.emit(session.workspace_id, {
          event: 'session_updated',
          data: { sessionId: id, wake: true, phase },
        })
      }
      notifyWake('started')

      // Execution identity: land one marked commit per dirty repo after the
      // turn (announced before the terminal `done` frame — same frame name as
      // the doer chat). Defined here so it closes over the SSE stream.
      const onTurnComplete = thread?.autoCommit && thread.task.wsPath
        ? async () => {
            const commits = await commitWorkspaceEdits({
              wsPath: thread.task.wsPath!,
              taskId: thread.task.id,
              sessionId: id,
              content: body.message!,
              marker: quickEditMarkerFor(thread.takeover),
            })
            for (const cm of commits) {
              await stream.writeSSE({
                event: 'quick_edit_commit',
                data: JSON.stringify({ sessionId: id, taskId: thread.task.id, ...cm }),
              })
            }
          }
        : undefined

      try {
        // Step 1: Auto-compress long sessions
        await autoCompressSession(id, org, stream)

        if (aborted) {
          await stream.writeSSE({ event: 'done', data: JSON.stringify({ session_id: id, aborted: true }) })
          return
        }

        // Step 2: Try Claude SDK integration (orchestration now handled by Main Agent route)
        const llmResult = await tryClaudeSDK(body.message!, systemPrompt, stream, id, org, sessionDao, undefined, undefined, model, effort, {
          resumeSessionId,
          providerMessage,
          agents,
          cwd: effectiveCwd,
          mcpServers,
          plugins: thread?.plugins,
          onBeforeToolCall: thread?.guard,
          onTurnComplete,
          onResult: roleCard
            ? () => {
                cacheCtx.markRoleDelivered(id, roleState.revision)
                appendRoleSwitchEvent(sessionDao.getDb(), id, roleSwitchEventPayload(roleState, roleCard))
              }
            : undefined,
        })

        // Step 3: Fallback if Claude SDK unavailable
        if (!llmResult.generated) {
          await sendFallbackResponse(body.message!, stream, id, org, sessionDao, undefined)
        }
        // 新建开发任务：首轮结束后让 AI 总结任务标题（名字仍等于这条消息的
        // 确定性截串才替换）。放在主调用之后跑 —— 起名请求若与主流并发，会
        // 和共享 LLMCallTracker 的 message_delta 抢同一批 active call。
        if (llmResult.generated && thread && !body.wake) {
          taskThread?.maybeAdoptSmartTaskName(id, body.message)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'STREAM_ERROR', message: msg }) })
      } finally {
        unregisterActiveStream(id, streamId)
        notifyWake('done')
      }
    })
  })

  // ── Stop generation ──────────────────────────────────────────────────
  app.post('/sessions/:id/stop', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || ''
      const id = c.req.param('id')
      const result = await getAgentService().stopChat(org, id)
      return c.json({ success: true, ...result })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json(createAgentError('INTERNAL_ERROR', msg), 500)
    }
  })

  // ── Private helpers ──────────────────────────────────────────────────

  function runSelfCheck(): void {
    const selfCheckMarker = path.join(getAgentDir(), '.self-check-last')
    const shouldSelfCheck = !fs.existsSync(selfCheckMarker) ||
      (Date.now() - fs.statSync(selfCheckMarker).mtimeMs) > 7 * 24 * 60 * 60 * 1000
    if (!shouldSelfCheck) return
    try {
      const dailyDir = getDailyMemoryDir()
      const experiencesDir = getExperiencesDir()
      if (fs.existsSync(dailyDir)) {
        const files = fs.readdirSync(dailyDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 7)
        const allContent = files.map(f => { try { return fs.readFileSync(path.join(dailyDir, f), 'utf-8') } catch { return '' } }).join('\n')
        const words = allContent.toLowerCase().match(/\b[a-z一-鿿]{2,}\b/g) ?? []
        const freq = new Map<string, number>()
        for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
        const patterns = [...freq.entries()].filter(([, c]) => c >= 3).map(([w]) => w).slice(0, 10)
        if (patterns.length > 0) {
          if (!fs.existsSync(experiencesDir)) fs.mkdirSync(experiencesDir, { recursive: true })
          const now = new Date().toISOString()
          fs.writeFileSync(
            path.join(experiencesDir, `self-check-${now.replace(/[:.]/g, '-')}.md`),
            `# 自检经验 ${now}\n\n## 重复模式\n${patterns.map(p => `- ${p}`).join('\n')}\n`, 'utf-8',
          )
        }
      }
      fs.writeFileSync(selfCheckMarker, new Date().toISOString(), 'utf-8')
    } catch { /* non-fatal */ }
  }

  async function autoCompressSession(id: string, org: string, stream: any): Promise<void> {
    try {
      const compressService = getSessionCompressService(org)
      if (compressService.needsCompression(id)) {
        await compressService.compressSession(id)
        await stream.writeSSE({
          event: 'status',
          data: JSON.stringify({ status: 'compressed', message: '会话上下文已压缩' }),
        })
      }
    } catch { /* non-fatal */ }
  }

  async function tryClaudeSDK(
    message: string, systemPrompt: string, stream: any, sessionId: string,
    org: string, sessionDao: AgentSessionDAO, orchestrationResult: string | undefined,
    orchestrationFullResult: any, model?: string, effort?: EffortLevel,
    extra?: {
      resumeSessionId?: string
      /** Message actually sent to the provider (raw + role card/@ reminder). */
      providerMessage?: string
      /** Stable SDK agents map (full expert roster) — never changes per turn. */
      agents?: Record<string, OctopusAgentDef>
      /** Session cwd (workspace/selected directory); defaults to agent home. */
      cwd?: string
      /** In-process MCP servers (workflow control tools). */
      mcpServers?: Record<string, unknown>
      /** Stable skill-discovery set for a task thread (agent + author + home). */
      plugins?: Array<{ type: 'local'; path: string }>
      /** Per-turn write guard (author fence / doer batch fence / read-only). */
      onBeforeToolCall?: (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>
      /** After the turn: land [quick-edit] commits for a task thread. */
      onTurnComplete?: () => Promise<void> | void
      /** Called once when the turn produces a result (mark role card delivered). */
      onResult?: () => void
    },
  ): Promise<{ generated: boolean }> {
    const resumeSessionId = extra?.resumeSessionId
    const providerMessage = extra?.providerMessage ?? message
    let resultNotified = false
    let generated = false
    let fullContent = ''
    let fullThinking = ''
    const currentToolCalls: Array<{ id: string; name: string; input?: unknown; result?: unknown; status?: string }> = []
    // 流式时间线（与客户端 StreamTimelineItem 同形）：thinking/text 段 + 工具 id，
    // 按到达顺序。写进 partial 的 metadata，切走再切回的会话据此原样重建实时块
    // （2026-10-29 用户：切回来只见一条「已完成」外观的消息 +「Agent 思考中」）。
    type TurnTimelineEntry =
      | { kind: 'thinking'; text: string }
      | { kind: 'text'; text: string }
      | { kind: 'tool'; id: string }
    const turnTimeline: TurnTimelineEntry[] = []
    const pushTimeline = (entry: TurnTimelineEntry) => {
      if (entry.kind === 'tool') { turnTimeline.push(entry); return }
      const last = turnTimeline[turnTimeline.length - 1]
      if (last && last.kind === entry.kind) last.text += entry.text
      else turnTimeline.push({ kind: entry.kind, text: entry.text })
    }
    const timelineMetadata = () =>
      turnTimeline.length > 0 ? JSON.stringify({ timeline: turnTimeline }) : null
    // "关闭不丢失"：流式期间增量写同一条 assistant partial（metadata.streaming），
    // 刷新/重开时前端用 running + messages 轮询续看；轮次结束再原地 finalize。
    const assistantMsgId = crypto.randomUUID()
    let partialRowId: string | null = null
    // Wrapper for the messages.tool_calls column. Write null when there is
    // nothing to keep — JSON.stringify of all-undefined fields persists "{}",
    // a truthy non-iterable that readers can hand to the transcript UI (which
    // iterates it) and blank the whole app.
    const serializeTurnExtras = (thinking: string, tools: unknown[]): string | null =>
      thinking || tools.length > 0
        ? JSON.stringify({
            thinking: thinking || undefined,
            tool_calls: tools.length > 0 ? tools : undefined,
          })
        : null
    // 中途失败 / 没有正文时也要把 partial 收尾，避免永久 streaming。
    const finalizePartial = () => {
      if (!partialRowId) return
      try {
        const assistantNow = new Date().toISOString()
        const toolCallsJson = serializeTurnExtras(
          fullThinking,
          currentToolCalls.map((tc) => {
            const terminal = tc.status === 'success' || tc.status === 'result' || tc.status === 'fail'
            return terminal ? tc : { ...tc, status: 'fail' }
          }),
        )
        sessionDao.updateMessage(assistantMsgId, {
          content: fullContent, tool_calls: toolCallsJson, metadata: timelineMetadata(),
        })
        sessionDao.updateLastMessageAt(sessionId, assistantNow)
      } catch (err: unknown) {
        console.error(
          '[agent-chat] partial finalize failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    const RESUME_FAILED = Symbol('resume-failed')
    const isResumeFailure = isResumeFailureMessage

    try {
      const provider = getProvider('claude')
      const cwd = extra?.cwd ?? getAgentDir()
      const turnStartedAtMs = Date.now()

      let lastFlushAt = 0
      const partialFlushMs = 500
      const partialToolCalls = () => serializeTurnExtras(fullThinking, currentToolCalls)
      const maybeFlushPartial = () => {
        try {
          if (Date.now() - lastFlushAt < partialFlushMs) return
          if (!fullContent && !fullThinking && currentToolCalls.length === 0) return
          lastFlushAt = Date.now()
          const toolCallsJson = partialToolCalls()
          const metadata = JSON.stringify({
            streaming: true,
            ...(turnTimeline.length > 0 ? { timeline: turnTimeline } : {}),
          })
          if (!partialRowId) {
            sessionDao.insertMessage({
              id: assistantMsgId, session_id: sessionId, role: 'assistant',
              content: fullContent, tool_calls: toolCallsJson, metadata,
              created_at: new Date().toISOString(),
            })
            partialRowId = assistantMsgId
          } else {
            sessionDao.updateMessage(assistantMsgId, { content: fullContent, tool_calls: toolCallsJson, metadata })
          }
        } catch (err: unknown) {
          console.error(
            '[agent-chat] partial flush failed (non-fatal):',
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      const consume = async (resume: string | undefined) => {
        for await (const chunk of provider.sendQuery(providerMessage, cwd, resume, {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(extra?.agents ? { agents: extra.agents } : {}),
          ...(extra?.mcpServers ? { mcpServers: extra.mcpServers } : {}),
          ...(extra?.plugins ? { plugins: extra.plugins } : {}),
          ...(extra?.onBeforeToolCall ? { onBeforeToolCall: extra.onBeforeToolCall } : {}),
        })) {
          if ((stream as any)._aborted) break
          switch (chunk.type) {
            case 'text_delta':
              fullContent += chunk.content
              pushTimeline({ kind: 'text', text: chunk.content })
              await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: chunk.content, content: fullContent }) })
              break
            case 'thinking_start':
              await stream.writeSSE({ event: 'thinking_start', data: '{}' })
              break
            case 'thinking':
              fullThinking += chunk.content
              pushTimeline({ kind: 'thinking', text: chunk.content })
              await stream.writeSSE({ event: 'thinking', data: JSON.stringify({ delta: chunk.content }) })
              break
            case 'thinking_done':
              await stream.writeSSE({ event: 'thinking_done', data: '{}' })
              break
            case 'context_usage':
              // composer ctx 角标（与 clone chat 同事件）：主对话此前丢了这个 chunk，
              // 导致 ctx 永远停在占位。
              // Persist alongside the SSE forward: the browser-side cache dies with
              // the profile, so the session row is the only source a cold load
              // (refresh / server restart / another browser) can paint from.
              try { sessionDao.updateContextUsage(sessionId, JSON.stringify(chunk.data)) } catch { /* telemetry — never break the turn */ }
              await stream.writeSSE({ event: 'context_usage', data: JSON.stringify(chunk.data) })
              break
            case 'tool_call_start':
              currentToolCalls.push({ id: chunk.toolCallId, name: chunk.toolName, status: 'start' })
              pushTimeline({ kind: 'tool', id: chunk.toolCallId })
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'start', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName }) })
              break
            case 'tool_call': {
              const tc = currentToolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) tc.input = chunk.toolInput
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) })
              break
            }
            case 'tool_result': {
              const tc = currentToolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) { tc.result = chunk.content; tc.status = chunk.isError ? 'fail' : 'result' }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'result', tool_call_id: chunk.toolCallId, content: chunk.content, is_error: chunk.isError }) })
              break
            }
            case 'status':
              await stream.writeSSE({ event: 'status', data: JSON.stringify({ status: chunk.status }) })
              break
            case 'result':
              generated = true
              // Native resume: persist the SDK session id so the next turn (and
              // its prompt cache prefix) continues instead of starting cold.
              if (chunk.sessionId) sessionDao.updateProviderSession(sessionId, chunk.sessionId)
              // tok 角标数据源：会话 llm_calls 账本。此前主对话不落账，
              // /api/sessions/:id/llm-calls 恒空 → chip 永远 tok --。
              if (tokenUsageDao) {
                recordProviderResultUsage({
                  sourcePath: 'global_chat',
                  nodeExecutionId: null,
                  executionId: null,
                  sessionId,
                  org,
                  startedAtMs: turnStartedAtMs,
                  modelUsages: chunk.modelUsages,
                  usage: chunk.usage,
                }, tokenUsageDao)
              }
              if (!resultNotified) {
                resultNotified = true
                extra?.onResult?.()
              }
              break
            case 'error':
              // A stale resume id must not kill the turn — retry once without
              // resume before surfacing the error (clone chat has the same
              // degradation; see CloneRuntime.chat).
              if (resume && !generated && !fullContent && isResumeFailure(chunk.message)) {
                throw RESUME_FAILED
              }
              await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: chunk.code, message: chunk.message }) })
              break
          }
          maybeFlushPartial()
        }
      }

      try {
        await consume(resumeSessionId)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const noOutput = !generated && !fullContent && !fullThinking && currentToolCalls.length === 0
        if (resumeSessionId && noOutput && (err === RESUME_FAILED || isResumeFailure(errMsg))) {
          console.warn('[agent-chat] resume failed, retrying without resume:', errMsg)
          sessionDao.clearProviderSession(sessionId)
          await consume(undefined)
        } else {
          throw err
        }
      }

      // Task-thread execution turns: commit whatever the turn actually changed.
      // Runs BEFORE the terminal `done` frame (the client treats `done` as the
      // end of the stream, so trailing frames would be dropped) and even after
      // a model error — the files on disk are the truth.
      try {
        await extra?.onTurnComplete?.()
      } catch (err: unknown) {
        console.warn(
          '[agent-chat] onTurnComplete failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        )
      }

      if (generated && fullContent) {
        const assistantNow = new Date().toISOString()
        const toolCallsJson = serializeTurnExtras(fullThinking, currentToolCalls)
        if (partialRowId) {
          sessionDao.updateMessage(assistantMsgId, {
            content: fullContent, tool_calls: toolCallsJson, metadata: timelineMetadata(),
          })
        } else {
          sessionDao.insertMessage({
            id: assistantMsgId, session_id: sessionId, role: 'assistant',
            content: fullContent, tool_calls: toolCallsJson, metadata: timelineMetadata(),
            created_at: assistantNow,
          })
        }
        sessionDao.updateLastMessageAt(sessionId, assistantNow)

        autoGenerateTitle(sessionId, org, message, sessionDao)
        recordDebugLog(assistantMsgId, sessionId, assistantNow, fullContent.length, 'chat', orchestrationResult, orchestrationFullResult, org)

        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({
            session_id: sessionId, message_id: assistantMsgId,
            orchestration: orchestrationResult,
            session_title: sessionDao.findById(sessionId)?.title,
          }),
        })
      } else if (partialRowId) {
        finalizePartial()
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[agent] Claude SDK call failed: ${errMsg}`, err instanceof Error ? err.stack : '')
      finalizePartial()
    }
    return { generated }
  }

  function autoGenerateTitle(sessionId: string, org: string, message: string, dao: AgentSessionDAO): void {
    try {
      const sessionRow = dao.findById(sessionId)
      if (sessionRow && sessionRow.title === '新会话') {
        const rawMsg = message.replace(/\n/g, ' ').trim()
        const autoTitle = deriveSessionTitle(message)
        dao.updateSession(sessionId, { title: autoTitle || '新会话' })

        // Fire-and-forget LLM title refinement
        setImmediate(async () => {
          try {
            const provider = getProvider('claude')
            const cwd = getAgentDir()
            let titleContent = ''
            for await (const chunk of provider.sendQuery(
              `Generate a concise session title (max 20 chars, Chinese preferred) from: "${rawMsg.slice(0, 200)}". Reply with ONLY the title.`,
              cwd, undefined, { model: 'haiku' },
            )) {
              if (chunk.type === 'text_delta') titleContent += chunk.content
            }
            if (titleContent) {
              const llmTitle = titleContent.trim().replace(/[.。,，!！?？""]/g, '').slice(0, 30)
              if (llmTitle && llmTitle !== autoTitle) {
                dao.updateSessionIfActive(sessionId, { title: llmTitle })
              }
            }
          } catch { /* non-fatal */ }
        })
      }
    } catch { /* non-fatal */ }
  }

  function recordDebugLog(
    chatId: string, sessionId: string, timestamp: string, contentLength: number,
    source: string, orchestration: string | undefined, orchestrationFullResult: any,
    org: string,
  ): void {
    try {
      // Check debug.enabled config — skip if disabled
      const { getConfigManager } = require('../../services/agent/config-manager')
      const config = getConfigManager().getConfig(org)
      if (!config.debug?.enabled) return

      const debugDir = getDebugTracesDir()
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true })
      const debugEntry = {
        chat_id: chatId, session_id: sessionId, timestamp,
        level: 'info', source,
        message: `Chat completed: ${contentLength} chars`,
        orchestration: orchestration ?? null,
        workflow: orchestrationFullResult?.workflow?.workflow_name ?? null,
        intent: orchestrationFullResult?.intent?.intent ?? null,
      }
      const traceFile = path.join(debugDir, `${new Date().toISOString().split('T')[0]}.jsonl`)
      fs.appendFileSync(traceFile, JSON.stringify(debugEntry) + '\n', 'utf-8')
    } catch { /* non-fatal */ }
  }

  async function sendFallbackResponse(
    message: string, stream: any, sessionId: string, org: string,
    dao: AgentSessionDAO, orchestrationResult: string | undefined,
  ): Promise<void> {
    const orchestratorPrefix = orchestrationResult ? `📋 编排分析: ${orchestrationResult}\n\n` : ''
    const fallbackResponse = `${orchestratorPrefix}收到消息: "${message}"。\n\n⚠️ Claude SDK 未配置或不可用。请配置 ANTHROPIC_API_KEY 环境变量以启用完整 LLM 对话功能。\n\n当前可用的编排能力：\n- 意图分类（单次任务/定时任务/信息查询/分身管理）\n- 工作流匹配与选择\n- 记忆系统读写\n- 会话上下文压缩`

    const chars = fallbackResponse.split('')
    let fullContent = ''
    for (const char of chars) {
      fullContent += char
      await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: char, content: fullContent }) })
      await stream.sleep(5)
    }

    const assistantMsgId = crypto.randomUUID()
    const assistantNow = new Date().toISOString()
    dao.insertMessage({ id: assistantMsgId, session_id: sessionId, role: 'assistant', content: fullContent, created_at: assistantNow })
    dao.updateLastMessageAt(sessionId, assistantNow)

    try {
      const sessionRow = dao.findById(sessionId)
      if (sessionRow && sessionRow.title === '新会话') {
        const autoTitle = message.slice(0, 50).replace(/\n/g, ' ').trim()
        dao.updateSession(sessionId, { title: autoTitle || '新会话' })
      }
    } catch { /* non-fatal */ }

    recordDebugLog(assistantMsgId, sessionId, assistantNow, fullContent.length, 'chat_fallback', orchestrationResult, undefined, org)

    await stream.writeSSE({
      event: 'done',
      data: JSON.stringify({
        session_id: sessionId, message_id: assistantMsgId,
        orchestration: orchestrationResult, mode: 'fallback',
        session_title: dao.findById(sessionId)?.title,
      }),
    })
  }

  return app
}
