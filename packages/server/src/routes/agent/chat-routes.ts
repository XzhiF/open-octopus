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
import { getAgentService, getActiveStreamBackgroundTasks, getActiveStreamPhase, getActiveStreamControl, isStreamActive, registerActiveStream, setActiveStreamBackgroundTasks, attachActiveStreamInput, attachActiveStreamControl, setActiveStreamPhase, findBackgroundWaitStream, unregisterActiveStream } from '../../services/agent/agent-service'
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
import { buildTaskPlaybookReminder } from '../../services/agent/turn-context'
import { recordProviderResultUsage, ledgerStopReason } from '../../services/llm-call-ledger'
import { SubagentRunService } from '../../services/agent/subagent-runs'
import { BackgroundRunService } from '../../services/agent/background-runs'
import { SessionTurnDebugDAO, hashPrompt } from '../../db/dao'
import { TurnDebugRecorder, type TurnDebugIdentity } from '../../services/agent/turn-debug-recorder'
import { expertName } from '@octopus/shared'
import { createWorkflowToolServer } from '../../services/chat/workflow-tools'
import { createTaskToolServer } from '../../services/chat/task-tools'
import { getChatEventBridge } from '../../services/activity/chat-event-bridge'
import { createMemoryToolServer, resolveLongTermConsent } from '../../services/chat/memory-tools'
import { createCabinToolServer, createCabinDelegationToolServer, getCabinToolsProvider, buildCabinSummaryReminder } from '../../services/chat/cabin-tools'
import { parseDecisionEnvelope } from '../../services/cabin/cabin-brief'
import { CabinItemService } from '../../services/cabin/cabin-item-service'
import { expandItemDelivery } from '../../services/cabin/cabin-item-delivery'
import { getSlashCommands, rememberSlashCommands } from '../../services/chat/slash-commands'
import type { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import type { EffortLevel } from '@octopus/shared'
import { parseComposerContext, parseComposerEffort, resolveChatModel } from './composer-options'
import type { TaskThreadService } from '../../services/tasks/task-thread-service'
import { commitWorkspaceEdits, quickEditMarkerFor } from '../../services/tasks/quick-edit'

/** 读取文件末尾 ≤ maxBytes（后台作业 output_file 的兜底；UTF-8 截断丢掉首行残片）。 */
function readFileTail(
  file: string,
  maxBytes: number,
): { output: string; total_bytes: number; truncated: boolean } | null {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return null
    const start = Math.max(0, stat.size - maxBytes)
    const len = stat.size - start
    if (len <= 0) return { output: '', total_bytes: stat.size, truncated: false }
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, len, start) } finally { fs.closeSync(fd) }
    let output = buf.toString('utf8')
    if (start > 0) {
      const nl = output.indexOf('\n')
      if (nl >= 0) output = output.slice(nl + 1)
    }
    return { output, total_bytes: stat.size, truncated: start > 0 }
  } catch {
    return null
  }
}

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
  // Lazy: route factories run at import time, before tests init the DB.
  let subagentRuns: SubagentRunService | null = null
  const getSubagentRuns = () => (subagentRuns ??= new SubagentRunService(sessionDao.getDb()))
  // 后台作业记录（2026-11-24 用户 #1 · 活动日志）：电平 → running 行，
  // 结束边沿 → 收口。与子代理同一套路，读侧还有 output 路由。
  let backgroundRuns: BackgroundRunService | null = null
  const getBackgroundRuns = () => (backgroundRuns ??= new BackgroundRunService(sessionDao.getDb()))

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
      // 2026-11-23 用户 #8：generating = 模型在生成（输入只能排队/steer）；
      // background-wait = 只等后台任务（可经 /chat/inject 继续说话）。
      phase: getActiveStreamPhase(id),
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
    return c.json({ runs: getSubagentRuns().list(id) })
  })

  app.get('/sessions/:id/subagents/:agentId', (c) => {
    const id = c.req.param('id')
    const agentId = c.req.param('agentId')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    const run = getSubagentRuns().find(id, agentId)
    if (!run) {
      return c.json(createAgentError('NOT_FOUND', `Subagent ${agentId} not found`), 404)
    }
    return c.json({ run })
  })

  // ── Background jobs（2026-11-24 用户 #1 · 活动日志）─────────────────
  // 运行中电平 + 已结束留档（background_runs）。右栏「活动」与「更多 →
  // 活动日志」共用这一个数据源。
  app.get('/sessions/:id/background-runs', (c) => {
    const id = c.req.param('id')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    return c.json({ runs: getBackgroundRuns().list(id) })
  })

  // 输出尾：运行中走 SDK `get_task_output`（≤8 KiB，实时）；回合结束 / 进程
  // 重启后回退读 CLI 留下的 output_file 末尾。两路都没有 → 409。
  app.get('/sessions/:id/background/:taskId/output', async (c) => {
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    const live = getActiveStreamControl(id)
    if (live) {
      try {
        const out = await live.control.getTaskOutput(taskId)
        return c.json({ ...out, source: 'live' as const })
      } catch {
        // 任务已结束 / 该 SDK 不支持 —— 落到下面的文件兜底。
      }
    }
    const row = getBackgroundRuns().find(id, taskId)
    if (row?.output_file) {
      const tail = readFileTail(row.output_file, 8 * 1024)
      if (tail) return c.json({ ...tail, source: 'file' as const })
    }
    return c.json(
      createAgentError('UNAVAILABLE', '该作业的输出已不可读（进程已退出或文件被清理）'),
      409,
    )
  })

  // 单独停一个后台作业（不打断当前模型轮）。SDK 会补一条 status='stopped'
  // 的 task_notification，provider 转成 background_task_ended 后由记录服务收口。
  app.post('/sessions/:id/background/:taskId/stop', async (c) => {
    const id = c.req.param('id')
    const taskId = c.req.param('taskId')
    const session = sessionDao.findById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }
    const tracked = getActiveStreamBackgroundTasks(id).some((task) => task.id === taskId)
      || getBackgroundRuns().find(id, taskId)?.status === 'running'
    if (!tracked) {
      return c.json(createAgentError('NOT_FOUND', `Background task ${taskId} not found`), 404)
    }
    const live = getActiveStreamControl(id)
    if (!live) {
      return c.json(
        createAgentError('UNAVAILABLE', '该会话没有活动中的查询，作业已不在运行'),
        409,
      )
    }
    try {
      await live.control.stopTask(taskId)
      return c.json({ success: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json(createAgentError('INTERNAL_ERROR', msg), 500)
    }
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
      /** 事项投递（2026-11-24 用户）：via='items' 时 itemIds = 舱内事项 id。
       *  服务端把来源写进 user message metadata（via / items），并把事项标成
       *  delivered —— 单写一次，客户端只负责展示与关项。 */
      meta?: { via?: 'items'; itemIds?: string[] }
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid JSON body'), 400)
    }

    if (!body.message) {
      return c.json(createAgentError('INVALID_PARAM', 'message is required'), 400)
    }

    // 事项投递（2026-11-24 用户）：只在用户真发消息时生效；wake / ephemeral 不带。
    const itemIds = Array.isArray(body.meta?.itemIds)
      ? body.meta!.itemIds.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 50)
      : []
    const viaItems = !body.wake && !body.ephemeral && body.meta?.via === 'items' && itemIds.length > 0

    const effort = parseComposerEffort(body.effort)
    const model = resolveChatModel(body.model, parseComposerContext(body.maxContext))

    // Verify session exists
    const session = sessionDao.findSessionById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }

    // C11 重做：舱里发消息 = 人来了 —— 打盹中的舱静默叫醒 + 重置空闲计时。
    // 只认真实用户消息；服务端 wake turn / 事件卡不算人。失败不影响本轮对话。
    if (!body.ephemeral && !body.wake && session.cabin_id) {
      try {
        getCabinToolsProvider()?.service.activity(session.cabin_id)
      } catch { /* 活性信号尽力而为 */ }
    }

    // 同一会话只容一条生成流（2026-11-10 用户事故，克隆路由早有这道闸）：
    // 上一轮还在跑时再 POST，第二条查询会拿同一个 provider_session_id 并发
    // resume —— SDK 给出的第一条 result 常常是上一轮累计结果的回放（没有
    // message_start、没有正文），宿主把它当成本轮终点，用户看到「消息发出去
    // 了，却没有任何回复」，还得再问一遍。闸放在读入用户消息之前：被弹回的
    // 消息不落转录，客户端按 STREAM_IN_PROGRESS 转成尾随（或排队补发）。
    if (isStreamActive(id)) {
      return c.json(
        createAgentError('STREAM_IN_PROGRESS', '该会话上一轮回复仍在生成中，请稍候或先停止', {
          // 后台等待阶段本身允许继续说话 —— 走 /chat/inject 注入同一个
          // provider 查询；生成中只能等。客户端据此选路径（2026-11-23 #8）。
          phase: getActiveStreamPhase(id),
        }),
        409,
      )
    }

    // 事项投递的服务端兜底（2026-11-26 用户）：正文才是需求。客户端现在会
    // 带正文，但旧客户端 / 缓存过期 / 编辑竞态都可能只发标题 —— 按 cabin_items
    // 真源校一遍，缺的正文补在消息末尾，再落库并交给模型。事项表不可用时
    // 退回客户端原文（不能因为小待办把整轮对话打挂）。
    let itemDelivery: ReturnType<typeof expandItemDelivery> | null = null
    if (viaItems && session.cabin_id) {
      try {
        itemDelivery = expandItemDelivery(
          body.message!,
          new CabinItemService(sessionDao.getDb()).getMany(session.cabin_id, itemIds),
        )
      } catch { /* 事项表不可用不影响对话本身 */ }
    }
    const userContent = itemDelivery?.content ?? body.message!

    // Store user message. Ephemeral wakes (task-thread event cards) reach the
    // model but are NOT persisted — the bridge already wrote the card.
    const userMsgId = crypto.randomUUID()
    const now = new Date().toISOString()
    if (!body.ephemeral) {
      // metadata：wake 事件卡带 displayType/activity；事项投递带来源（via + items），
      // 其余普通消息不写 metadata —— 转录行据此渲染「☑ 事项」来源签。
      const userMeta = body.wake
        ? { displayType: 'event', activity: body.activity ?? null }
        : viaItems
          ? { via: 'items', items: itemIds }
          : null
      sessionDao.insertMessage({
        id: userMsgId, session_id: id, role: 'user',
        content: userContent, created_at: now,
        ...(userMeta ? { metadata: JSON.stringify(userMeta) } : {}),
      })
      sessionDao.updateLastMessageAt(id, now)
      // 投递 = 事项 todo → delivered（幂等）。落点写回事项，便于排障 / 回执对账。
      if (viaItems && session.cabin_id) {
        try {
          new CabinItemService(sessionDao.getDb()).deliver(session.cabin_id, itemIds, {
            sessionId: id, messageId: userMsgId,
          })
        } catch { /* 事项表不可用不影响对话本身 */ }
      }
      // 双会话同步（v22 #9，2026-11-23 用户）：在作者线程里说话 = 这条提问
      // 已经答了 —— 决策代述（「用户回答了以下问题」）和编队 chat 里的直接
      // 回复走同一个销账入口，只是回执文案不同。服务端 wake 不是人，跳过。
      if (!body.wake) {
        try {
          getChatEventBridge().markAuthorAskAnswered(
            id,
            body.message.includes('用户回答了以下问题') ? undefined : { via: 'direct' },
          )
        } catch { /* bridge off */ }
      }
    }

    // ── Safety: detect dangerous commands in user message (B5 fix) ────
    try {
      const interceptor = getSafetyInterceptor()
      if (interceptor.isDangerousCommand(userContent)) {
        const reason = interceptor.getDangerReason(userContent)
        safetyDAO.insertSafetyEvent({
          type: 'dangerous_command',
          operation: userContent.slice(0, 200),
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
      const workflowDev = thread.task.kind === 'workflow-dev'
      const cloneDev = thread.task.kind === 'clone-dev'
      const desired = thread.identity === 'base'
        ? null
        : workflowDev
          ? 'workflow-author'
          : cloneDev
            ? 'clone-author'
            : thread.identity === 'author'
              ? 'task-author'
              : 'task-doer'
      const currentRole = cacheCtx.getRoleState(id)
      const taskRoles = new Set(['task-author', 'task-doer', 'workflow-author', 'clone-author'])
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
      // The provider transcript is gone → the active role card must be replayed,
      // and so must the task playbook (the summary carrier no longer exists).
      cacheCtx.resetRoleDelivery(id)
      cacheCtx.resetPlaybook(id)
    }

    // Identity switch (role card) and @ delegation (one-turn subagent consult)
    // both ride the user message. system prompt / tools / agents stay stable.
    const roleState = cacheCtx.getRoleState(id)
    const roleCard = pendingRoleCard(roleState)
    const self = session.clone_name ?? null
    const consults = [
      ...parseCloneMentions(userContent),
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
    // The task playbook (identity/discipline/tools/guides) is hash-gated: it is
    // re-sent only when it changed or when the provider transcript was rewritten
    // (compaction) / dropped (`/clear`). The status head rides every turn.
    const playbookReminder = thread
      ? buildTaskPlaybookReminder(thread, cacheCtx.getPlaybookHash(id))
      : null
    // Cabin P3（C2）：舱主会话每回合注入派生舱摘要（attention/迭代/作业），
    // 关系单写者=任务行，摘要只读不持久。
    const cabinProvider = getCabinToolsProvider()
    const cabinReminder = !thread && session.cabin_id && cabinProvider
      ? buildCabinSummaryReminder(cabinProvider.service, session.cabin_id, cabinProvider.decisions)
      : null
    // 事项投递（2026-11-24 用户）：告诉模型这是舱内小待办，按条目汇报；
    // 关项默认由人在回执卡确认；用户在本轮明确说「关掉 / 完成」时，模型可用
    // cabin_set_item_status 直接关（2026-11-26 用户：不能再让模型去猜 HTTP 接口）。
    const itemReminder = viaItems
      ? `本轮消息是从舱内「事项」窗投递的 ${itemIds.length} 条小待办（原文逐条附在本轮消息里）。`
        + `请逐条处理，并在最后按条目汇报（做了什么 / 证据）；正文若被截断，可用 cabin_list_items / cabin_get_item 读取完整原文。`
        + `关项 / 重开用 cabin_set_item_status：用户本轮明确说「关掉 / 完成 / 搁置」就按原话执行；只是投递给你处理、用户还没表态时不要自行关项，汇报完由人在回执卡上确认。`
      : null
    const turnReminder = [roleCard, mentionReminder, playbookReminder?.text, cabinReminder, itemReminder].filter(Boolean).join('\n\n')
    const providerMessage = withTransientReminder(userContent, turnReminder)
    // Workflow control tools (list/run/status/cancel/approve/retry) are
    // registered as an in-process MCP server bound to this chat's workspace.
    // A task thread also gets the read/action tools (spec + confirm cards).
    const mcpWorkspaceId = thread?.task.workspaceId ?? session.workspace_id
    const toolServers: Record<string, unknown> = {}
    if (mcpWorkspaceId) {
      toolServers['octopus-workflow'] = createWorkflowToolServer(mcpWorkspaceId, { sessionId: id, org }, {
        taskId: thread?.task.id,
        kind: thread?.task.kind === 'workflow-dev' ? 'workflow-dev' : undefined,
        db: sessionDao.getDb(),
      })
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
        { longTermConsent: resolveLongTermConsent(userContent) },
      )
    }
    // Cabin P3（C3）：舱主会话挂调度工具集（只调度不执行）。
    // design 25 §4.2：委派 doer 只挂「交结论」这一个工具，不能派任务 / 建任务。
    // 2026-11-27 用户：会话只有一本账（cabin_delegations）——
    //   · 舱主会话 → 汐音调度工具集；
    //   · 汐音委派的 doer（origin=xiyin）→ 只挂「交结论」；
    //   · 人自开的会话（origin=user）→ 普通聊天，不挂舱工具（不能变成第二个调度者）。
    // 这个 id 还要驱动委派状态机（回合开始=作战中，回合结束=待命/等你答），
    // 必须让下面的 streamSSE 闭包也看得到。
    let doerDelegationId: string | null = null
    let doerDelegationOrigin: "xiyin" | "user" | null = null
    if (!thread && session.cabin_id && cabinProvider) {
      try {
        const row = sessionDao.getDb().prepare(
          "SELECT id, origin FROM cabin_delegations WHERE doer_session_id = ? LIMIT 1",
        ).get(id) as { id?: string; origin?: string } | undefined
        doerDelegationId = row?.id ?? null
        doerDelegationOrigin = row ? (row.origin === "user" ? "user" : "xiyin") : null
      } catch { /* old DB without cabin_delegations — feature off */ }
      if (doerDelegationId) {
        if (doerDelegationOrigin !== "user") {
          toolServers['octopus-cabin-doer'] = createCabinDelegationToolServer(doerDelegationId)
        }
      } else {
        let isCabinMain = false
        try {
          const cabinRow = sessionDao.getDb().prepare(
            "SELECT main_session_id FROM cabins WHERE id = ?",
          ).get(session.cabin_id) as { main_session_id?: string | null } | undefined
          isCabinMain = cabinRow?.main_session_id === id
        } catch { /* cabins 表缺失 —— 不挂调度工具 */ }
        if (isCabinMain) toolServers['octopus-cabin'] = createCabinToolServer(session.cabin_id)
      }
    }
    const mcpServers = Object.keys(toolServers).length > 0 ? toolServers : undefined

    // ── Trigger self-check on first message (E2E-055) ──────────────
    runSelfCheck()

    // Stream SSE response
    return streamSSE(c, async (stream) => {
      let aborted = false
      // Compaction rewrites the provider transcript and /clear drops it: both
      // invalidate one-shot context (role card, task playbook). Reset delivery
      // state when the turn settles so the next turn re-sends it.
      let contextInvalidated = false
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
              content: userContent,
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
        // 2026-11-25 用户：委派 doer 的回合开始 → 作战中（人刚答完，doer 接着干）；
        // 2026-11-27 用户：人自开会话从「待命」起下一轮同口径。
        if (doerDelegationId) {
          try { cabinProvider?.delegations?.markRunning(doerDelegationId) } catch { /* best effort */ }
        }
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
        const llmResult = await tryClaudeSDK(userContent, systemPrompt, turnStream, id, org, sessionDao, undefined, undefined, model, effort, {
          streamId,
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
          onContextInvalidated: () => { contextInvalidated = true },
          onResult: roleCard || playbookReminder?.full
            ? () => {
                if (roleCard) {
                  cacheCtx.markRoleDelivered(id, roleState.revision)
                  appendRoleSwitchEvent(sessionDao.getDb(), id, roleSwitchEventPayload(roleState, roleCard))
                }
                // Only a full send puts the playbook into the transcript.
                if (playbookReminder?.full) {
                  cacheCtx.savePlaybookHash(id, playbookReminder.playbookHash)
                }
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
          taskThread?.maybeAdoptSmartTaskName(id, userContent)
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[agent-chat] turn failed before settlement:', msg)
        await turn.terminate('error', { session_id: id, code: 'STREAM_ERROR', message: msg })
      } finally {
        // Compaction / `/clear` landed during the turn: the provider transcript
        // no longer carries the one-shot context. Reset AFTER the turn's
        // markRoleDelivered ran, so the next turn re-sends the role card and the
        // full task playbook exactly once.
        if (contextInvalidated) {
          try {
            cacheCtx.resetRoleDelivery(id)
            cacheCtx.resetPlaybook(id)
          } catch {
            // delivery bookkeeping — never mask the turn outcome
          }
        }
        setActiveStreamBackgroundTasks(id, null)
        unregisterActiveStream(id, streamId)
        // 2026-11-25 用户：doer 这一轮结束了还没交结论（cabin_delegation_done 会把
        // 状态置 done）→ 回到「等你答」。否则 state 永远停在 running，编队一直显示
        // 作战中、秒表空转 —— 会话明明已经回复了人，却看起来还在干。
        // 2026-11-27 用户：人自开的会话同理回「待命」（markIdle）—— 没人等它答话。
        if (doerDelegationId) {
          try {
            if (doerDelegationOrigin === "user") cabinProvider?.delegations?.markIdle(doerDelegationId)
            else cabinProvider?.delegations?.markWaitingInput(doerDelegationId)
          } catch { /* best effort */ }
        } else if (!thread && session.cabin_id) {
          // 2026-11-27 用户：人自开会话的委派行可能在本轮开始后才登记（先建会话、
          // 发首条消息，再登记）—— 收轮时补查一次，别让它停在「作战中」。
          try {
            const row = sessionDao.getDb().prepare(
              "SELECT id, origin FROM cabin_delegations WHERE doer_session_id = ? LIMIT 1",
            ).get(id) as { id?: string; origin?: string } | undefined
            if (row?.id) {
              if (row.origin === "user") cabinProvider?.delegations?.markIdle(row.id)
              else cabinProvider?.delegations?.markWaitingInput(row.id)
            }
          } catch { /* best effort */ }
        }
        // 回合收尾：不让 background_runs 留下永久 running 的行。
        try { getBackgroundRuns().closeRunning(id) } catch { /* 观测面失败不影响收轮 */ }
        notifyWake('done')
        // Closes after the terminal frame has been flushed (terminate awaits
        // the serialized write chain).
        turn.close()
      }
    })
  })

  // ── 追加输入（后台等待期）────────────────────────────────────────────
  // 2026-11-23 用户 #8：`run_in_background` 的服务还在跑时，模型空闲等唤醒，
  // 这段时间用户继续说话不该被「会话忙」挡住。普通 /chat 会开第二条 SDK 查询
  // （与后台唤醒并发 resume 同一会话 → 只拿到回放空回复，2026-11-10 事故），
  // 所以这里把消息注进**同一条** provider 查询的输入流 —— SDK 0.3.318 真机
  // 实测：注入轮与后台唤醒轮共用同一个 query，互不吞并。
  // 只在 background-wait 阶段接受；生成中 / 没有后台等待一律 409。
  app.post('/sessions/:id/chat/inject', async (c) => {
    const org = c.req.header('X-Octopus-Org') || (c.get('org') as string) || ''
    const id = c.req.param('id')

    let body: { message?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json(createAgentError('INVALID_PARAM', 'Invalid JSON body'), 400)
    }
    const message = body.message?.trim()
    if (!message) return c.json(createAgentError('INVALID_PARAM', 'message is required'), 400)

    const session = sessionDao.findSessionById(id)
    if (!session || session.is_deleted) {
      return c.json(createAgentError('NOT_FOUND', `Session ${id} not found`), 404)
    }

    const target = findBackgroundWaitStream(id)
    if (!target) {
      return c.json(
        createAgentError('STREAM_IN_PROGRESS', '该会话当前不在「等后台」阶段，请走普通发送', {
          phase: getActiveStreamPhase(id),
        }),
        409,
      )
    }
    // 先注入再落库：通道已关（回合正好收尾）时，这条消息不该进转录。
    if (!target.inject(message)) {
      return c.json(createAgentError('STREAM_IN_PROGRESS', '上一轮正在收尾，请稍后重试'), 409)
    }

    const now = new Date().toISOString()
    sessionDao.insertMessage({
      id: crypto.randomUUID(), session_id: id, role: 'user',
      content: message, created_at: now,
    })
    sessionDao.updateLastMessageAt(id, now)
    if (session.cabin_id) {
      try {
        getCabinToolsProvider()?.service.activity(session.cabin_id)
      } catch { /* 活性信号尽力而为 */ }
    }
    // 与普通发送同一个销账入口（在作者线程里说话 = 提问已答）。
    try {
      getChatEventBridge().markAuthorAskAnswered(id, { via: 'direct' })
    } catch { /* bridge off */ }

    return c.json({ injected: true, session_id: id }, 202)
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
      /** The owning active-stream id (phase / injection registry key). */
      streamId?: string
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
      /** Provider transcript was rewritten (compaction) or dropped (`/clear`).
       *  The route resets one-shot delivery state when the turn settles, so the
       *  NEXT turn re-sends the role card and the full task playbook. */
      onContextInvalidated?: () => void
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
    /** AskUserQuestion 的 questions（2026-11-16，design 23 §2）：interactionSession
     *  deny 后本轮就此收尾，把问题正文随 assistant 行一并落库 —— 舱的 attention
     *  推导（cabin-service.gatherAsks）只认 metadata.displayType，缺了它作者提问
     *  就永远进不了「需要你」。落的是 provider 的原始 wrapper
     *  `{ questions: [...] }`（与 tool input / SSE 逐字一致）。 */
    let askQuestions: unknown = null
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
    // 2026-11-23 #8：后台等待期用户追加消息（/chat/inject）会开启新一轮 ——
    // 下一轮 message_start 时把上一行收口、换一个新 id，转录顺序才是
    // 「助手(前半) → 用户(追加) → 助手(回答)」，而不是回答并进前半行。
    let assistantMsgId = crypto.randomUUID()
    let partialRowId: string | null = null
    let rotateBeforeNextMessage = false
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
          displayType?: 'ask_user_question'
          questions?: unknown
        } = {}
        if (turnTimeline.length > 0) meta.timeline = turnTimeline
        if (interrupted) meta.interrupted = true
        if (error) meta.error = error
        // 与 clone / main-agent / InteractionService 同构：问题卡重开可恢复，
        // 舱 attention 也能从 metadata 直接推导出「待回答」。
        if (askQuestions) {
          meta.displayType = 'ask_user_question'
          meta.questions = askQuestions
        }
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
    /** 追加输入开启的新一轮：上一行收口、换新 id / 清空本轮缓冲。
     *  用户消息行已由 /chat/inject 先落库，新行的 created_at 必然晚于它 ——
     *  转录顺序「助手(前半) → 用户(追加) → 助手(回答)」才对（2026-11-23 #8）。 */
    const rotateAssistantRow = () => {
      if (partialRowId || fullContent || fullThinking || currentToolCalls.length > 0 || turnTimeline.length > 0) {
        finalizePartial(false)
      }
      assistantMsgId = crypto.randomUUID()
      partialRowId = null
      fullContent = ''
      fullThinking = ''
      currentToolCalls.length = 0
      turnTimeline.length = 0
      askQuestions = null
      streamedSinceMessageStart = false
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
            ...(askQuestions ? { displayType: 'ask_user_question', questions: askQuestions } : {}),
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
        setActiveStreamPhase(sessionId, extra?.streamId, 'generating')
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
          // 2026-11-23 用户 #8：后台等待期的追加输入通道。注入成功 = 用户已经在
          // 这条线程里说话了 → 下一轮 message_start 换新的 assistant 行。
          onInputChannel: (push) => {
            if (!extra?.streamId) return
            attachActiveStreamInput(sessionId, extra.streamId, (text) => {
              if (!push(text)) return false
              // 注入前把当前这一行立刻落库：行还没到 500ms 的增量 flush 时，
              // 等到下一轮 message_start 才落会让它的 created_at 晚于用户消息
              // —— 重载后转录顺序变成「用户(追加) → 助手(前半)」。这里落库时
              // 仍在 /chat/inject 写用户行之前，顺序才是对的。
              if (partialRowId || fullContent || fullThinking || currentToolCalls.length > 0) {
                finalizePartial(false)
              }
              rotateBeforeNextMessage = true
              return true
            })
          },
          // 后台作业运行时控制（2026-11-24 用户 #1）：输出尾 / 单作业停止。
          // 续轮会重建 query，后注册覆盖先注册（以最新一条为准）。
          onBackgroundControl: (control) => {
            if (!extra?.streamId) return
            attachActiveStreamControl(sessionId, extra.streamId, control)
          },
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
            case 'message_start': {
              const injected = rotateBeforeNextMessage
              rotateBeforeNextMessage = false
              setActiveStreamPhase(sessionId, extra?.streamId, 'generating')
              // 后台等待期的追加输入开启了新一轮（2026-11-23 #8）：上一行收口、
              // 换新行，且不补空行 —— 那会把两条不同轮次的话粘成一句。
              if (injected) {
                rotateAssistantRow()
                // 新行的第一段不补空行；但这一轮之后再来的后台唤醒续轮仍要
                // 与它分开 —— 把「已续轮」标记复位，下一段自己补。
                continuationMarked = false
              } else if (generated && !continuationMarked) {
                // 后台任务唤醒的续轮（2026-11-04）：首轮已经出过正文时，两段之间
                // 补一个空行，避免「服务启动中服务就绪…」粘成一句。
                continuationMarked = true
                const separator = fullContent ? '\n\n' : ''
                fullContent += separator
                await stream.writeSSE({ event: 'assistant_continue', data: JSON.stringify({ separator }) })
              }
              await stream.writeSSE({ event: 'turn_phase', data: JSON.stringify({ phase: 'generating' }) })
              streamedSinceMessageStart = false
              break
            }
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
            case 'compaction':
              // 压缩把 provider 转录换成了摘要：角色卡 / 任务 playbook 下一轮要重发。
              // 重置推迟到轮次收尾（streamSSE finally）——manual /compact 就是本轮，
              // 先重置会被本轮 result 的 markRoleDelivered 覆盖。
              extra?.onContextInvalidated?.()
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
              askQuestions = chunk.questions
              await stream.writeSSE({ event: 'ask_user_question', data: JSON.stringify({ tool_call_id: chunk.toolCallId, questions: chunk.questions }) })
              // 2026-11-16 延迟修复：提问瞬间就把镜像卡投到舱主会话（最小信封），
              // 不等人把整轮输出完再落卡。askMessageId 用稳定的 assistantMsgId；
              // 回合收尾再用同一个 id 补齐「决策 / 建议 / 选项影响」（幂等）。
              try {
                const early = parseDecisionEnvelope(fullContent, askQuestions)
                getChatEventBridge().requestAuthorAskCard({
                  authorSessionId: sessionId,
                  askMessageId: assistantMsgId,
                  questions: askQuestions,
                  ...(early.decision ? { decision: early.decision } : {}),
                  ...(early.recommendation ? { recommendation: early.recommendation } : {}),
                  ...(early.options.length ? { options: early.options } : {}),
                })
              } catch { /* bridge not attached (unit tests) — attention still works */ }
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
              // 活动日志留档：电平内任务 → running 行；已出电平的 running 行收口。
              try {
                getBackgroundRuns().syncLevel(sessionId, getActiveStreamBackgroundTasks(sessionId))
              } catch (err: unknown) {
                console.warn(
                  '[agent-chat] background run sync failed (non-fatal):',
                  err instanceof Error ? err.message : String(err),
                )
              }
              await stream.writeSSE({ event: 'background_tasks', data: JSON.stringify({ tasks: chunk.tasks }) })
              break
            case 'background_task_ended':
              // 单个后台作业结束：最终状态 / 摘要 / output_file 落档。
              try {
                getBackgroundRuns().markEnded(sessionId, chunk.task)
              } catch (err: unknown) {
                console.warn(
                  '[agent-chat] background run end failed (non-fatal):',
                  err instanceof Error ? err.message : String(err),
                )
              }
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
              // The transcript is gone → role card + task playbook are pending
              // again. Same end-of-turn reset as compaction.
              extra?.onContextInvalidated?.()
              break
            case 'subagent':
              // 作业坞「子代理」：记录主 Agent 派生的每个子代理（指令 prompt /
              // 操作日志 / 最终汇报）。单代理 token 由读侧从 transcript 回填。
              // 记账失败不能影响本轮 —— 作业坞是观测面，不是收轮条件。
              try {
                getSubagentRuns().applyEvent(sessionId, chunk.event, { cwd })
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
              // Claude SDK 的 modelUsage 是跨 turn 的会话累计 —— helper 按持久化
              // 基线差分成增量（2026-11-09：逐轮相加曾把 11M 的会话记成 87M）。
              // 2026-11-19：带上 messageId —— 逐轮统计优先按消息精确归属。委托任务
              // 线程的 user 行全是「汐音 · 代用户转达」事件卡，没有真人消息边界，
              // 仅靠时间窗会把整条线程的账本行全部漏掉（真机：tok/¥ 整轮为空）。
              if (tokenUsageDao) {
                recordProviderResultUsage({
                  sourcePath: 'global_chat',
                  nodeExecutionId: null,
                  executionId: null,
                  sessionId,
                  messageId: assistantMsgId,
                  org,
                  startedAtMs: turnStartedAtMs,
                  modelUsages: chunk.modelUsages,
                  usage: chunk.usage,
                  cumulative: chunk.modelUsagesCumulative,
                  providerSessionId: chunk.sessionId ?? null,
                }, tokenUsageDao)
              }
              if (!resultNotified) {
                resultNotified = true
                extra?.onResult?.()
              }
              // 首轮 result 后仍有后台任务 = 模型空闲、只等唤醒（2026-11-23 #8）：
              // 注册表相位切到 background-wait，客户端据此不锁输入。
              const waitingBackground = !stopped && getActiveStreamBackgroundTasks(sessionId).length > 0
              if (waitingBackground) {
                setActiveStreamPhase(sessionId, extra?.streamId, 'background-wait')
                await stream.writeSSE({ event: 'turn_phase', data: JSON.stringify({ phase: 'background-wait' }) })
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
                  messageId: assistantMsgId,
                  org,
                  startedAtMs: turnStartedAtMs,
                  modelUsages: chunk.modelUsages,
                  usage: chunk.usage,
                  cumulative: chunk.modelUsagesCumulative,
                  providerSessionId: chunk.sessionId ?? null,
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

        // 2026-11-24 用户 #2：任务 / 委派线程的一轮回复回传舱主会话（汐音）。
        // 人在任务 chat 里直接跟执行者交互、或汐音转达后执行者的回应，原先这条线
        // 对汐音完全不可见 —— 这里落一张只读 event 卡（零 LLM、不唤醒）。
        // wake 回合也回传（汐音 → 任务 agent 这条路的回复正是要看的），
        // 但 wake 的系统指令不作为「你说了什么」展示。
        try {
          getChatEventBridge().requestThreadReplyMirror({
            sessionId,
            messageId: assistantMsgId,
            userText: body.wake ? '' : message,
            replyText: fullContent,
          })
        } catch { /* bridge not attached (unit tests) — 回传是增强，不阻断本轮 */ }

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
        // design 23 §2：舱任务的作者提问同时投一张卡到舱主会话 —— 用户不切
        // 对话就能就地回答（答案由 web 卡片转回本线程）。零 LLM，幂等。
        if (askQuestions && partialRowId) {
          try {
            // design 24 §3 / 25 §5：信封由「作者正文约定 + 服务端结构化搬运」构成，
            // 不改 AskUserQuestion 的工具 schema。缺少「决策 / 建议」行时按缺失降级。
            const envelope = parseDecisionEnvelope(fullContent, askQuestions)
            getChatEventBridge().requestAuthorAskCard({
              authorSessionId: sessionId,
              askMessageId: assistantMsgId,
              questions: askQuestions,
              ...(envelope.decision ? { decision: envelope.decision } : {}),
              ...(envelope.recommendation ? { recommendation: envelope.recommendation } : {}),
              ...(envelope.options.length ? { options: envelope.options } : {}),
            })
          } catch { /* bridge not attached (unit tests) — attention still works */ }
        }
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
