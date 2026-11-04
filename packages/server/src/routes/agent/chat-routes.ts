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
import { createTurnStream, DEFAULT_HEARTBEAT_MS } from '../../services/agent/turn-stream'
import { SystemPromptAssembler } from '../../services/agent/system-prompt-assembler'
import { getNotificationService } from '../../services/agent/notification-service'
import { getSessionCompressService } from '../../services/agent/session-compress-service'
import { getAgentService, getActiveStreamBackgroundTasks, isStreamActive, registerActiveStream, setActiveStreamBackgroundTasks, unregisterActiveStream } from '../../services/agent/agent-service'
import { getSafetyInterceptor } from '../../services/agent/safety-interceptor'
import { getAgentDir, getDailyMemoryDir, getExperiencesDir, getDebugTracesDir } from '../../services/agent/paths'
import { deriveSessionTitle } from '../../services/agent/session-title'
import { isResumeFailureMessage, migrateProviderTranscript, usableResumeId } from '../../services/agent/resume'
import type { AgentSessionDAO, SafetyDAO, ScheduleConfigDAO } from '../../db/dao'
import { SessionCacheContextDAO } from '../../db/dao/session-cache-context-dao'
import { resolveSessionExpertRoster } from '../../services/agent/session-expert-roster'
import { parseCloneMentions, resolveCloneInfo, resolveCloneSubagents } from '../../services/agent/clone-resolver'
import { pendingRoleCard } from '../../services/agent/role-card'
import { appendRoleSwitchEvent, roleSwitchEventPayload } from '../../services/agent/role-switch-event'
import { withTransientReminder } from '../../services/agent/prompt-reminder'
import { recordProviderResultUsage, ledgerStopReason } from '../../services/llm-call-ledger'
import { SubagentRunService } from '../../services/agent/subagent-runs'
import { SessionTurnDebugDAO, hashPrompt } from '../../db/dao'
import { TurnDebugRecorder, type TurnDebugIdentity } from '../../services/agent/turn-debug-recorder'
import { expertName } from '@octopus/shared'
import { createWorkflowToolServer } from '../../services/chat/workflow-tools'
import { createTaskToolServer } from '../../services/chat/task-tools'
import { createMemoryToolServer, resolveLongTermConsent } from '../../services/chat/memory-tools'
import { getSlashCommands, rememberSlashCommands } from '../../services/chat/slash-commands'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import type { EffortLevel, ModelUsage, TokenUsage } from '@octopus/shared'
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
  /** Keep-alive interval for the chat SSE (default 15s; tests pass a small value). */
  heartbeatMs?: number
}

/** Structured failure kept on the turn outcome and persisted on the message. */
export type TurnErrorInfo = {
  code: string
  message: string
  /** Advisory for a future retry layer — P0 only surfaces it. */
  retryable?: boolean
}

type TryClaudeSDKOutcome = {
  generated: boolean
  /** The turn ended in a provider/stream failure (never a canned "success"). */
  failed?: boolean
  /** The user stopped the turn — finalized as interrupted. */
  aborted?: boolean
  error?: TurnErrorInfo
  /** Payload for the terminal `done` frame. */
  done?: Record<string, unknown>
}

/** Transient failure classes a future retry policy may act on. */
const RETRYABLE_ERROR_CODES = new Set([
  'IDLE_TIMEOUT',
  'TIMEOUT',
  'timeout',
  'RATE_LIMIT',
  'rate_limited',
  'TRANSPORT',
  'SERVER',
  'EMPTY_RESPONSE',
  'network_error',
  'overloaded',
])

function isRetryableErrorCode(code: string | undefined): boolean {
  if (!code) return false
  return RETRYABLE_ERROR_CODES.has(code) || RETRYABLE_ERROR_CODES.has(code.toLowerCase())
}

/** Debug inspector identity for this turn (base / legacy expert / clone). */
function turnDebugIdentity(
  session: { clone_name?: string | null },
  roleState: { activeExpert: string | null; activeKind: 'expert' | 'clone'; revision: number },
): TurnDebugIdentity {
  if (roleState.activeExpert) {
    if (roleState.activeKind === 'clone') {
      const info = resolveCloneInfo(roleState.activeExpert)
      return {
        id: roleState.activeExpert,
        kind: 'clone',
        name: info?.display_name ?? roleState.activeExpert,
        revision: roleState.revision,
        skills: info?.skills,
        memoryScope: info?.memory_scope,
      }
    }
    return {
      id: roleState.activeExpert,
      kind: 'expert',
      name: expertName(roleState.activeExpert),
      revision: roleState.revision,
    }
  }
  const baseClone = session.clone_name ? resolveCloneInfo(session.clone_name) : null
  return {
    id: session.clone_name ?? null,
    kind: baseClone ? 'clone' : 'base',
    name: baseClone?.display_name ?? session.clone_name ?? '主 Agent',
    revision: roleState.revision,
    skills: baseClone?.skills,
    memoryScope: baseClone?.memory_scope,
  }
}

export function createChatRoutes(deps: ChatRouteDeps): Hono {
  const { sessionDAO: sessionDao, safetyDAO, scheduleConfigDAO, tokenUsageDao, sse, taskThread, heartbeatMs } = deps
  const app = new Hono()
  // 子代理作业记录（作业坞「子代理」）：provider subagent chunk → DB，
  // 读侧按需从 SDK transcript 回填单代理 token。
  const subagentRuns = new SubagentRunService(sessionDao.getDb())

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
      // resume 回来时补显示「等待后台」——SSE 不重连也能看到在跑什么。
      background_tasks: getActiveStreamBackgroundTasks(id),
    })
  })

  // ── Slash commands advertised by the CLI for this session ─────────
  // Populated from `system:init` on every turn. Empty means "not seen yet in
  // this server process" — the composer then falls back to its known list.
  app.get('/sessions/:id/slash-commands', (c) => {
    const id = c.req.param('id')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    return c.json({ commands: getSlashCommands(id) })
  })

  // ── Subagents spawned by this session's main Agent ────────────────
  // 作业坞「子代理」的数据源。运行中 / 已完成都返回；steps 只在详情端点里给。
  app.get('/sessions/:id/subagents', (c) => {
    const id = c.req.param('id')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    return c.json({ runs: subagentRuns.list(id) })
  })

  app.get('/sessions/:id/subagents/:agentId', (c) => {
    const id = c.req.param('id')
    const agentId = c.req.param('agentId')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    const run = subagentRuns.find(id, agentId)
    if (!run) {
      return c.json(createAgentError('NOT_FOUND', `Subagent ${agentId} not found`), 404)
    }
    return c.json({ run })
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
    // Memory tools are for the free main chat only. Task threads are identity-
    // driven and their write surface is owned by the path guard — a doer turn
    // must not write task-local detail into the main agent's memory. The tool
    // list stays constant for free chats; only remember's consent verdict
    // changes per turn (cached prompt prefix stays intact).
    if (!thread) {
      toolServers['octopus-memory'] = createMemoryToolServer(
        { sessionId: id, org },
        { longTermConsent: resolveLongTermConsent(body.message ?? '') },
      )
    }
    const mcpServers = Object.keys(toolServers).length > 0 ? toolServers : undefined

    // ── Trigger self-check on first message (E2E-055) ──────────────
    runSelfCheck()

    // Stream SSE response
    return streamSSE(c, async (stream) => {
      let aborted = false
      // 停止按钮要真的掐掉 provider 查询：只置布尔位得等下一个 chunk 才生效，
      // 模型长时间思考 / 工具调用期间按停止会一直挂着（2026-10-29 用户：
      // 中断后会话像没了一样）。AbortSignal 直接让 SDK 迭代结束，路由随即
      // finalize 出「本轮被截断」行。
      const abortController = new AbortController()
      const abortStream = () => { aborted = true; abortController.abort() }
      const streamId = registerActiveStream(id, abortStream)
      // P0-3: terminal-frame guarantee + keep-alive. Every write below goes
      // through this wrapper; the turn's last frame is emitted exactly once by
      // `turn.terminate(...)`. A heartbeat every 15s lets the browser tell a
      // long model think apart from a dead socket.
      const turn = createTurnStream(stream)
      turn.startHeartbeat(heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
      const turnStream = turn.stream
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
              await turnStream.writeSSE({
                event: 'quick_edit_commit',
                data: JSON.stringify({ sessionId: id, taskId: thread.task.id, ...cm }),
              })
            }
          }
        : undefined

      try {
        // Step 1: Auto-compress long sessions
        await autoCompressSession(id, org, turnStream)

        if (aborted) {
          await turn.terminate('done', { session_id: id, aborted: true })
          return
        }

        // Step 2: Try Claude SDK integration (orchestration now handled by Main Agent route)
        // Per-turn debug snapshot (dock 「调试」). Created only after the
        // compression gate, so a turn that never reaches the provider leaves no
        // misleading "running" row. Server-originated wake turns are skipped:
        // they have no user prompt to inspect and would collide with a user
        // turn's transcript number. Best-effort by construction.
        const turnDebugDao = new SessionTurnDebugDAO(sessionDao.getDb())
        const turnDebug = body.ephemeral
          ? undefined
          : new TurnDebugRecorder({
              dao: turnDebugDao,
              sessionId: id,
              // Transcript turn number; `max` keeps the debug sequence monotonic
              // even if messages were compressed/deleted between turns.
              turnIndex: Math.max(sessionDao.countUserTurns(id), turnDebugDao.nextTurnIndex(id)),
              userMessageId: userMsgId,
              identity: turnDebugIdentity(session, roleState),
              roleCard,
              roleRevision: roleState.revision,
              model: model ?? null,
              effort: effort ?? null,
              cwd: effectiveCwd,
              providerMessage,
              systemPrompt,
              systemPromptHash: hashPrompt(systemPrompt),
              sdkOptions: {
                systemPrompt: { type: 'preset', preset: 'claude_code', appendChars: systemPrompt.length },
                model: model ?? null,
                effort: effort ?? null,
                resume: resumeSessionId ?? null,
                cwd: effectiveCwd,
                agents: Object.keys(agents ?? {}),
                mcpServers: Object.keys(mcpServers ?? {}),
                plugins: thread?.plugins ?? [],
                interruptible: true,
                settingSources: ['project', 'user'],
                allowDangerouslySkipPermissions: true,
                transientReminder: !!turnReminder,
              },
            })
        const llmResult = await tryClaudeSDK(body.message!, systemPrompt, turnStream, id, org, sessionDao, undefined, undefined, model, effort, {
          resumeSessionId,
          providerMessage,
          agents,
          cwd: effectiveCwd,
          mcpServers,
          plugins: thread?.plugins,
          onBeforeToolCall: thread?.guard,
          onTurnComplete,
          turnDebug,
          isAborted: () => aborted,
          abortSignal: abortController.signal,
          onResult: roleCard
            ? () => {
                cacheCtx.markRoleDelivered(id, roleState.revision)
                appendRoleSwitchEvent(sessionDao.getDb(), id, roleSwitchEventPayload(roleState, roleCard))
              }
            : undefined,
        })

        // Step 3: exactly one terminal frame, always. The old canned
        // `sendFallbackResponse` made every SDK failure look like an assistant
        // reply ("收到消息…") and could append a second bubble after a partial.
        // A failure is now reported as a failure (and persisted by
        // tryClaudeSDK); a stop closes with `done{aborted}` so any other tab
        // tailing this stream settles too.
        if (llmResult.aborted) {
          await turn.terminate('done', { session_id: id, aborted: true })
        } else if (llmResult.failed) {
          await turn.terminate('error', {
            session_id: id,
            code: llmResult.error?.code ?? 'PROVIDER_ERROR',
            message: llmResult.error?.message ?? '本轮运行失败',
          })
        } else {
          await turn.terminate('done', llmResult.done ?? { session_id: id })
        }
        // 新建开发任务：首轮结束后让 AI 总结任务标题（名字仍等于这条消息的
        // 确定性截串才替换）。放在主调用之后跑 —— 起名请求若与主流并发，会
        // 和共享 LLMCallTracker 的 message_delta 抢同一批 active call。
        if (llmResult.generated && !aborted && thread && !body.wake) {
          taskThread?.maybeAdoptSmartTaskName(id, body.message)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[agent-chat] turn failed before settlement:', msg)
        await turn.terminate('error', { session_id: id, code: 'STREAM_ERROR', message: msg })
      } finally {
        setActiveStreamBackgroundTasks(id, null)
        unregisterActiveStream(id, streamId)
        notifyWake('done')
        // Closes after the terminal frame has been flushed (terminate awaits
        // the serialized write chain).
        turn.close()
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
      /** Dock 「调试」 recorder — observes the provider stream + finalizes the row. */
      turnDebug?: TurnDebugRecorder
      /** Stop-button probe: the owning stream's abort flag (checked每 chunk). */
      isAborted?: () => boolean
      /** Hard-abort the provider query (stop button) — ends the SDK iterator now. */
      abortSignal?: AbortSignal
    },
  ): Promise<TryClaudeSDKOutcome> {
    const resumeSessionId = extra?.resumeSessionId
    const providerMessage = extra?.providerMessage ?? message
    const turnDebug = extra?.turnDebug
    let resultNotified = false
    let generated = false
    /** 首轮 result 之后又来了一条 assistant message = 后台任务唤醒的续轮。 */
    let continuationMarked = false
    /** 当前 assistant message 是否已经流过正文（result 只在没流过时补内容）。 */
    let streamedSinceMessageStart = false
    /** First provider/stream failure. Set once — later chunks are ignored. */
    let failure: TurnErrorInfo | undefined
    // 用户已按停止：停止后只继续消费账本所需的 result/error（见 consume）。
    let stopped = false
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
    // 中途失败 / 没有正文 / 用户按停止时把 partial 收尾，避免永久 streaming。
    // interrupted=true 是「停止按钮」的语义：行必须落成「本轮被截断」，否则
    // 用户中断后重开只看到一条普通消息，好像那一轮没发生过（2026-10-29 用户）。
    // 首次 flush 之前就被停掉时行还没插过 —— 这里补插，内容一点不丢。
    // error 存在时同样必须留痕（即使没有正文）：刷新后仍能看到「本轮运行失败」。
    const finalizePartial = (interrupted: boolean, error?: TurnErrorInfo) => {
      const hasPayload = !!partialRowId || !!fullContent || !!fullThinking || currentToolCalls.length > 0 || !!error
      // 非中断路径（错误收尾）没内容就没有可收的；中断路径必须留痕 —— 模型还没
      // 吐第一个字就被停时，这一行空的「本轮被截断」就是用户要的中断状态。
      if (!hasPayload && !interrupted) return
      try {
        const assistantNow = new Date().toISOString()
        const toolCallsJson = serializeTurnExtras(
          fullThinking,
          currentToolCalls.map((tc) => {
            const terminal = tc.status === 'success' || tc.status === 'result' || tc.status === 'fail'
            return terminal ? tc : { ...tc, status: 'fail' }
          }),
        )
        const meta: {
          timeline?: TurnTimelineEntry[]
          interrupted?: boolean
          error?: TurnErrorInfo
        } = {}
        if (turnTimeline.length > 0) meta.timeline = turnTimeline
        if (interrupted) meta.interrupted = true
        if (error) meta.error = error
        const metadata = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
        if (partialRowId) {
          sessionDao.updateMessage(assistantMsgId, {
            content: fullContent, tool_calls: toolCallsJson, metadata,
          })
        } else {
          sessionDao.insertMessage({
            id: assistantMsgId, session_id: sessionId, role: 'assistant',
            content: fullContent, tool_calls: toolCallsJson, metadata,
            created_at: assistantNow,
          })
          partialRowId = assistantMsgId
        }
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

    // 后台唤醒轮（2026-11-04）：SDK 在每个 result 里给的是**整个 query 的累计
    // modelUsage**。逐 result 直接入账会把前面的模型轮重复记一遍。这里按模型
    // 记住已入账的累计值，只把增量交给账本；`usage` 兜底路径同样按总量差算。
    const recordedModelUsage = new Map<string, ModelUsage>()
    const recordedFallbackUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const deltaModelUsages = (current: ModelUsage[] | undefined): ModelUsage[] => {
      if (!current || current.length === 0) return []
      const out: ModelUsage[] = []
      for (const mu of current) {
        const prev = recordedModelUsage.get(mu.model)
        const next: ModelUsage = {
          model: mu.model,
          inputTokens: Math.max(0, (mu.inputTokens ?? 0) - (prev?.inputTokens ?? 0)),
          outputTokens: Math.max(0, (mu.outputTokens ?? 0) - (prev?.outputTokens ?? 0)),
          cacheReadTokens: Math.max(0, (mu.cacheReadTokens ?? 0) - (prev?.cacheReadTokens ?? 0)),
          cacheCreationTokens: Math.max(0, (mu.cacheCreationTokens ?? 0) - (prev?.cacheCreationTokens ?? 0)),
          costUsd: typeof mu.costUsd === 'number'
            ? Math.max(0, mu.costUsd - (prev?.costUsd ?? 0))
            : undefined,
        }
        recordedModelUsage.set(mu.model, mu)
        if (next.inputTokens || next.outputTokens || next.cacheReadTokens || next.cacheCreationTokens) {
          out.push(next)
        }
      }
      return out
    }
    const deltaUsage = (current: TokenUsage | undefined): TokenUsage | undefined => {
      if (!current) return undefined
      const next: TokenUsage = {
        inputTokens: Math.max(0, (current.inputTokens ?? 0) - recordedFallbackUsage.inputTokens),
        outputTokens: Math.max(0, (current.outputTokens ?? 0) - recordedFallbackUsage.outputTokens),
        cacheReadTokens: Math.max(0, (current.cacheReadTokens ?? 0) - recordedFallbackUsage.cacheReadTokens),
        cacheCreationTokens: Math.max(0, (current.cacheCreationTokens ?? 0) - recordedFallbackUsage.cacheCreationTokens),
      }
      recordedFallbackUsage.inputTokens += next.inputTokens
      recordedFallbackUsage.outputTokens += next.outputTokens
      recordedFallbackUsage.cacheReadTokens += next.cacheReadTokens
      recordedFallbackUsage.cacheCreationTokens += next.cacheCreationTokens
      return next
    }

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

      // 中断收尾（2026-10-31）：停止后不再推流、不再追加正文（partial 冻结在
      // 停止点），但必须继续消费 provider 的收尾 result —— 流式输入 +
      // `Query.interrupt()` 下，被中断轮仍会产出一条 error result，里面带着
      // 已完成模型调用的真实 usage；break 掉消费循环会让它永远到不了账本。
      const consume = async (resume: string | undefined) => {
        for await (const chunk of provider.sendQuery(providerMessage, cwd, resume, {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(extra?.agents ? { agents: extra.agents } : {}),
          ...(extra?.mcpServers ? { mcpServers: extra.mcpServers } : {}),
          ...(extra?.plugins ? { plugins: extra.plugins } : {}),
          ...(extra?.onBeforeToolCall ? { onBeforeToolCall: extra.onBeforeToolCall } : {}),
          // 流式输入模式：停止按钮用 interrupt() 而非硬杀，换取带用量的 result。
          interruptible: true,
          // 2026-11-04：`run_in_background` 的 Bash 在首轮 result 后仍在跑；
          // 不继续消费的话 query 会被关掉，后台任务完成后的唤醒永远到不了
          // （用户表现为「Agent 说稍后汇报，然后会话死掉」）。
          awaitBackgroundTasks: true,
          // AskUserQuestion 交互接管（2026-11-02）：与 clone-runtime 同构。
          // 10-28 任务线程把 task-author 搬进主对话后这里漏了开关 —— SDK 在
          // headless 下直接「执行」AskUserQuestion 并回空 answers，模型把
          // 「用户没回答」当默认继续跑完。deny 后模型收轮，等用户答完以下一条
          // user 消息 resume 续流。
          interactionSession: true,
          ...(extra?.abortSignal ? { abortSignal: extra.abortSignal } : {}),
        })) {
          // 停止按钮（本路由闭包的 aborted）优先；`stream._aborted` 是旧判据，
          // 但 hono 的 node 适配器不会去置它 —— 只看它等于「按了停止服务端还在
          // 继续烧 token，直到自己跑完」，partial 也就一直来不及收尾。
          if (!stopped && (extra?.isAborted?.() || (stream as any)._aborted)) stopped = true
          // 停止后只关心 result / error（账本数据源），其余 chunk 一律丢弃。
          if (stopped && chunk.type !== 'result' && chunk.type !== 'error') continue
          turnDebug?.observe(chunk)
          switch (chunk.type) {
            case 'message_start':
              // 后台任务唤醒的续轮（2026-11-04）：首轮已经出过正文时，两段之间
              // 补一个空行，避免「服务启动中服务就绪…」粘成一句。
              if (generated && !continuationMarked) {
                continuationMarked = true
                const separator = fullContent ? '\n\n' : ''
                fullContent += separator
                await stream.writeSSE({ event: 'assistant_continue', data: JSON.stringify({ separator }) })
              }
              streamedSinceMessageStart = false
              break
            case 'text_delta':
              streamedSinceMessageStart = true
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
            case 'ask_user_question':
              // interactionSession deny 后的显式问题标记（2026-11-02）：
              // 与 clone / main-agent 路由同构，前端据此补全 AskUserQuestion
              // toolCall，回合结束后渲染可回答的问题卡。
              await stream.writeSSE({ event: 'ask_user_question', data: JSON.stringify({ tool_call_id: chunk.toolCallId, questions: chunk.questions }) })
              break
            case 'tool_result': {
              const tc = currentToolCalls.find(t => t.id === chunk.toolCallId)
              if (tc) { tc.result = chunk.content; tc.status = chunk.isError ? 'fail' : 'result' }
              await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'result', tool_call_id: chunk.toolCallId, content: chunk.content, is_error: chunk.isError }) })
              break
            }
            case 'status':
              await stream.writeSSE({ event: 'status', data: JSON.stringify({ status: chunk.status }) })
              break
            case 'background_tasks':
              // 后台任务电平：注册表供 header / running 探测，SSE 供对话内
              // 的「后台运行中：…」工作行。空数组 = 后台已清空、CLI 即将唤醒。
              setActiveStreamBackgroundTasks(sessionId, chunk.tasks)
              await stream.writeSSE({ event: 'background_tasks', data: JSON.stringify({ tasks: chunk.tasks }) })
              break
            case 'slash_commands':
              // CLI-advertised command set for this session (skills/plugins
              // included). Cache it for reloads and paint the composer menu.
              rememberSlashCommands(sessionId, chunk.commands)
              await stream.writeSSE({ event: 'slash_commands', data: JSON.stringify({ sessionId, commands: chunk.commands }) })
              break
            case 'local_command_output':
              // Some CLI versions surface local-command text here instead of an
              // assistant message. Either way it is the turn's reply.
              streamedSinceMessageStart = true
              fullContent += chunk.content
              pushTimeline({ kind: 'text', text: chunk.content })
              await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: chunk.content, content: fullContent }) })
              break
            case 'conversation_reset':
              // `/clear` semantics A: forget the provider transcript only. The
              // chat transcript and DB rows stay untouched; the next result
              // carries the fresh SDK session id and re-points the session.
              sessionDao.clearProviderSession(sessionId)
              break
            case 'subagent':
              // 作业坞「子代理」：记录主 Agent 派生的每个子代理（指令 prompt /
              // 操作日志 / 最终汇报）。单代理 token 由读侧从 transcript 回填。
              // 记账失败不能影响本轮 —— 作业坞是观测面，不是收轮条件。
              try {
                subagentRuns.applyEvent(sessionId, chunk.event, { cwd })
              } catch (err: unknown) {
                console.warn(
                  '[agent-chat] subagent record failed (non-fatal):',
                  err instanceof Error ? err.message : String(err),
                )
              }
              break
            case 'result':
              generated = true
              // Locally-executed slash commands (/context, /compact, …) answer
              // through result.content only — no stream deltas exist. Without
              // this fallback the reply is dropped and the turn never finishes.
              // 后台唤醒的续轮同理：这一段没流过正文时补上（含空行分隔）。
              if (!stopped && chunk.content && !streamedSinceMessageStart) {
                const separator = fullContent ? '\n\n' : ''
                const appended = separator + chunk.content
                fullContent += appended
                pushTimeline({ kind: 'text', text: appended })
                await stream.writeSSE({ event: 'text_delta', data: JSON.stringify({ delta: appended, content: fullContent }) })
              }
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
                  modelUsages: deltaModelUsages(chunk.modelUsages),
                  usage: deltaUsage(chunk.usage),
                }, tokenUsageDao)
              }
              if (!resultNotified) {
                resultNotified = true
                extra?.onResult?.()
              }
              break
            case 'error':
              // 中断 / 限额轮同样可能带真实用量：SDK 的 error_during_execution
              // （aborted_streaming / aborted_tools）与 error_max_* result 都带
              // usage / modelUsage，是中断后唯一能拿回的账。零值不造数由
              // recordProviderResultUsage 自己过滤。
              if (tokenUsageDao && (chunk.usage || chunk.modelUsages)) {
                recordProviderResultUsage({
                  sourcePath: 'global_chat',
                  nodeExecutionId: null,
                  executionId: null,
                  sessionId,
                  org,
                  startedAtMs: turnStartedAtMs,
                  modelUsages: deltaModelUsages(chunk.modelUsages),
                  usage: deltaUsage(chunk.usage),
                  stopReason: ledgerStopReason(chunk.sdkTerminalReason),
                }, tokenUsageDao)
              }
              // A stale resume id must not kill the turn — retry once without
              // resume before surfacing the error (clone chat has the same
              // degradation; see CloneRuntime.chat).
              if (resume && !generated && !fullContent && isResumeFailure(chunk.message)) {
                throw RESUME_FAILED
              }
              // Terminal frames are emitted by the route exactly once, after
              // the turn settles. Record the failure and stop consuming — the
              // route persists the error row and sends `error` as the last
              // frame (P0-3). A second terminal write here used to race it.
              if (!stopped) {
                failure = {
                  code: chunk.code || 'PROVIDER_ERROR',
                  message: chunk.message || '未知错误',
                  retryable: isRetryableErrorCode(chunk.code),
                }
              }
              break
          }
          if (failure) break
          if (!stopped) maybeFlushPartial()
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

      // 用户按停止 ≠ 失败：输出留成一条「本轮被截断」的实录行（interrupted），
      // 会话本身照常可续聊。路由发送 done{aborted} 让其它正在 tail 的窗口也收口。
      const aborted = stopped || (extra?.isAborted?.() ?? false)

      if (aborted) {
        finalizePartial(true)
        turnDebug?.finish({ status: 'interrupted', assistantMessageId: partialRowId })
        return { generated, aborted: true }
      }

      // Provider/stream failure (error chunk, idle timeout, …): persist the
      // error on the turn's row so a reload still shows what happened, and let
      // the route emit the single `error` terminal frame (P0-3).
      if (failure) {
        finalizePartial(false, failure)
        turnDebug?.finish({
          status: 'error',
          assistantMessageId: partialRowId ?? assistantMsgId,
          error: failure.message,
        })
        return { generated, failed: true, error: failure }
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

        turnDebug?.finish({ status: 'ok', assistantMessageId: assistantMsgId })
        autoGenerateTitle(sessionId, org, message, sessionDao)
        recordDebugLog(assistantMsgId, sessionId, assistantNow, fullContent.length, 'chat', orchestrationResult, orchestrationFullResult, org)

        return {
          generated,
          done: {
            session_id: sessionId, message_id: assistantMsgId,
            orchestration: orchestrationResult,
            session_title: sessionDao.findById(sessionId)?.title,
          },
        }
      }

      if (generated) {
        // Generated but nothing displayable (/clear, an empty /compact, a turn
        // that only produced thinking). The route still closes with `done`.
        // 完全空的一轮（无正文 / 思考 / 工具调用）通常是 provider 流对端提前断开
        // —— 2026-11-03 后台任务通知的空 result 事故就是这样静默停住。留一条
        // 告警便于下次定位；不改变行为（本地命令仍可走这条路径）。
        if (!fullContent && !fullThinking && currentToolCalls.length === 0 && !stopped) {
          console.warn(
            `[agent-chat] empty turn settled with no output (session ${sessionId}) — provider stream may have detached early`,
          )
        }
        if (partialRowId) finalizePartial(false)
        turnDebug?.finish({ status: 'ok', assistantMessageId: partialRowId })
        return {
          generated,
          done: {
            session_id: sessionId,
            orchestration: orchestrationResult,
            session_title: sessionDao.findById(sessionId)?.title,
          },
        }
      }

      // Provider yielded nothing at all (no result, no text, no error). Treat
      // it as a retryable EMPTY_RESPONSE failure — never a silent success and
      // never a canned fallback reply (P0-3).
      const emptyError: TurnErrorInfo = {
        code: 'EMPTY_RESPONSE',
        message: '模型没有返回任何内容',
        retryable: true,
      }
      finalizePartial(false, emptyError)
      turnDebug?.finish({
        status: 'error',
        assistantMessageId: partialRowId ?? assistantMsgId,
        error: emptyError.message,
      })
      return { generated: false, failed: true, error: emptyError }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      // 用户按停止触发的 abort 不是故障：不打红日志，只按「中断」收尾。
      const wasAborted = stopped || (extra?.isAborted?.() ?? false)
      if (wasAborted) {
        finalizePartial(true)
        turnDebug?.finish({ status: 'interrupted', assistantMessageId: partialRowId })
        return { generated, aborted: true }
      }
      console.error(`[agent] Claude SDK call failed: ${errMsg}`, err instanceof Error ? err.stack : '')
      const code = typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'PROVIDER_ERROR'
      const errorInfo: TurnErrorInfo = {
        code,
        message: errMsg || '未知错误',
        retryable: isRetryableErrorCode(code),
      }
      finalizePartial(false, errorInfo)
      turnDebug?.finish({
        status: 'error',
        assistantMessageId: partialRowId ?? assistantMsgId,
        error: errMsg,
      })
      return { generated, failed: true, error: errorInfo }
    }
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

  return app
}
