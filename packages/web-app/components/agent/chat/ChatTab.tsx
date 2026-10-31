'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Folder, Menu, PanelLeft, Search, SquarePen } from 'lucide-react'
import { toast } from 'sonner'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useAgentChat, type UseAgentChatApiOverride, type ChatSubagentRef } from '@/hooks/useAgentChat'
import { buildSlashCommands } from './SlashCommandAutocomplete'
import { useSessionLedger } from '@/hooks/useSessionLedger'
import { useTaskUsage } from '@/hooks/useTaskUsage'
import { useComposerSettings } from '@/hooks/useComposerSettings'
import { useKcFeed } from '@/hooks/use-kc-feed'
import { useChatTasks } from '@/hooks/use-chat-tasks'
import { useRunningAgents } from '@/hooks/use-running-agents'
import { useOrgs } from '@/hooks/useOrgs'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useSessionIdentity } from '@/hooks/use-session-identity'
import * as agentApi from '@/lib/agent/api'
import { ChatSidebar } from './chat-sidebar'
import { CwdPicker, type CwdChoice } from './cwd-picker'
import { TaskModulesLayer } from '@/components/chat-workbench/task-modules-layer'
import { TriggerDialog } from '@/components/tasks/trigger-dialog'
import type { TaskModule } from '@/components/chat-workbench/task-window-types'
import { TaskProjectChip } from '@/components/chat-workbench/task-project-chip'
import { WorkspaceExplorerDock } from '@/components/workspace/workspace-explorer-dock'
import { useActivitySnapshot } from '@/components/chat-workbench/inspector-activity'
import { WorkflowWindow } from '@/components/chat-workbench/workflow-window'
import type { TaskWindowMap } from '@/components/chat-workbench/task-window-types'
import {
  createTask, getTask, readyTask, TaskReadyGateError, updateTask, deleteTask, abortTask,
  triggerTask, pauseTask, resumeTask, reopenTask, duplicateTask, postArchiveRetry,
  postAcceptance, recordAcceptanceCheck, regenerateAcceptancePlan,
  type TaskView,
} from '@/lib/tasks-api'
import { readRememberedTaskOrg, rememberTaskOrg, resolveTaskOrg } from '@/lib/task-org'
import { NEW_TASK_NAME, taskNameFromMessage } from '@/lib/task-name'
import { buildTurnStats } from '@/lib/turn-stats'
import { readLastChatContext, writeLastChatContext } from '@/lib/last-chat-context'
import { subscribeSSE } from '@/lib/sse-manager'
import { TASK_ACCEPTANCE_CHECK_EVENT, TASK_EXECUTION_EVENT, TASK_STATUS_EVENT } from '@octopus/shared'
import { getServerUrl } from '@/lib/server-config'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/agent/shared/ConfirmDialog'
import { ChatArea } from './ChatArea'
import type { ComposerIdentityDisplay } from './composer-identity-chip'
import { ToolCallDialog } from './ToolCallDialog'
import { KcCard, type KcCardActionCtx } from '@/components/knowledge-center/cards/registry'
import {
  parseKcCardBlocks,
  type KcCardEvent,
  type KcCompileDiffCardData,
  type KcIngestCardData,
} from '@/lib/knowledge-center/card-protocol'
import type { AgentMessage } from '@/lib/agent/types'
import { Sheet, SheetContent } from '@/components/ui/sheet'

const SIDEBAR_WIDTH_KEY = 'octopus.chat.sidebarWidth.v1'
const SIDEBAR_COLLAPSED_KEY = 'octopus.chat.sidebarCollapsed.v1'
const SIDEBAR_DEFAULT = 236
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 380

/** 决策卡上「选择即写回卡片」的按钮 id。其余按钮（打开规格/运行窗…）只是导航，
 *  schedule / keep_editing 各自在分支里处理（定时要等对话框真正排上）。 */
const DECISION_ACTION_IDS = new Set([
  'launch_now', 'enqueue', 'confirm_action',
  // 2026-10-30 验收引导：逐项判定与升级确认同样写回卡片（只读留痕）。
  'acceptance_pass', 'acceptance_fail', 'acceptance_skip', 'acceptance_escalate_confirm',
])

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
}

interface PendingTaskSession {
  sessionId: string
  org: string
  title: string
  projectIds: string[]
}

/** First message seeds the task title immediately (the sidebar is never blank);
 *  the server then replaces it with an AI-summarised title on the first turn —
 *  only while the name still equals the deterministic derivation, so a user
 *  rename is never overwritten. 规则与服务端 `derivedTaskNameFromMessage` 同源
 *  （两侧测试钉同一批样例）。 */
export function ChatTab() {
  const {
    sessions, activeSessionId, setActiveSessionId,
    loading: sessionsLoading, createNewSession, renameSession, removeSession,
    updateSessionTitle, refetch: refetchSessions,
  } = useChatSessions()

  const [activeTask, setActiveTask] = useState<TaskView | null>(null)
  const [pendingTaskSession, setPendingTaskSession] = useState<PendingTaskSession | null>(null)
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskModuleRequest, setTaskModuleRequest] = useState<{ module: TaskModule; nonce: number } | null>(null)
  const [taskWindows, setTaskWindows] = useState<Record<string, TaskWindowMap>>({})
  // 2026-10-31 消耗窗通用化：纯会话（无任务）也有一扇消耗窗，窗口 id 与任务窗
  // 共用 'usage'，但几何状态独立（不跟着任务切换复用/串位）。
  const [sessionUsageWindows, setSessionUsageWindows] = useState<TaskWindowMap>({})
  const [renameTarget, setRenameTarget] = useState<TaskView | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TaskView | null>(null)
  // 2026-10-28 task-thread: card actions (one confirm gate for destructive ones).
  const [scheduleTaskId, setScheduleTaskId] = useState<string | null>(null)
  const [cardConfirm, setCardConfirm] = useState<{
    taskId: string
    action: string
    activity?: AgentMessage['activity']
    messageId?: string
  } | null>(null)
  const [cardBusy, setCardBusy] = useState(false)
  // 验收引导（2026-10-30）：✕/⊘ 必须先写原因 —— 卡片上弹一个小输入框。
  const [acceptNote, setAcceptNote] = useState<{
    taskId: string
    itemId: string
    decision: 'fail' | 'skip'
    actionId: string
    messageId?: string
    label?: string
    title?: string
  } | null>(null)
  const [acceptNoteText, setAcceptNoteText] = useState('')
  const [acceptNoteBusy, setAcceptNoteBusy] = useState(false)
  const [mainCwd, setMainCwd] = useState<CwdChoice>({ kind: 'default', label: 'Main Agent 工作区' })
  const [taskCwd, setTaskCwd] = useState<CwdChoice>({ kind: 'default', label: '新建工作空间' })
  const [workflowWindow, setWorkflowWindow] = useState<{
    workspaceId: string
    executionId: string
    title?: string
  } | null>(null)
  const { tasks: chatTasks, loading: chatTasksLoading, refresh: refreshChatTasks } = useChatTasks()
  const runningAgents = useRunningAgents()
  const { orgs: appOrgs } = useOrgs()
  // Tasks are org-scoped: their repos come from the org's manifest, and the
  // org also namespaces the execution workspace. Never take orgs[0] blindly —
  // the list is sorted by name, so that silently bound new tasks to whichever
  // org sorts first (miyuan), making org=xzf repos unselectable (bug 2026-10-27).
  const preferredOrg = useMemo(
    () => resolveTaskOrg({
      orgs: appOrgs.map((o) => o.name),
      remembered: readRememberedTaskOrg(),
      recentTaskOrgs: [...chatTasks]
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .map((task) => task.repo_group),
    }),
    [appOrgs, chatTasks],
  )

  /**
   * 2026-10-28 task-thread: the MAIN chat is the task's only conversation.
   * `draftScope` only drives copy/lead chrome — it never swaps the chat engine
   * or renders a second workbench. Identity is server-derived from the task
   * state (role card + per-turn profile).
   */
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const draftScope = pendingTaskSession !== null || activeTask?.status === 'draft'

  // 会话长期身份（v59 分身）：主对话用 agent 作用域，交给 ChatArea 的 ＋ 面板。
  // 任务线程的基础身份由服务端按任务状态派生（角色卡），这里只保留手动分身切换。
  const identity = useSessionIdentity({ kind: 'agent', sessionId: activeSessionId })
  // 停靠态只在「工作区不是默认 main-agent」时显示名字；默认值整个 chip 不渲染。
  const { workspaces } = useWorkspaces()
  const sessionWorkspace = activeSession?.workspace_id && Array.isArray(workspaces)
    ? workspaces.find((ws) => ws.id === activeSession.workspace_id)
    : undefined
  const workspaceLabel = sessionWorkspace && sessionWorkspace.name !== 'main-agent'
    ? sessionWorkspace.name
    // 分身工作区不落 workspace 行（~/.octopus 归目录选择策略黑名单），所以这里
    // 按身份显示：会话自带 cwd、没绑过工作区、且带着分身角色卡 → 它跑在该分身
    // 自己的目录（v58 前的老会话 cwd 为空，不会误报）。
    : (identity.activeName && identity.label && !activeSession?.workspace_id && activeSession?.cwd
      ? `${identity.label} 工作区`
      : null)

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT
  })
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  })
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      /* storage unavailable */
    }
  }, [sidebarWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [sidebarCollapsed])

  /** Collapsed-rail actions re-open the sidebar; search focuses the filter. */
  const expandSidebar = useCallback((opts?: { focusSearch?: boolean }) => {
    setSidebarCollapsed(false)
    if (opts?.focusSearch) setSidebarSearchOpen(true)
  }, [])

  const handleSidebarResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    sidebarDragRef.current = { startX: event.clientX, startWidth: sidebarWidth }
    setResizingSidebar(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }

  const handleSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sidebarDragRef.current
    if (!drag) return
    setSidebarWidth(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX))
  }

  const handleSidebarResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sidebarDragRef.current) return
    sidebarDragRef.current = null
    setResizingSidebar(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }


  // Callback to update session title in sidebar when server auto-generates one
  const handleTitleUpdate = useCallback((sessionId: string, title: string) => {
    updateSessionTitle(sessionId, title)
  }, [updateSessionTitle])

  const handleQuickEditCommit = useCallback((data: { repo: string; commit: string; message: string }) => {
    toast.success(`已提交 ${data.repo} · ${data.message}`)
  }, [])

  const mainChatApi = useMemo<UseAgentChatApiOverride>(() => ({
    checkRunning: agentApi.getSessionRunning,
  }), [])

  const {
    messages, streaming, streamContent, streamThinking, streamTimeline, isThinking, toolCalls, pendingConfirm,
    error: chatError, statusMessage, contextUsage, slashCommands,
    sendMessage, stopGenerate, handleConfirm, loadMessages,
    steer, steeringRef, resumeStreaming, checkAndResume, streamingSessionId, turnStartedAt,
  } = useAgentChat(activeSessionId, {
    onTitleUpdate: handleTitleUpdate,
    api: mainChatApi,
    onQuickEditCommit: handleQuickEditCommit,
  })
  // Composer `/` menu — the CLI's advertised set (skills included), rebuilt
  // into grouped rows. Empty until the first turn of this server process.
  const slashCommandList = useMemo(() => buildSlashCommands(slashCommands), [slashCommands])
  // One ledger fetch serves both the composer token chip (aggregates) and the
  // per-turn timing/token stats in the transcript (calls).
  const { aggregates: sessionUsage, calls: sessionLedgerCalls } = useSessionLedger(activeSessionId, streaming)
  // Task thread: the composer chip shows the WHOLE task ledger (chat + every
  // round). Refetched on turn end and on task status/version changes.
  const taskUsage = useTaskUsage(
    activeTask?.id,
    `${activeTask?.version ?? ''}:${activeTask?.status ?? ''}:${streaming ? '1' : '0'}`,
  )
  // Switching sessions aborts the local SSE, but task-author turns keep
  // generating server-side. Keep the badge for a short grace window while the
  // 2s running poll catches up. Keyed on the OWNING session — on the switch
  // render `streaming` still belongs to the previous session, so recording
  // `activeSessionId` lit up whichever task the user clicked (bug 2026-10-29:
  // 「切换任务里的会话，全部变运行中」).
  const lastStreamingAtRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    if (streaming && streamingSessionId) {
      lastStreamingAtRef.current.set(streamingSessionId, Date.now())
    }
  }, [streaming, streamingSessionId, runningAgents])
  const runningSessionIds = useMemo(() => {
    const ids = new Set(runningAgents.map((agent) => agent.id))
    if (streaming && streamingSessionId) ids.add(streamingSessionId)
    const now = Date.now()
    for (const [id, at] of lastStreamingAtRef.current) {
      if (now - at < 6_000) ids.add(id)
    }
    return ids
  }, [runningAgents, streaming, streamingSessionId])

  // The task-author autosave renames the draft at turn-end (and the LLM title
  // refinement may land shortly after). Refresh the task list on stream end so
  // the task row adopts the smart title without waiting for the 30s poll.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      wasStreamingRef.current = false
      void refreshChatTasks()
      // 任务名的 AI 总结是轮末异步起的（haiku，1–2s 才回）→ 再补一次晚刷新。
      const timers = [1_800, 6_000].map((ms) => window.setTimeout(() => void refreshChatTasks(), ms))
      return () => { for (const t of timers) window.clearTimeout(t) }
    }
    wasStreamingRef.current = streaming
  }, [streaming, refreshChatTasks])

  // Keep the active task object in sync with list refreshes (name/status/
  // version/projects) so the task overview and authoring surface never show a
  // stale title.
  useEffect(() => {
    if (!activeTask) return
    const fresh = chatTasks.find((task) => task.id === activeTask.id)
    if (!fresh) return
    const sameProjects =
      (fresh.project_ids ?? []).join(',') === (activeTask.project_ids ?? []).join(',')
    if (
      fresh.name !== activeTask.name ||
      fresh.status !== activeTask.status ||
      fresh.version !== activeTask.version ||
      !sameProjects
    ) {
      setActiveTask(fresh)
    }
  }, [chatTasks, activeTask])
  // 模型别名 / 思考强度 / 最大上下文 —— 与任务草稿共用同一份本机设置。
  const {
    model, setModel,
    effort, setEffort,
    context: maxContext, setContext: setMaxContext,
    presets: modelPresets,
  } = useComposerSettings()

  // ── 票10 投喂泛化：会话策展卡回流呈现 ──
  // 卡片回流原会话的普通侧宿主：Lane A fenced 块剥块渲染（注册表复用=零新卡类），
  // Lane B 覆盖层 store 直接复用 useKcFeed（开放点裁定：钮点击即时态由既有 hook
  // 承载，不新建基建）。动作钮链与知识中心同一套 REST（revert/retry=上下文无关）。
  const feed = useKcFeed({})
  const [composerSeed, setComposerSeed] = useState('')

  // Per-turn timing / token stats live on the message objects (not persisted on
  // the row) so TuiTranscript can render the process meta without new plumbing.
  const turnStatsByMessage = useMemo(
    () => buildTurnStats(messages, sessionLedgerCalls),
    [messages, sessionLedgerCalls],
  )

  const { viewMessages, laneAByMsgId, laneAIds, laneAIngestById } = useMemo(() => {
    const byMsgId = new Map<string, KcCardEvent[]>()
    const ids = new Set<string>()
    const ingestById = new Map<string, KcCardEvent>()
    const vm = messages.map((m): AgentMessage => {
      const stats = turnStatsByMessage.get(m.id)
      const base: AgentMessage = stats ? { ...m, turnStats: stats } : m
      if (!m.content || !m.content.includes('kc-card')) return base
      const { events, rest } = parseKcCardBlocks(m.content)
      if (events.length === 0) return base
      byMsgId.set(m.id, events)
      for (const e of events) {
        ids.add(e.id)
        if (e.kind === 'ingest') ingestById.set(e.id, e)
      }
      return { ...base, content: rest }
    })
    return { viewMessages: vm, laneAByMsgId: byMsgId, laneAIds: ids, laneAIngestById: ingestById }
  }, [messages, turnStatsByMessage])

  // Lane B 覆盖层回灌 Lane A 沉淀卡（与 curator-drawer withCardStates 同构的普通会话最小子集：
  // revert 态按 commit 匹配；ingest 重试后的编译镜像按同 id 取 store 新态）
  const withCardStates = useCallback((e: KcCardEvent): KcCardEvent => {
    if (e.kind === 'compile-diff') {
      const d = e.data as KcCompileDiffCardData
      if (!d.commit || d.revert || !feed.revertStates[d.commit]) return e
      return { ...e, data: { ...d, revert: feed.revertStates[d.commit] } }
    }
    if (e.kind === 'ingest') {
      const live = feed.cards.find(c => c.id === e.id)
      const lc = live?.kind === 'ingest' ? (live.data as KcIngestCardData).compile : undefined
      if (!lc) return e
      return { ...e, data: { ...(e.data as KcIngestCardData), compile: lc } }
    }
    return e
  }, [feed.revertStates, feed.cards])

  const ctx: KcCardActionCtx = useMemo(() => ({
    // 普通会话无 KC 右栏布局：开页/看 raw 类布局动作降级为无操作（回流链只产
    // ingest/compile-diff/source-summary 三类卡；其余动作钮在本宿主不可达）。
    openPage: () => {},
    openFullPage: () => {},
    openRaw: () => {},
    revert: commit => void feed.revert(commit),
    retryCompile: (cardId, rawPath) => {
      // Lane A 卡先入 store（retryCompile 需按 id 找底座；编译镜像回灌原卡）
      const ev = laneAIngestById.get(cardId)
      if (ev) feed.restore([ev])
      void feed.retryCompile(cardId, rawPath)
    },
    sayToCurator: text => setComposerSeed(text),
    adoptFinding: () => {},
    ignoreFinding: () => {},
    backfillWiki: () => {},
    dismissBackfill: () => {},
    recompilePack: () => {},
    retireCase: () => {},
  }), [feed.revert, feed.retryCompile, feed.restore, laneAIngestById])

  // 尾挂 = Lane B 新卡（重试新任务等），同 id Lane A 优先（协议两车道契约）
  const tailEvents = useMemo(
    () => feed.cards
      .filter(e => !laneAIds.has(e.id))
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map(withCardStates),
    [feed.cards, laneAIds, withCardStates],
  )

  const extras = useCallback((msg: AgentMessage) => {
    const events = laneAByMsgId.get(msg.id)
    if (!events || events.length === 0) return null
    return events.map(e => <KcCard key={e.id} event={withCardStates(e)} ctx={ctx} />)
  }, [laneAByMsgId, ctx, withCardStates])

  const tail = tailEvents.length > 0
    ? <div data-testid="chat-tab-card-tail">{tailEvents.map(e => <KcCard key={e.id} event={e} ctx={ctx} />)}</div>
    : null

  const [showToolPanel, setShowToolPanel] = useState(false)
  // 弹窗打开期间工具列表被清空（切会话/新一轮）→ 顺手复位开关，
  // 否则下一批工具调用冒出来时弹窗会自己蹦出来抢焦点。
  useEffect(() => {
    if (showToolPanel && toolCalls.length === 0) setShowToolPanel(false)
  }, [showToolPanel, toolCalls.length])
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  // Pending message when auto-creating a session (carries + panel clone consult)
  const pendingMessageRef = useRef<{ message: string; subagents?: ChatSubagentRef[] } | null>(null)
  // Task-thread first message (bug 2026-10-29): a task's first turn must wait
  // until the task row exists (server derives the task-author identity from
  // task state). The plain "session ready → send pending" effect would fire the
  // moment createNewSession pushes activeSessionId — too early — and the direct
  // send it tried instead captured a null sessionId (stale closure), so the turn
  // never left the client. Queue it in state and let the effect below send once
  // the session is actually the hook's current one.
  // 2026-10-30: 定时触发是从决策卡进来的 —— 对话框真正排上后才把「定时」写回卡片。
  const pendingScheduleDecisionRef = useRef<{ messageId: string; label?: string } | null>(null)
  const taskSendPendingRef = useRef(false)
  const [pendingTaskSend, setPendingTaskSend] = useState<{
    sessionId: string
    message: string
    subagents?: ChatSubagentRef[]
  } | null>(null)
  // 新会话（hero）里选的身份：还没有 session 可写角色卡，先存在本地，
  // 第一条消息创建会话后立刻写入，再发消息（否则第一轮会用基础身份）。
  const [pendingIdentity, setPendingIdentity] = useState<{ name: string; label: string } | null>(null)
  const pendingIdentityRef = useRef<{ name: string; label: string } | null>(null)
  const choosePendingIdentity = useCallback((name: string | null, label?: string | null) => {
    const next = name ? { name, label: label ?? name } : null
    pendingIdentityRef.current = next
    setPendingIdentity(next)
  }, [])

  useEffect(() => {
    if (!activeSessionId) return
    // New session with pending message — server has 0 messages, skip load
    // to avoid wiping the optimistically-added user message
    if (pendingMessageRef.current) return
    // Always reload on switch: the hook resets the transcript, and the API
    // route (main vs task-author clone) is selected per session.
    loadMessages()
  }, [activeSessionId, loadMessages])

  // When a session is created and there's a pending message, send it — after
  // applying the identity picked in the hero: the role card must land before
  // the first turn, otherwise that turn starts as the base identity.
  useEffect(() => {
    if (!activeSessionId || !pendingMessageRef.current) return
    // Task first message: the session is up but the task row isn't — hold until
    // the pendingTaskSend effect below fires (identity must resolve as author).
    if (taskSendPendingRef.current) return
    const pending = pendingMessageRef.current
    pendingMessageRef.current = null
    const identityToApply = pendingIdentityRef.current
    pendingIdentityRef.current = null
    setPendingIdentity(null)
    const fire = () => requestAnimationFrame(() => sendMessage(pending.message, {
      model, effort, maxContext, subagents: pending.subagents,
    }))
    if (!identityToApply) {
      fire()
      return
    }
    // 角色卡写失败不挡首发消息（错误提示由 useSessionIdentity 统一出）。
    void agentApi.setSessionRole(activeSessionId, identityToApply.name)
      .catch(() => {})
      .finally(fire)
  }, [activeSessionId, sendMessage, model, effort, maxContext])

  // Task first message: fires in the render that already sees the created
  // session (so `sendMessage` is bound to it), after the hook's session-switch
  // effect has cleared the old transcript.
  useEffect(() => {
    const pending = pendingTaskSend
    if (!pending || activeSessionId !== pending.sessionId) return
    taskSendPendingRef.current = false
    pendingMessageRef.current = null
    setPendingTaskSend(null)
    sendMessage(pending.message, {
      model, effort, maxContext, subagents: pending.subagents,
    })
  }, [pendingTaskSend, activeSessionId, sendMessage, model, effort, maxContext])

  const handleSendMessage = useCallback((message: string, opts?: { subagents?: ChatSubagentRef[] }) => {
    if (!pendingTaskSession) {
      if (activeSessionId) {
        sendMessage(message, { model, effort, maxContext, subagents: opts?.subagents })
      } else {
        // First prompt creates the session (lazy). cwd/workspace is chosen here,
        // not when the empty "+" tab was opened.
        pendingMessageRef.current = { message, subagents: opts?.subagents }
        // 没手动挑目录时把身份带下去：服务端把 cwd 落在该分身自己的工作区，
        // 而不是所有分身都挤在 Main Agent 的目录里。
        const identityClone = pendingIdentityRef.current?.name
        const cwdOpts = mainCwd.kind === 'default'
          ? identityClone ? { identity_clone: identityClone } : undefined
          : { workspace_id: mainCwd.workspaceId, cwd: mainCwd.path }
        createNewSession(cwdOpts)
      }
      return
    }

    // First message of a task thread: bind (or create) ONE main session, create
    // the draft on it, then send the message through the normal chat route. The
    // server resolves the task-author identity from the task's state.
    if (creatingTask) return
    const session = pendingTaskSession
    const reuseExisting = !!session.sessionId
    setCreatingTask(true)
    void (async () => {
      try {
        let sid = session.sessionId
        if (!sid) {
          // Hold the plain send-effect and the transcript reload: this message
          // belongs to the task thread and needs the task row in place first.
          taskSendPendingRef.current = true
          pendingMessageRef.current = { message, subagents: opts?.subagents }
          const created = await createNewSession(
            taskCwd.kind === 'default'
              ? undefined
              : { workspace_id: taskCwd.workspaceId, cwd: taskCwd.path },
          )
          sid = created?.id ?? ''
        }
        if (!sid) throw new Error('无法创建任务会话')
        const task = await createTask({
          repo_group: session.org || undefined,
          name: taskNameFromMessage(message),
          source_chat_session_id: sid,
          task_spec: { format: 'v4' },
          project_ids: session.projectIds,
          ...(taskCwd.kind === 'default'
            ? {}
            : { workspace_id: taskCwd.workspaceId, cwd: taskCwd.path }),
        })
        // The org this task landed in is the user's working org — reuse it for
        // the next new task instead of falling back to a sorted-first guess.
        rememberTaskOrg(task.repo_group ?? '')
        writeLastChatContext({ kind: 'task', taskId: task.id })
        setPendingTaskSession(null)
        setActiveTask(task)
        void refreshChatTasks()
        void refetchSessions()
        if (!reuseExisting) {
          setActiveSessionId(sid)
          // Send from the render that has `sid` as the hook's session — the
          // closure captured here still holds the pre-create null id (2026-10-29
          // bug: the turn silently never started, only a refresh showed it).
          setPendingTaskSend({ sessionId: sid, message, subagents: opts?.subagents })
        } else {
          requestAnimationFrame(() => sendMessage(message, {
            model, effort, maxContext, subagents: opts?.subagents,
          }))
        }
      } catch (err: unknown) {
        taskSendPendingRef.current = false
        pendingMessageRef.current = null
        toast.error(err instanceof Error ? err.message : '创建任务失败')
      } finally {
        setCreatingTask(false)
      }
    })()
  }, [
    pendingTaskSession, creatingTask, activeSessionId, sendMessage, createNewSession,
    model, effort, maxContext, refreshChatTasks, refetchSessions, mainCwd, taskCwd,
  ])

  // Refresh restore runs at most once per mount; any explicit navigation means
  // the user already chose — never yank them back to the stored context.
  const restoredChatContextRef = useRef(false)

  const handleSelectSession = (id: string) => {
    restoredChatContextRef.current = true
    taskSendPendingRef.current = false
    setPendingTaskSend(null)
    setActiveTask(null)
    setPendingTaskSession(null)
    setTaskModuleRequest(null)
    setActiveSessionId(id)
    setMobileSidebarOpen(false)
    writeLastChatContext({ kind: 'session', sessionId: id })
  }

  const handleSelectTask = useCallback((task: TaskView, opts?: { module?: TaskModule }) => {
    restoredChatContextRef.current = true
    setMobileSidebarOpen(false)
    setTaskModuleRequest(opts?.module ? { module: opts.module, nonce: Date.now() } : null)
    if (!task.source_chat_session_id) {
      toast.error('该任务没有关联的主会话')
      return
    }
    setPendingTaskSession(null)
    setActiveTask(task)
    setActiveSessionId(task.source_chat_session_id)
    writeLastChatContext({ kind: 'task', taskId: task.id })
  }, [setActiveSessionId])

  /** 会话消耗窗里的工作流行 → 打开对应任务（列表里没有就现取一次）。 */
  const openLinkedTask = useCallback((taskId: string) => {
    const known = chatTasks.find((task) => task.id === taskId)
    if (known) {
      handleSelectTask(known)
      return
    }
    getTask(taskId)
      .then((task) => handleSelectTask(task))
      .catch(() => { toast.error('该任务已不存在') })
  }, [chatTasks, handleSelectTask])

  // Refresh restore: land back on the task the user was working in (a running
  // task must not hide behind a second click). Sessions are restored inside
  // useAgentSessions — it owns the list; tasks need the row, so resolve it from
  // the chat-eligible list first, then fall back to a direct fetch for rows the
  // list excludes (archived / legacy drafts).
  useEffect(() => {
    if (restoredChatContextRef.current) return
    const saved = readLastChatContext()
    if (saved?.kind !== 'task') {
      restoredChatContextRef.current = true
      return
    }
    const known = chatTasks.find((task) => task.id === saved.taskId)
    if (known) {
      restoredChatContextRef.current = true
      handleSelectTask(known)
      return
    }
    if (chatTasksLoading) return
    restoredChatContextRef.current = true
    getTask(saved.taskId)
      .then((task) => handleSelectTask(task))
      .catch(() => { /* deleted — stay on the default chat */ })
  }, [chatTasks, chatTasksLoading, handleSelectTask])

  const openTaskRename = (task: TaskView) => {
    setRenameTarget(task)
    setRenameValue(task.name)
  }

  const confirmTaskRename = async () => {
    if (!renameTarget || taskBusy) return
    const name = renameValue.trim()
    if (!name) return
    setTaskBusy(true)
    try {
      const fresh = await getTask(renameTarget.id)
      const updated = await updateTask(renameTarget.id, { name }, fresh.version)
      setActiveTask((prev) => (prev?.id === updated.id ? updated : prev))
      setRenameTarget(null)
      void refreshChatTasks()
      void refetchSessions()
      toast.success('任务已重命名')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setTaskBusy(false)
    }
  }

  const confirmTaskDelete = async () => {
    if (!deleteTarget || taskBusy) return
    setTaskBusy(true)
    try {
      if (deleteTarget.status === 'running') {
        await abortTask(deleteTarget.id)
      }
      await deleteTask(deleteTarget.id)
      if (activeTask?.id === deleteTarget.id) {
        setActiveTask(null)
        setActiveSessionId(null)
        writeLastChatContext(null)
      }
      setDeleteTarget(null)
      void refreshChatTasks()
      void refetchSessions()
      toast.success('任务已删除')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setTaskBusy(false)
    }
  }

  const handleCreateSession = () => {
    taskSendPendingRef.current = false
    setPendingTaskSend(null)
    setActiveTask(null)
    setPendingTaskSession(null)
    setTaskModuleRequest(null)
    setMobileSidebarOpen(false)
    // Lazy: the DB session is created on the first prompt, after cwd selection.
    setActiveSessionId(null)
    setMainCwd({ kind: 'default', label: 'Main Agent 工作区' })
    choosePendingIdentity(null)
    writeLastChatContext(null)
  }

  const handleCreateTask = useCallback(async () => {
    if (creatingTask) return
    // 2026-10-28: creating a task from a free chat BINDS that chat (one main
    // conversation). From inside an existing task we start a fresh thread.
    const reuseSessionId = !activeTask ? activeSessionId : null
    taskSendPendingRef.current = false
    setPendingTaskSend(null)
    setActiveTask(null)
    setPendingTaskSession({
      sessionId: reuseSessionId ?? '',
      org: preferredOrg,
      title: NEW_TASK_NAME,
      projectIds: [],
    })
    if (!reuseSessionId) setActiveSessionId(null)
    setTaskCwd({ kind: 'default', label: '新建工作空间' })
    setTaskModuleRequest(null)
    setMobileSidebarOpen(false)
    choosePendingIdentity(null)
    if (!reuseSessionId) writeLastChatContext(null)
  }, [creatingTask, preferredOrg, choosePendingIdentity, activeTask, activeSessionId])

  // ── 2026-10-28 task-thread: transcript card actions ─────────────────
  const applyTaskResult = useCallback((updated: TaskView) => {
    setActiveTask((prev) => (prev?.id === updated.id ? updated : prev))
    void refreshChatTasks()
    void refetchSessions()
  }, [refreshChatTasks, refetchSessions])

  /** 决策卡的选择写回卡片消息（服务端 metadata）——卡片随即「所选高亮 + 只读」。 */
  const recordDecision = useCallback(async (
    messageId: string | undefined,
    actionId: string,
    extra?: { label?: string; entryId?: string },
  ) => {
    if (!messageId) return
    try {
      await agentApi.recordCardDecision(messageId, {
        actionId,
        ...(extra?.label ? { label: extra.label } : {}),
        ...(extra?.entryId ? { entryId: extra.entryId } : {}),
      })
      // 以服务端为准重拉实录：卡片从可点变成只读，刷新前就已经一致。
      await loadMessages()
    } catch {
      /* 落库失败不阻断动作本身；下次刷新卡片仍是可选态，用户可再点一次 */
    }
  }, [loadMessages])

  const executeTaskAction = useCallback(async (
    taskId: string,
    actionId: string,
    activity?: AgentMessage['activity'],
    messageId?: string,
  ) => {
    if (!taskId || cardBusy) return
    const payload = (activity?.payload ?? {}) as Record<string, unknown>
    const action = actionId === 'confirm_action' ? String(payload.action ?? '') : actionId
    const clickedLabel = (activity?.actions ?? []).find((a) => a.id === actionId)?.label
    if (actionId === 'cancel_action') {
      void recordDecision(messageId, actionId, { label: clickedLabel })
      toast.message('已取消')
      return
    }
    if (action === 'abort') {
      setCardConfirm({ taskId, action, activity, messageId })
      return
    }
    setCardBusy(true)
    try {
      let updated: TaskView | null = null
      switch (action) {
        case 'trigger':
          updated = await triggerTask(taskId)
          break
        case 'launch_now':
          // 「立即执行」：入列与触发是一体的 —— silent_card 让服务端跳过
          // 「已入列 · 待触发」事件卡，只留「任务开始执行」卡（2026-10-28）。
          await readyTask(taskId, { silentCard: true })
          updated = await triggerTask(taskId)
          break
        case 'enqueue':
          updated = await readyTask(taskId)
          toast.success('已入列 · 等你手动触发')
          break
        case 'schedule':
          // 定时要走对话框：选择等真正排上之后再写回卡片（取消对话框 = 没决定）。
          pendingScheduleDecisionRef.current = messageId
            ? { messageId, label: clickedLabel }
            : null
          setScheduleTaskId(taskId)
          return
        case 'pause':
          updated = await pauseTask(taskId)
          break
        case 'resume':
          updated = await resumeTask(taskId)
          break
        case 'inject': {
          const intervention = typeof payload.intervention === 'string' ? payload.intervention : undefined
          await pauseTask(taskId)
          updated = await resumeTask(taskId, intervention)
          break
        }
        case 'reopen':
          updated = await reopenTask(taskId)
          break
        case 'retry_archive':
          await postArchiveRetry(taskId)
          updated = await getTask(taskId)
          toast.success('归档续跑已触发')
          break
        case 'duplicate': {
          const result = await duplicateTask(taskId)
          updated = result.task
          break
        }
        case 'open_task': {
          // 跟进任务卡：服务端已创建任务+会话，这里直接切过去。
          const nextTaskId = String(payload.followupTaskId ?? '')
          if (!nextTaskId) return
          const nextTask = await getTask(nextTaskId)
          void refreshChatTasks()
          void refetchSessions()
          handleSelectTask(nextTask)
          return
        }
        case 'open_spec':
          setTaskModuleRequest({ module: 'plan', nonce: Date.now() })
          return
        case 'open_changes':
          setTaskModuleRequest({ module: 'changes', nonce: Date.now() })
          return
        case 'open_acceptance':
          setTaskModuleRequest({ module: 'acceptance', nonce: Date.now() })
          return
        case 'open_run':
          setTaskModuleRequest({ module: 'run', nonce: Date.now() })
          return
        case 'open_archive':
          setTaskModuleRequest({ module: 'archive', nonce: Date.now() })
          return
        case 'open_usage':
          setTaskModuleRequest({ module: 'usage', nonce: Date.now() })
          return
        case 'new_task':
          void handleCreateTask()
          return
        case 'keep_editing':
          void recordDecision(messageId, actionId, { label: clickedLabel })
          toast.message('继续改规格')
          return
        // ── 验收引导（2026-10-30 AI-native）──────────────────────────────
        case 'acceptance_pass': {
          const itemId = String(payload.itemId ?? '')
          if (!itemId) return
          await recordAcceptanceCheck(taskId, { item_id: itemId, decision: 'pass' })
          const title = String(payload.title ?? itemId)
          toast.success(`已记通过：${title}`)
          sendMessage(`[验收] ✓ 通过「${title}」—— 继续下一项。`, { model, effort, maxContext })
          break
        }
        case 'acceptance_fail':
        case 'acceptance_skip': {
          const itemId = String(payload.itemId ?? '')
          if (!itemId) return
          setAcceptNoteText('')
          setAcceptNote({
            taskId,
            itemId,
            decision: action === 'acceptance_fail' ? 'fail' : 'skip',
            actionId,
            messageId,
            label: clickedLabel,
            title: typeof payload.title === 'string' ? payload.title : itemId,
          })
          return // 等用户在弹框里写原因
        }
        case 'acceptance_escalate_confirm': {
          const feedback = String(payload.feedback ?? '').trim()
          const phaseIndex = Number(payload.phaseIndex)
          const roundIndex = Number(payload.roundIndex)
          if (!feedback || !Number.isFinite(phaseIndex) || !Number.isFinite(roundIndex)) {
            toast.error('升级信息不完整（缺反馈或轮次坐标）')
            return
          }
          const itemIds = Array.isArray(payload.itemIds) ? payload.itemIds as unknown[] : []
          const reopen = itemIds
            .map((id) => String(id).split(':')[1])
            .filter((t): t is string => !!t && t !== 'spec')
          const result = await postAcceptance(taskId, {
            phase_index: phaseIndex,
            round_index: roundIndex,
            decision: 'rejected',
            feedback,
            ...(reopen.length ? { reopen_tickets: [...new Set(reopen)] } : {}),
          })
          void recordDecision(messageId, actionId, { label: clickedLabel })
          toast.success(
            result.next_action === 'dispatched'
              ? `已升级 — 修复轮 Round ${result.dispatch?.round_index ?? '?'} 开跑`
              : '已打回（反馈已落 fix-feedback）',
          )
          updated = result.task
          break
        }
        case 'acceptance_regenerate': {
          const r = await regenerateAcceptancePlan(taskId)
          toast[r.ok ? 'success' : 'error'](r.ok ? '已重新生成验收方案' : `重生成被拒：${r.reason ?? '未知原因'}`)
          return
        }
        case 'acceptance_open_window':
          setTaskModuleRequest({ module: 'acceptance', nonce: Date.now() })
          return
        default:
          return
      }
      // 决策卡上的选择：动作成功后写回卡片 → 所选高亮、其余只读。
      if (DECISION_ACTION_IDS.has(actionId)) {
        void recordDecision(messageId, actionId, { label: clickedLabel })
      }
      if (updated) applyTaskResult(updated)
    } catch (err: unknown) {
      if (err instanceof TaskReadyGateError) {
        toast.error(`入列被拒：缺少 ${err.missing.join('、')}`)
        setTaskModuleRequest({ module: 'plan', nonce: Date.now() })
      } else {
        toast.error(err instanceof Error ? err.message : '任务操作失败')
      }
    } finally {
      setCardBusy(false)
    }
  }, [cardBusy, applyTaskResult, handleCreateTask, handleSelectTask, refreshChatTasks, refetchSessions, recordDecision, sendMessage, model, effort, maxContext])

  const confirmDestructiveCardAction = useCallback(async () => {
    if (!cardConfirm || cardBusy) return
    setCardBusy(true)
    try {
      const updated = await abortTask(cardConfirm.taskId)
      applyTaskResult(updated)
      if (cardConfirm.messageId) {
        void recordDecision(cardConfirm.messageId, 'confirm_action', { label: '确认执行' })
      }
      toast.success('已中止任务')
      setCardConfirm(null)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '中止失败')
    } finally {
      setCardBusy(false)
    }
  }, [cardConfirm, cardBusy, applyTaskResult, recordDecision])

  /** 验收 ✕/⊘ 的原因确认：写进 checks（进退回反馈 + 下轮 carryover），并让
   *  Agent 接着引导（小修 / 升级由它按上下文处理）。 */
  const confirmAcceptNote = useCallback(async () => {
    if (!acceptNote || acceptNoteBusy) return
    const note = acceptNoteText.trim()
    if (!note) return
    setAcceptNoteBusy(true)
    try {
      await recordAcceptanceCheck(acceptNote.taskId, {
        item_id: acceptNote.itemId,
        decision: acceptNote.decision,
        note,
      })
      void recordDecision(acceptNote.messageId, acceptNote.actionId, { label: acceptNote.label })
      const mark = acceptNote.decision === 'fail' ? '✕ 不通过' : '⊘ 跳过'
      toast.success(`已记录：${mark}「${acceptNote.title}」`)
      sendMessage(
        `[验收] ${mark}「${acceptNote.title}」：${note}\n` +
          '请按验收引导处理：能当场小修（只改直接相关的 ≤2 个文件、不改 spec）就修完重跑证据再确认；'
          + '超出范围请发起升级（propose_acceptance_escalation）。',
        { model, effort, maxContext },
      )
      setAcceptNote(null)
      setAcceptNoteText('')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '核对写入失败')
    } finally {
      setAcceptNoteBusy(false)
    }
  }, [acceptNote, acceptNoteText, acceptNoteBusy, recordDecision, sendMessage, model, effort, maxContext])

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{
        taskId?: string | null
        actionId?: string
        activity?: AgentMessage['activity']
        messageId?: string
      }>).detail
      if (!detail?.taskId || !detail.actionId) return
      void executeTaskAction(detail.taskId, detail.actionId, detail.activity, detail.messageId)
    }
    window.addEventListener('octopus:task-card-action', onAction)
    return () => {
      window.removeEventListener('octopus:task-card-action', onAction)
    }
  }, [executeTaskAction])

  // Task status/execution events reload the transcript (silent cards are
  // inserted server-side; draft/ready threads have no workspace SSE channel).
  useEffect(() => {
    if (!activeTask?.id) return
    const url = `${getServerUrl()}/api/tasks/events`
    const onTask = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { task_id?: string }
        if (data.task_id !== activeTask.id) return
        void loadMessages()
        void refreshChatTasks()
      } catch {
        /* malformed frame */
      }
    }
    const offs = [
      subscribeSSE(url, TASK_STATUS_EVENT, onTask),
      subscribeSSE(url, TASK_EXECUTION_EVENT, onTask),
      // 验收项写入（窗口点 / Agent 按口语记录）→ 重拉实录，让卡片的「已选」立刻对上。
      subscribeSSE(url, TASK_ACCEPTANCE_CHECK_EVENT, onTask),
    ]
    return () => offs.forEach((off) => off())
  }, [activeTask?.id, loadMessages, refreshChatTasks])

  // Cross-app entry points: the tasks board's [+新建任务] and draft cards
  // open the unified chat instead of the legacy authoring modal.
  useEffect(() => {
    const onNewTask = () => { void handleCreateTask() }
    const onOpenTask = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; view?: 'acceptance' }>).detail
      const taskId = detail?.taskId
      if (!taskId) return
      getTask(taskId)
        .then((task) => {
          handleSelectTask(task, detail?.view === 'acceptance' ? { module: 'acceptance' } : undefined)
          // getTask() carries the raw row status — awaiting_review is derived,
          // so hydrate via the list refresh; the activeTask reconcile effect
          // above then swaps in the effective status.
          void refreshChatTasks()
        })
        .catch(() => toast.error('任务不存在或已被删除'))
    }
    window.addEventListener('octopus:new-task', onNewTask)
    window.addEventListener('octopus:open-task', onOpenTask)
    return () => {
      window.removeEventListener('octopus:new-task', onNewTask)
      window.removeEventListener('octopus:open-task', onOpenTask)
    }
  }, [handleCreateTask, handleSelectTask, refreshChatTasks])

  useEffect(() => {
    const onOpenWorkflow = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string; executionId?: string; title?: string }>).detail
      if (!detail?.workspaceId || !detail?.executionId) return
      setWorkflowWindow({
        workspaceId: detail.workspaceId,
        executionId: detail.executionId,
        title: detail.title,
      })
    }
    window.addEventListener('octopus:open-workflow', onOpenWorkflow)
    return () => window.removeEventListener('octopus:open-workflow', onOpenWorkflow)
  }, [])

  const sidebarTasks = useMemo(() => {
    if (activeTask?.status === 'draft' && !chatTasks.some((task) => task.id === activeTask.id)) {
      return [activeTask, ...chatTasks]
    }
    return chatTasks
  }, [chatTasks, activeTask])

  // 项目绑定入口（2026-10-28 用户定稿：项目是任务维度资产）：
  //   · pending（任务未落盘）——作业坞尚不存在（无 workspaceId），留在 composer
  //     hero 第二行/停靠 ctrlbar；
  //   · 已落盘 —— 挪到作业坞「项目」图标（dockProject），composer 保持纯净。
  const draftControls = (hero: boolean) => (
    <TaskProjectChip
      hero={hero}
      org={pendingTaskSession?.org ?? preferredOrg}
      orgs={appOrgs.map((o) => o.name)}
      onOrgChange={(next) => {
        rememberTaskOrg(next)
        setPendingTaskSession((prev) => (prev ? { ...prev, org: next, projectIds: [] } : prev))
      }}
      projectIds={pendingTaskSession?.projectIds ?? []}
      onSaved={(ids) => {
        if (pendingTaskSession) {
          setPendingTaskSession({ ...pendingTaskSession, projectIds: ids })
        }
      }}
    />
  )

  const draftLead = pendingTaskSession ? draftControls(false) : undefined

  const dockProject = activeTask ? (
    <TaskProjectChip
      dock
      org={activeTask.repo_group ?? preferredOrg}
      projectIds={activeTask.project_ids ?? []}
      taskId={activeTask.id}
      onSaved={(_ids, updated) => {
        if (updated) {
          setActiveTask(updated)
          void refreshChatTasks()
        }
      }}
    />
  ) : undefined

  // 任务线程 = 草稿期 + 已落盘任务（2026-10-28）：composer 第二行两种状态同构 ——
  // 不显示工作区名与分身身份（工作区/身份归侧栏任务行与作业坞承载；运行态身份
  // 由服务端按状态解析，用户选不了也不用选）。
  const taskThread = draftScope || !!activeTask

  // 停靠态主对话：只有「自定义工作区」才留下名字；默认 main-agent 工作区
  // 不渲染任何字（需求 1）。身份由 ＋ 面板接管，不再单占一个文字 chip。
  const mainLead = !taskThread && activeSessionId && workspaceLabel ? (
    <span
      data-session-workspace
      title={`工作区：${workspaceLabel}`}
      className="flex h-[22px] items-center gap-1 rounded-[7px] px-1.5 text-[10.5px] text-pop-dim"
    >
      <Folder className="size-3" />
      <span className="max-w-[140px] truncate">{workspaceLabel}</span>
    </span>
  ) : undefined

  // 2026-10-28 新建开发任务向新建对话看齐：pendingTask 空态同样走 hero ——
  // composer 居中、cwd/项目控件挪到第二行；复用中的会话已有实录、或草稿已
  // 成行追问时，回落到停靠态。判定与 ChatArea 的 heroMode 对齐（空消息 + 非流式）。
  const heroActive = (draftScope ? !!pendingTaskSession : !activeSessionId)
    && !streaming && viewMessages.length === 0

  // 输入框控件条的「当前身份」贴纸（2026-10-30 用户定稿）：
  //   · 任务线程：身份由服务端按任务状态派生（草稿=作者 → 执行/验收=执行者 →
  //     终态=主 Agent），用户不能主动切身份 → 只读（锁形，无 ✕）；
  //   · 普通会话：显示当前分身身份，悬停 ✕ 清除回主身份；
  //   · hero 新会话：身份由下方单选选择器承担，不重复挂贴纸。
  const identityDisplay: ComposerIdentityDisplay | undefined = (() => {
    if (taskThread) {
      const status = activeTask?.status
      if (pendingTaskSession || status === 'draft') {
        return { label: '作者 · task-author', active: true, readOnly: true, title: '任务对话的身份由任务状态自动派生，不可手动切换' }
      }
      if (status === 'done' || status === 'aborted' || status === 'failed') {
        return { label: '主 Agent', active: false, readOnly: true, title: '任务已结束，对话回到主身份（只读）' }
      }
      return { label: '执行者 · task-doer', active: true, readOnly: true, title: '任务对话的身份由任务状态自动派生，不可手动切换' }
    }
    // 身份取数窗口内先不渲染，避免先闪一下「主 Agent」再变成分身。
    if (heroActive || !identity.loaded) return undefined
    return identity.activeName
      ? {
          label: identity.label ?? identity.activeName,
          active: true,
          onClear: () => { void identity.switchTo(null) },
          title: `当前身份：${identity.label ?? identity.activeName}（悬停 ✕ 清除，回到主身份）`,
        }
      : { label: '主 Agent', active: false, title: '当前为主身份（主 Agent）' }
  })()

  const explorerWorkspaceId =
    activeTask?.workspace_id ??
    activeSession?.workspace_id ??
    (draftScope ? taskCwd.workspaceId : mainCwd.workspaceId) ??
    null
  const explorerWorkspaceName =
    activeTask?.name ?? activeSession?.title ?? (draftScope ? taskCwd.label : mainCwd.label)
  const activitySnapshot = useActivitySnapshot(explorerWorkspaceId, chatTasks, runningAgents, toolCalls)

  // ＋ 面板的「工作区自带」层：把当前工作区（任务 / 会话 / 待发送 cwd）传下去。
  // 名称优先用本地的 cwd chip 文案；会话自带 workspace 没有本地文案时用泛称。
  const composerWorkspaceContext = explorerWorkspaceId
    ? {
        id: explorerWorkspaceId,
        label:
          activeTask?.workspace_id === explorerWorkspaceId
            ? activeTask.name
            : (draftScope ? taskCwd.workspaceId : mainCwd.workspaceId) === explorerWorkspaceId
              ? (draftScope ? taskCwd.label : mainCwd.label)
              : '当前工作区',
      }
    : null

  // Server-originated wake turns (workflow/task events → ChatEventBridge) have
  // no client SSE. The workspace channel tells the open chat to tail them.
  const activeWorkspaceId = activeSession?.workspace_id ?? null
  useEffect(() => {
    if (!activeWorkspaceId || !activeSessionId) return
    const off = subscribeSSE(
      `${getServerUrl()}/api/workspaces/${activeWorkspaceId}/events`,
      'session_updated',
      (event) => {
        try {
          const data = JSON.parse(event.data) as { sessionId?: string; wake?: boolean; phase?: string }
          if (data.sessionId !== activeSessionId) return
          if (data.wake && data.phase === 'started') {
            void checkAndResume(activeSessionId)
          } else {
            void loadMessages()
          }
          void refetchSessions()
        } catch {
          /* malformed frame — ignore */
        }
      },
    )
    return off
  }, [activeWorkspaceId, activeSessionId, checkAndResume, loadMessages, refetchSessions])

  return (
    <div className={cn('ui-font relative flex h-full min-h-0', resizingSidebar && 'cursor-col-resize select-none [&_*]:cursor-col-resize')}>
      <h1 className="sr-only">对话</h1>
      {/* Desktop sidebar */}
      {!sidebarCollapsed && (
        <aside
          className="relative hidden shrink-0 border-r border-white/[0.06] md:flex md:flex-col"
          style={{ width: sidebarWidth }}
          data-chat-sidebar
        >
          <ChatSidebar
            tasks={sidebarTasks}
            tasksLoading={chatTasksLoading}
            activeTaskId={activeTask?.id ?? null}
            onSelectTask={handleSelectTask}
            pendingTask={pendingTaskSession ? { sessionId: pendingTaskSession.sessionId, title: pendingTaskSession.title } : null}
            activePendingTask={!!pendingTaskSession}
            sessions={sessions}
            sessionsLoading={sessionsLoading}
            activeSessionId={activeTask ? null : activeSessionId}
            onSelectSession={handleSelectSession}
            runningSessionIds={runningSessionIds}
            onCreateSession={handleCreateSession}
            onCreateTask={handleCreateTask}
            onRenameSession={renameSession}
            onDeleteSession={removeSession}
            onRenameTask={openTaskRename}
            onDeleteTask={setDeleteTarget}
            searchOpen={sidebarSearchOpen}
            onSearchOpenChange={setSidebarSearchOpen}
            onCollapse={() => setSidebarCollapsed(true)}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            title="拖动调整宽度 · 双击复位"
            data-testid="chat-sidebar-resizer"
            onPointerDown={handleSidebarResizeStart}
            onPointerMove={handleSidebarResizeMove}
            onPointerUp={handleSidebarResizeEnd}
            onPointerCancel={handleSidebarResizeEnd}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
            className={cn(
              'absolute -right-1 top-0 z-20 hidden h-full w-2 cursor-col-resize touch-none md:block',
              resizingSidebar ? 'bg-white/[0.12]' : 'hover:bg-white/[0.06]',
            )}
          />
        </aside>
      )}

      {/* Collapsed rail: floating capsule (sidebar toggle · search · new chat). */}
      {sidebarCollapsed && (
        <div
          data-testid="chat-sidebar-collapsed"
          className="absolute left-3 top-2.5 z-30 hidden items-center gap-0.5 rounded-full border border-white/[0.08] bg-pop-paper/85 p-1 shadow-pop-lg backdrop-blur-xl md:flex"
        >
          <button
            type="button"
            aria-label="开启新对话"
            title="开启新对话"
            onClick={handleCreateSession}
            className="grid size-7 place-items-center rounded-full text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
          >
            <SquarePen className="size-[15px]" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="搜索对话"
            title="搜索对话"
            onClick={() => expandSidebar({ focusSearch: true })}
            className="grid size-7 place-items-center rounded-full text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
          >
            <Search className="size-[15px]" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="展开侧栏"
            title="展开侧栏"
            onClick={() => expandSidebar()}
            className="grid size-7 place-items-center rounded-full text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
          >
            <PanelLeft className="size-[15px]" strokeWidth={1.8} />
          </button>
        </div>
      )}

      {/* Mobile sidebar */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="w-[264px] border-0 bg-pop-idle p-0 pt-10 md:hidden">
          <ChatSidebar
            tasks={sidebarTasks}
            tasksLoading={chatTasksLoading}
            activeTaskId={activeTask?.id ?? null}
            onSelectTask={handleSelectTask}
            pendingTask={pendingTaskSession ? { sessionId: pendingTaskSession.sessionId, title: pendingTaskSession.title } : null}
            activePendingTask={!!pendingTaskSession}
            sessions={sessions}
            sessionsLoading={sessionsLoading}
            activeSessionId={activeTask ? null : activeSessionId}
            onSelectSession={handleSelectSession}
            runningSessionIds={runningSessionIds}
            onCreateSession={handleCreateSession}
            onCreateTask={handleCreateTask}
            onRenameSession={renameSession}
            onDeleteSession={removeSession}
            onRenameTask={openTaskRename}
            onDeleteTask={setDeleteTarget}
            searchOpen={sidebarSearchOpen}
            onSearchOpenChange={setSidebarSearchOpen}
          />
        </SheetContent>
      </Sheet>

      {/* Main chat / task workbench — no second chrome row, macOS content-first. */}
      <div className="relative flex min-w-0 flex-1 flex-col pt-10 md:pt-0">
        <button
          type="button"
          aria-label="打开会话列表"
          title="打开会话列表"
          onClick={() => setMobileSidebarOpen(true)}
          className="absolute left-3 top-2.5 z-30 grid size-7 place-items-center rounded-md border border-white/10 bg-pop-paper/80 text-pop-dim backdrop-blur transition-colors hover:text-pop-ink md:hidden"
        >
          <Menu className="size-3.5" />
        </button>
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 顶部状态条已移除（2026-10-28 用户定稿）：状态/身份/工作区信息
              由侧栏任务行与作业坞承载，对话区保持纯净转录。 */}
          <ChatArea
            messages={viewMessages}
            streaming={streaming}
            streamContent={streamContent}
            streamThinking={streamThinking}
            streamTimeline={streamTimeline}
            turnStartedAt={turnStartedAt}
            isThinking={isThinking}
            toolCalls={toolCalls}
            pendingConfirm={pendingConfirm}
            error={chatError}
            statusMessage={statusMessage}
            commands={slashCommandList}
            onSend={handleSendMessage}
            onStop={stopGenerate}
            onConfirm={handleConfirm}
            hasSession={!!activeSessionId}
            contextUsage={contextUsage}
            sessionUsage={sessionUsage}
            taskUsage={activeTask ? taskUsage : undefined}
            currentModel={model}
            onModelChange={setModel}
            effort={effort}
            onEffortChange={setEffort}
            maxContext={maxContext}
            onMaxContextChange={setMaxContext}
            modelPresets={modelPresets}
            showUsagePlaceholders
            showComposerAttach
            tui
            onSteer={(message, opts) => void steer(message, {
              model, effort, maxContext, subagents: opts?.subagents,
            })}
            steerActiveRef={steeringRef}
            resumeTailing={resumeStreaming}
            emptyStateTitle={draftScope ? '描述要开发的任务' : undefined}
            emptyStateDescription={draftScope ? '第一句话会成为任务草稿的标题，后续对话用于澄清与拆分 Phase。' : undefined}
            composerLeading={draftScope && !heroActive ? draftLead : mainLead}
            composerPlaceholder={draftScope ? '描述要开发的任务…　⏎ 发送' : '问主 Agent…　⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行'}
            // hero：新建对话 = 空主会话；新建开发任务 = 未落盘的 pendingTask（同一套
            // 居中 composer + 第二行控件，2026-10-28 看齐）。
            heroEmpty={heroActive}
            composerHeroFooter={!heroActive ? undefined : draftScope ? draftControls(true) : (
              <CwdPicker
                mode="main"
                org={preferredOrg}
                value={mainCwd}
                onChange={setMainCwd}
                hero
                // 选了身份 → 默认档不再是 Main Agent，而是该分身自己的工作区。
                defaultLabel={pendingIdentity ? `${pendingIdentity.label} 工作区` : undefined}
                defaultHint={pendingIdentity ? '该分身自己的目录' : undefined}
              />
            )}
            workspaceContext={composerWorkspaceContext}
            identityDisplay={identityDisplay}
            identity={!taskThread ? (
              activeSessionId
                ? {
                    activeName: identity.activeName,
                    label: identity.label,
                    onSwitch: (cloneName) => { void identity.switchTo(cloneName) },
                  }
                : {
                    // 新会话：身份先选着，第一条消息创建 session 后立刻写角色卡。
                    activeName: pendingIdentity?.name ?? null,
                    label: pendingIdentity?.label ?? null,
                    onSwitch: choosePendingIdentity,
                  }
            ) : undefined}
            composerSeed={composerSeed}
            messageExtras={extras}
            transcriptTail={tail}
            timelineClearDock={!!explorerWorkspaceId}
          />
        </div>

        {/* One main chat for every task state. Task modules float over it.
            2026-10-31 消耗窗通用化：这一层在没有任务时也挂载，只承载会话账本。 */}
        <TaskModulesLayer
          task={activeTask}
          sessionId={activeTask ? null : activeSessionId}
          sessionTitle={activeSession?.title ?? null}
          windows={activeTask ? (taskWindows[activeTask.id] ?? {}) : sessionUsageWindows}
          onTaskAction={activeTask ? (action) => { void executeTaskAction(activeTask.id, action) } : undefined}
          onWindowsChange={(next) => {
            if (activeTask) {
              setTaskWindows((prev) => ({ ...prev, [activeTask.id]: next }))
            } else {
              setSessionUsageWindows(next)
            }
          }}
          onMutated={() => {
            void refreshChatTasks()
            void refetchSessions()
          }}
          openModule={taskModuleRequest}
          onOpenLinkedTask={openLinkedTask}
        />
      </div>

      <WorkspaceExplorerDock
        workspaceId={explorerWorkspaceId}
        workspaceName={explorerWorkspaceName}
        task={activeTask}
        taskProject={dockProject}
        taskWindows={activeTask ? (taskWindows[activeTask.id] ?? {}) : {}}
        usageWindow={activeTask ? (taskWindows[activeTask.id]?.usage ?? null) : (sessionUsageWindows.usage ?? null)}
        onOpenUsage={() => setTaskModuleRequest({ module: 'usage', nonce: Date.now() })}
        onOpenTaskModule={(module) => setTaskModuleRequest({ module, nonce: Date.now() })}
        onTaskAction={(action) => { if (activeTask) void executeTaskAction(activeTask.id, action) }}
        activity={activitySnapshot}
        sidebarWidth={sidebarCollapsed ? 0 : sidebarWidth}
      />

        {/* Tool call dialog —— 悬浮按钮唤起的弹窗（原先的右列 tab 会被作业坞挡死） */}
        <ToolCallDialog
          open={showToolPanel && toolCalls.length > 0}
          onOpenChange={setShowToolPanel}
          toolCalls={toolCalls}
        />

        {/* Tool dialog toggle —— 运行中有工具调用时浮在对话区右下角 */}
      {toolCalls.length > 0 && !showToolPanel && (
        <button
          onClick={() => setShowToolPanel(true)}
          className="absolute bottom-28 right-6 hidden items-center gap-1.5 rounded-full border border-white/[0.08] bg-pop-paper/85 px-3 py-1.5 text-[11px] text-pop-dim shadow-pop backdrop-blur transition-colors hover:text-pop-ink lg:flex"
        >
          工具调用 ({toolCalls.length})
        </button>
      )}

      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null) }}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="ui-font w-[420px] max-w-[calc(100vw_-_32px)] rounded-2xl border border-white/[0.10] bg-pop-bg p-4"
        >
          <DialogTitle className="text-[14px] font-semibold text-pop-ink">重命名任务</DialogTitle>
          <Input
            autoFocus
            value={renameValue}
            maxLength={200}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void confirmTaskRename()
              if (event.key === 'Escape') setRenameTarget(null)
            }}
            className="mt-3"
            placeholder="任务名称"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button size="sm" variant="pop" disabled={!renameValue.trim() || taskBusy} onClick={() => void confirmTaskRename()}>
              {taskBusy ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title={deleteTarget?.status === 'running' ? '中止并删除任务？' : '删除任务？'}
        description={
          deleteTarget?.status === 'running'
            ? `「${deleteTarget.name}」正在运行。删除会先中止当前执行，然后移除任务与工作区记录。`
            : `「${deleteTarget?.name ?? ''}」将被删除，此操作不可撤销。`
        }
        confirmLabel={deleteTarget?.status === 'running' ? '中止并删除' : '删除'}
        variant="destructive"
        onConfirm={() => void confirmTaskDelete()}
      />

      <ConfirmDialog
        open={!!cardConfirm}
        onOpenChange={(open) => { if (!open) setCardConfirm(null) }}
        title="确认中止任务？"
        description="会停止当前轮并清理工作区，此操作不可撤销。"
        confirmLabel="确认中止"
        variant="destructive"
        loading={cardBusy}
        onConfirm={() => void confirmDestructiveCardAction()}
      />

      {/* 验收 ✕/⊘ 原因（必填）—— 写进 checks，并交给 Agent 继续引导 */}
      <Dialog open={!!acceptNote} onOpenChange={(open) => { if (!open && !acceptNoteBusy) setAcceptNote(null) }}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="ui-font w-[440px] max-w-[calc(100vw_-_32px)] rounded-2xl border border-white/[0.10] bg-pop-bg p-4"
        >
          <DialogTitle className="text-[14px] font-semibold text-pop-ink">
            {acceptNote?.decision === 'fail' ? '哪里不对？' : '为什么这次可以不验？'}
            <span className="ml-2 text-[11px] font-normal text-pop-dim">{acceptNote?.title}</span>
          </DialogTitle>
          <textarea
            autoFocus
            rows={4}
            value={acceptNoteText}
            onChange={(e) => setAcceptNoteText(e.target.value)}
            placeholder={acceptNote?.decision === 'fail'
              ? '实际现象 / 期望结果 —— 会进退回反馈，并重开对应票'
              : '再豁免一次需要新原因 —— 下轮仍会问'}
            className="mt-3 w-full resize-y rounded-lg border border-pop-bd bg-pop-paper px-3 py-2 font-mono text-[11.5px] text-pop-ink outline-none focus:border-pop-pink/60"
            data-testid="acceptance-note-input"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={acceptNoteBusy} onClick={() => setAcceptNote(null)}>取消</Button>
            <Button
              size="sm"
              variant="pop"
              disabled={!acceptNoteText.trim() || acceptNoteBusy}
              onClick={() => void confirmAcceptNote()}
              data-testid="acceptance-note-confirm"
            >
              {acceptNoteBusy ? '记录中…' : acceptNote?.decision === 'fail' ? '确认不通过' : '确认跳过'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <TriggerDialog
        open={!!scheduleTaskId}
        onOpenChange={(open) => {
          if (!open) {
            setScheduleTaskId(null)
            pendingScheduleDecisionRef.current = null // 关掉对话框 = 没做决定
          }
        }}
        task={
          (activeTask && activeTask.id === scheduleTaskId
            ? activeTask
            : chatTasks.find((task) => task.id === scheduleTaskId)) ?? null
        }
        onTriggered={() => {
          const pending = pendingScheduleDecisionRef.current
          pendingScheduleDecisionRef.current = null
          if (pending) {
            void recordDecision(pending.messageId, 'schedule', { label: pending.label })
          }
          setScheduleTaskId(null)
          void refreshChatTasks()
          void refetchSessions()
        }}
      />

      {workflowWindow && (
        <WorkflowWindow
          workspaceId={workflowWindow.workspaceId}
          executionId={workflowWindow.executionId}
          title={workflowWindow.title}
          onClose={() => setWorkflowWindow(null)}
        />
      )}

    </div>
  )
}
