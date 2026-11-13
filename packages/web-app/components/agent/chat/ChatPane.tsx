'use client'

// 单个对话栏。分屏（左右两栏）时同一组件渲染两次：每栏有独立的 hook 状态
// （useAgentChat / 消息 / 任务 / 作业坞窗口），共享的只有侧栏、会话与任务列表。
//
// 2026-11-08 从 ChatTab 拆出：ChatTab 变成「侧栏 + 分屏壳」，这里只负责一栏的
// 转录、composer、作业坞与任务模块窗口。

import {
  useState, useEffect, useCallback, useMemo, useRef,
  type Dispatch, type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import { Folder, Menu } from 'lucide-react'
import { toast } from 'sonner'
import { useAgentChat, type UseAgentChatApiOverride, type ChatSubagentRef } from '@/hooks/useAgentChat'
import { buildSlashCommands } from './SlashCommandAutocomplete'
import { useSessionLedger } from '@/hooks/useSessionLedger'
import { useTaskUsage } from '@/hooks/useTaskUsage'
import { useComposerSettings } from '@/hooks/useComposerSettings'
import { useKcFeed } from '@/hooks/use-kc-feed'
import { useKcFindings } from '@/hooks/use-kc-findings'
import { useSessionIdentity } from '@/hooks/use-session-identity'
import * as agentApi from '@/lib/agent/api'
import type { AgentSession, AgentMessage } from '@/lib/agent/types'
import type { RunningAgentSession } from '@/lib/agent/api'
import { CwdPicker, type CwdChoice } from './cwd-picker'
import { ChatArea } from './ChatArea'
import { TaskModulesLayer } from '@/components/chat-workbench/task-modules-layer'
import { TriggerDialog } from '@/components/tasks/trigger-dialog'
import type { RunTarget, SubagentTarget, TaskModule, TaskWindowMap, YamlTarget } from '@/components/chat-workbench/task-window-types'
import { TaskProjectChip } from '@/components/chat-workbench/task-project-chip'
import { WorkspaceExplorerDock, type CabinDockModule } from '@/components/workspace/workspace-explorer-dock'
import { useActivitySnapshot } from '@/components/chat-workbench/inspector-activity'
import { WorkflowWindow } from '@/components/chat-workbench/workflow-window'
import { WorkflowYamlWindow } from '@/components/chat-workbench/workflow-yaml-window'
import { runTitle } from '@/components/chat-workbench/run-picker'
import {
  createTask, getTask, readyTask, TaskReadyGateError, updateTask, deleteTask, abortTask,
  triggerTask, pauseTask, resumeTask, reopenTask, duplicateTask, postArchiveRetry,
  postAcceptance, recordAcceptanceCheck, regenerateAcceptancePlan,
  type TaskView,
} from '@/lib/tasks-api'
import { rememberTaskOrg } from '@/lib/task-org'
import { NEW_TASK_NAME, NEW_WORKFLOW_TASK_NAME, taskNameFromMessage } from '@/lib/task-name'
import { buildTurnStats } from '@/lib/turn-stats'
import { writeLastChatContext } from '@/lib/last-chat-context'
import { subscribeSSE } from '@/lib/sse-manager'
import { TASK_ACCEPTANCE_CHECK_EVENT, TASK_EXECUTION_EVENT, TASK_STATUS_EVENT } from '@octopus/shared'
import { getServerUrl } from '@/lib/server-config'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/agent/shared/ConfirmDialog'
import type { ComposerIdentityDisplay } from './composer-identity-chip'
import { KcCard, type KcCardActionCtx } from '@/components/knowledge-center/cards/registry'
import {
  parseKcCardBlocks,
  type KcCardEvent,
  type KcCompileDiffCardData,
  type KcFindingCardData,
  type KcIngestCardData,
} from '@/lib/knowledge-center/card-protocol'
import { ChatPanePicker } from './chat-pane-picker'

export type ChatPaneSide = 'left' | 'right'

export interface PendingTaskSession {
  org: string
  title: string
  projectIds: string[]
  /** workflow-dev task kind (2026-11-06). */
  kind?: 'workflow-dev'
}

export interface ChatPaneWorkspaceOption {
  id: string
  name: string
}

/** 两栏共享的数据（由 ChatTab 壳统一取数，避免每栏各拉一遍）。 */
export interface ChatPaneShared {
  sessions: AgentSession[]
  sessionsLoading: boolean
  createNewSession: (opts?: {
    cwd?: string
    workspace_id?: string
    identity_clone?: string
  }) => Promise<AgentSession | null>
  updateSessionTitle: (id: string, title: string) => void
  refreshSessions: () => Promise<void>
  chatTasks: TaskView[]
  chatTasksLoading: boolean
  refreshChatTasks: () => Promise<void>
  runningAgents: RunningAgentSession[]
  appOrgs: string[]
  workspaces: ChatPaneWorkspaceOption[]
  preferredOrg: string
  /** 侧栏宽度（折叠时 0）—— 作业坞编辑器面板按它让位。 */
  sidebarWidth: number
}

/** 壳 → 栏的一次性指令（选择会话 / 任务、新建）。nonce 保证重复点击也会执行。 */
export type ChatPaneAction =
  | { type: 'select-session'; sessionId: string }
  | { type: 'select-task'; task: TaskView; module?: TaskModule }
  | { type: 'rename-task'; task: TaskView }
  | { type: 'delete-task'; task: TaskView }
  | { type: 'new-session' }
  | { type: 'new-task'; kind?: 'workflow-dev' }

export type ChatPaneCommand = ChatPaneAction & { nonce: number }

export interface ChatPaneProps {
  pane: ChatPaneSide
  /** 是否处于分屏（壳决定）。 */
  split: boolean
  /** 是否为焦点栏。 */
  focused: boolean
  /** 右栏（分屏里新开的那一栏）：空态显示「选择会话」选择器而不是新对话 hero。 */
  secondary: boolean
  sessionId: string | null
  setSessionId: (id: string | null) => void
  activeTask: TaskView | null
  setActiveTask: Dispatch<SetStateAction<TaskView | null>>
  pendingTaskSession: PendingTaskSession | null
  setPendingTaskSession: Dispatch<SetStateAction<PendingTaskSession | null>>
  command: ChatPaneCommand | null
  /** 任务模块窗的挂载点：整个聊天区（可跨分屏线），由壳提供。 */
  layerRoot: HTMLElement | null
  /** 另一栏正在显示的会话/任务：选择器里标出来，点它 = 聚焦另一栏，不重复打开。 */
  otherSessionId: string | null
  otherTaskId: string | null
  /** 选择器里点会话 → 壳统一去重/路由（可能落到另一栏）。 */
  onOpenSession: (sessionId: string) => void
  shared: ChatPaneShared
  onFocus: () => void
  onStreamingChange: (sessionId: string | null) => void
  onOpenSidebar: () => void
  onExitSplit: () => void
  onSwapPanes: () => void
  canSwap: boolean
  /** 舱壳注入的 dock 舱模块段（Cabin P2）；桌面缺省不传。
   *  只在舱主对话上给：舱内点开任务线程时由舱壳传 undefined，坞退回原样。 */
  dockCabinModules?: CabinDockModule[]
  dockCabinMoreModules?: CabinDockModule[]
  /** 舱壳：坞层级压在舱浮窗层之上（舱内任何线程都成立，与坞内容无关）。 */
  dockElevated?: boolean
  /** 舱壳注入（Cabin P3）：舱内新建任务绑 cabin_id + 复用舱 workspace。 */
  cabinId?: string | null
  cabinWorkspaceId?: string | null
}

/** 决策卡上「选择即写回卡片」的按钮 id。其余按钮（打开规格/运行窗…）只是导航，
 *  schedule / keep_editing 各自在分支里处理（定时要等对话框真正排上）。 */
const DECISION_ACTION_IDS = new Set([
  'launch_now', 'enqueue', 'confirm_action',
  // 2026-10-30 验收引导：逐项判定与升级确认同样写回卡片（只读留痕）。
  'acceptance_pass', 'acceptance_fail', 'acceptance_skip', 'acceptance_escalate_confirm',
])

export function ChatPane({
  pane,
  split,
  focused,
  secondary,
  sessionId,
  setSessionId,
  activeTask,
  setActiveTask,
  pendingTaskSession,
  setPendingTaskSession,
  command,
  layerRoot,
  otherSessionId,
  otherTaskId,
  onOpenSession,
  shared,
  onFocus,
  onStreamingChange,
  onOpenSidebar,
  onExitSplit,
  onSwapPanes,
  canSwap,
  dockCabinModules,
  dockCabinMoreModules,
  dockElevated,
  cabinId,
  cabinWorkspaceId,
}: ChatPaneProps) {
  const {
    sessions, sessionsLoading, createNewSession, updateSessionTitle,
    refreshSessions, chatTasks, chatTasksLoading, refreshChatTasks,
    runningAgents, appOrgs, workspaces, preferredOrg, sidebarWidth,
  } = shared

  const [creatingTask, setCreatingTask] = useState(false)
  const [taskModuleRequest, setTaskModuleRequest] = useState<{ module: TaskModule; nonce: number; runTarget?: RunTarget | null; subagentTarget?: SubagentTarget | null } | null>(null)
  const [yamlTarget, setYamlTarget] = useState<YamlTarget | null>(null)
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

  /**
   * 2026-10-28 task-thread: the MAIN chat is the task's only conversation.
   * `draftScope` only drives copy/lead chrome — it never swaps the chat engine
   * or renders a second workbench. Identity is server-derived from the task
   * state (role card + per-turn profile).
   */
  const activeSession = sessions.find((session) => session.id === sessionId)
  const draftScope = pendingTaskSession !== null || activeTask?.status === 'draft'
  const workflowDraft =
    pendingTaskSession?.kind === 'workflow-dev' || activeTask?.task_spec?.kind === 'workflow-dev'

  // 会话长期身份（v59 分身）：主对话用 agent 作用域，交给 ChatArea 的 ＋ 面板。
  // 任务线程的基础身份由服务端按任务状态派生（角色卡），这里只保留手动分身切换。
  const identity = useSessionIdentity({ kind: 'agent', sessionId })
  // 停靠态只在「工作区不是默认 main-agent」时显示名字；默认值整个 chip 不渲染。
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

  // Callback to update session title in sidebar when server auto-generates one
  const handleTitleUpdate = useCallback((sid: string, title: string) => {
    updateSessionTitle(sid, title)
  }, [updateSessionTitle])

  const handleQuickEditCommit = useCallback((data: { repo: string; commit: string; message: string }) => {
    toast.success(`已提交 ${data.repo} · ${data.message}`)
  }, [])

  const mainChatApi = useMemo<UseAgentChatApiOverride>(() => ({
    checkRunning: agentApi.getSessionRunning,
  }), [])

  const {
    messages, streaming, streamContent, streamThinking, streamTimeline, isThinking, toolCalls, pendingConfirm,
    error: chatError, statusMessage, backgroundTasks, contextUsage, slashCommands,
    sendMessage, stopGenerate, handleConfirm, loadMessages,
    steer, steeringRef, resumeStreaming, checkAndResume, streamingSessionId, turnStartedAt,
  } = useAgentChat(sessionId, {
    onTitleUpdate: handleTitleUpdate,
    api: mainChatApi,
    onQuickEditCommit: handleQuickEditCommit,
    // The main chat route emits a heartbeat every 15s, so 60s of complete
    // silence means the socket is dead — settle instead of spinning forever.
    stallMs: 60_000,
  })
  // Composer `/` menu — the CLI's advertised set (skills included), rebuilt
  // into grouped rows. Empty until the first turn of this server process.
  const slashCommandList = useMemo(() => buildSlashCommands(slashCommands), [slashCommands])
  // One ledger fetch serves both the composer token chip (aggregates) and the
  // per-turn timing/token stats in the transcript (calls).
  const { aggregates: sessionUsage, calls: sessionLedgerCalls } = useSessionLedger(sessionId, streaming)
  // Task thread: the composer chip shows the WHOLE task ledger (chat + every
  // round). Refetched on turn end and on task status/version changes.
  const taskUsage = useTaskUsage(
    activeTask?.id,
    `${activeTask?.version ?? ''}:${activeTask?.status ?? ''}:${streaming ? '1' : '0'}`,
  )

  // 分屏徽标：这一栏的流式状态报给壳（侧栏「运行中」药丸与窗口总览共用）。
  useEffect(() => {
    onStreamingChange(streaming && streamingSessionId ? streamingSessionId : null)
  }, [streaming, streamingSessionId, onStreamingChange])

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
    // workspace_id drives the session_updated subscription (task threads have no
    // session row to fall back on) — refresh it even when nothing else changed.
    const sameWorkspace = (fresh.workspace_id ?? null) === (activeTask.workspace_id ?? null)
    if (
      fresh.name !== activeTask.name ||
      fresh.status !== activeTask.status ||
      fresh.version !== activeTask.version ||
      !sameProjects ||
      !sameWorkspace
    ) {
      setActiveTask(fresh)
    }
  }, [chatTasks, activeTask, setActiveTask])
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
  // 2026-11-03：知识库窗口只读后，编译出的 conflict finding 卡回流到发起会话。
  // 这里只借 useKcFindings 的 adopt/ignore + 轮询态，不拉全库收件箱（autoLoad:false）。
  const findingOps = useKcFindings({ autoLoad: false })
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

  // 2026-11-10：Lane A finding 卡是编译时的沉淀快照（status 恒为创建时 open）。
  // 刷新/重进会话时按卡上 id 向服务端要活状态，终态卡才能显示「已修订 / 已忽略」。
  // 依赖用拼接串：流式 token 会不断重建 messages，按内容变化才触发回填。
  const findingCardIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const events of laneAByMsgId.values()) {
      for (const e of events) if (e.kind === 'finding') ids.add((e.data as KcFindingCardData).findingId)
    }
    return [...ids].sort().join(',')
  }, [laneAByMsgId])
  const hydrateFindingStatuses = findingOps.hydrateStatuses
  useEffect(() => {
    if (findingCardIdKey) void hydrateFindingStatuses(findingCardIdKey.split(','))
  }, [findingCardIdKey, hydrateFindingStatuses])

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
    if (e.kind === 'finding') {
      const d = e.data as KcFindingCardData
      const status = findingOps.findingStatus[d.findingId]
      const fix = findingOps.fixStates[d.findingId]
      if (!status && !fix) return e
      return {
        ...e,
        data: {
          ...d,
          ...(status ? { status } : {}),
          ...(fix ? { fix } : {}),
        },
      }
    }
    return e
  }, [feed.revertStates, feed.cards, findingOps.findingStatus, findingOps.fixStates])

  const ctx: KcCardActionCtx = useMemo(() => ({
    // 普通会话无 KC 右栏布局：开页/看 raw 类布局动作降级为无操作（回流链只产
    // ingest/compile-diff/source-summary/finding 等卡；其余动作钮在本宿主不可达）。
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
    adoptFinding: (findingId: string) => { void findingOps.adopt(findingId) },
    ignoreFinding: (findingId: string) => { void findingOps.ignore(findingId) },
    backfillWiki: () => {},
    dismissBackfill: () => {},
    recompilePack: () => {},
    retireCase: () => {},
  }), [feed.revert, feed.retryCompile, feed.restore, laneAIngestById, findingOps.adopt, findingOps.ignore])

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
    if (!sessionId) return
    // New session with pending message — server has 0 messages, skip load
    // to avoid wiping the optimistically-added user message
    if (pendingMessageRef.current) return
    // Always reload on switch: the hook resets the transcript, and the API
    // route (main vs task-author clone) is selected per session.
    loadMessages()
  }, [sessionId, loadMessages])

  // When a session is created and there's a pending message, send it — after
  // applying the identity picked in the hero: the role card must land before
  // the first turn, otherwise that turn starts as the base identity.
  useEffect(() => {
    if (!sessionId || !pendingMessageRef.current) return
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
    void agentApi.setSessionRole(sessionId, identityToApply.name)
      .catch(() => {})
      .finally(fire)
  }, [sessionId, sendMessage, model, effort, maxContext])

  // Task first message: fires in the render that already sees the created
  // session (so `sendMessage` is bound to it), after the hook's session-switch
  // effect has cleared the old transcript.
  useEffect(() => {
    const pending = pendingTaskSend
    if (!pending || sessionId !== pending.sessionId) return
    taskSendPendingRef.current = false
    pendingMessageRef.current = null
    setPendingTaskSend(null)
    sendMessage(pending.message, {
      model, effort, maxContext, subagents: pending.subagents,
    })
  }, [pendingTaskSend, sessionId, sendMessage, model, effort, maxContext])

  const handleSendMessage = useCallback((message: string, opts?: { subagents?: ChatSubagentRef[] }) => {
    if (!pendingTaskSession) {
      if (sessionId) {
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
        // activate:false —— 分屏时新会话归这一栏，别把另一栏的会话顶掉。
        void createNewSession(cwdOpts).then((created) => {
          if (!created) {
            pendingMessageRef.current = null
            return
          }
          writeLastChatContext({ kind: 'session', sessionId: created.id })
          setSessionId(created.id)
        })
      }
      return
    }

    // First message of a task thread: create ONE fresh main session, create the
    // draft on it, then send the message through the normal chat route. The
    // server resolves the task-author identity from the task's state.
    if (creatingTask) return
    const session = pendingTaskSession
    setCreatingTask(true)
    void (async () => {
      try {
        // Hold the plain send-effect and the transcript reload: this message
        // belongs to the task thread and needs the task row in place first.
        taskSendPendingRef.current = true
        pendingMessageRef.current = { message, subagents: opts?.subagents }
        const created = await createNewSession(
          taskCwd.kind === 'default'
            ? undefined
            : { workspace_id: taskCwd.workspaceId, cwd: taskCwd.path },
        )
        const sid = created?.id ?? ''
        if (!sid) throw new Error('无法创建任务会话')
        const task = await createTask({
          repo_group: session.org || undefined,
          name: taskNameFromMessage(message),
          source_chat_session_id: sid,
          task_spec: { format: 'v4', ...(session.kind ? { kind: session.kind } : {}) },
          project_ids: session.projectIds,
          ...(cabinId ? { cabin_id: cabinId } : {}),
          ...(taskCwd.kind === 'default'
            ? (cabinWorkspaceId ? { workspace_id: cabinWorkspaceId } : {})
            : { workspace_id: taskCwd.workspaceId, cwd: taskCwd.path }),
        })
        // The org this task landed in is the user's working org — reuse it for
        // the next new task instead of falling back to a sorted-first guess.
        rememberTaskOrg(task.repo_group ?? '')
        writeLastChatContext({ kind: 'task', taskId: task.id })
        setPendingTaskSession(null)
        setActiveTask(task)
        void refreshChatTasks()
        void refreshSessions()
        setSessionId(sid)
        // Send from the render that has `sid` as the hook's session — the
        // closure captured here still holds the pre-create null id (2026-10-29
        // bug: the turn silently never started, only a refresh showed it).
        setPendingTaskSend({ sessionId: sid, message, subagents: opts?.subagents })
      } catch (err: unknown) {
        taskSendPendingRef.current = false
        pendingMessageRef.current = null
        toast.error(err instanceof Error ? err.message : '创建任务失败')
      } finally {
        setCreatingTask(false)
      }
    })()
  }, [
    pendingTaskSession, creatingTask, sessionId, setSessionId, sendMessage, createNewSession,
    model, effort, maxContext, refreshChatTasks, refreshSessions, mainCwd, taskCwd, setActiveTask, setPendingTaskSession,
    cabinId, cabinWorkspaceId,
  ])

  const handleSelectSession = useCallback((id: string) => {
    taskSendPendingRef.current = false
    setPendingTaskSend(null)
    setActiveTask(null)
    setPendingTaskSession(null)
    setTaskModuleRequest(null)
    setSessionId(id)
    writeLastChatContext({ kind: 'session', sessionId: id })
  }, [setActiveTask, setPendingTaskSession, setSessionId])

  const handleSelectTask = useCallback((task: TaskView, opts?: { module?: TaskModule }) => {
    setTaskModuleRequest(opts?.module ? { module: opts.module, nonce: Date.now() } : null)
    if (!task.source_chat_session_id) {
      toast.error('该任务没有关联的主会话')
      return
    }
    setPendingTaskSession(null)
    setActiveTask(task)
    setSessionId(task.source_chat_session_id)
    writeLastChatContext({ kind: 'task', taskId: task.id })
  }, [setActiveTask, setPendingTaskSession, setSessionId])

  /** 会话消耗窗里的工作流行 → 打开对应任务（列表里没有就现取一次）。 */
  const openLinkedTask = useCallback((taskId: string) => {
    if (taskId === otherTaskId) {
      toast.message('该任务已在另一栏打开')
      return
    }
    const known = chatTasks.find((task) => task.id === taskId)
    if (known) {
      handleSelectTask(known)
      return
    }
    getTask(taskId)
      .then((task) => handleSelectTask(task))
      .catch(() => { toast.error('该任务已不存在') })
  }, [chatTasks, handleSelectTask, otherTaskId])

  const openTaskRename = useCallback((task: TaskView) => {
    setRenameTarget(task)
    setRenameValue(task.name)
  }, [])

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
      void refreshSessions()
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
        setSessionId(null)
        writeLastChatContext(null)
      }
      setDeleteTarget(null)
      void refreshChatTasks()
      void refreshSessions()
      toast.success('任务已删除')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setTaskBusy(false)
    }
  }

  const handleCreateSession = useCallback(() => {
    // 显式「新建对话」= 用户已经离开选择器，直接进 hero。
    setPickerBypassed(true)
    taskSendPendingRef.current = false
    setPendingTaskSend(null)
    setActiveTask(null)
    setPendingTaskSession(null)
    setTaskModuleRequest(null)
    // Lazy: the DB session is created on the first prompt, after cwd selection.
    setSessionId(null)
    setMainCwd({ kind: 'default', label: 'Main Agent 工作区' })
    choosePendingIdentity(null)
    writeLastChatContext(null)
  }, [choosePendingIdentity, setActiveTask, setPendingTaskSession, setSessionId])

  const handleCreateTask = useCallback(async (kind?: 'workflow-dev') => {
    if (creatingTask) return
    // 2026-11-09 用户反馈：从「自由会话」点新建开发任务没有进入新任务界面 ——
    // 旧逻辑会复用当前会话，于是界面停留在旧对话（只有侧栏多一条草稿行）。
    // 「新建」一律开全新线程（和「当前是任务」同款）：清掉会话 → 任务 hero；
    // 第一句话落盘时才创建会话并把 source_chat_session_id 绑到它。
    taskSendPendingRef.current = false
    setPendingTaskSend(null)
    setActiveTask(null)
    setPendingTaskSession({
      org: preferredOrg,
      title: kind === 'workflow-dev' ? NEW_WORKFLOW_TASK_NAME : NEW_TASK_NAME,
      projectIds: [],
      ...(kind ? { kind } : {}),
    })
    setSessionId(null)
    writeLastChatContext(null)
    setTaskCwd({ kind: 'default', label: '新建工作空间' })
    setTaskModuleRequest(null)
    choosePendingIdentity(null)
  }, [creatingTask, preferredOrg, choosePendingIdentity, setActiveTask, setPendingTaskSession, setSessionId])

  // ── 2026-10-28 task-thread: transcript card actions ─────────────────
  const applyTaskResult = useCallback((updated: TaskView) => {
    setActiveTask((prev) => (prev?.id === updated.id ? updated : prev))
    void refreshChatTasks()
    void refreshSessions()
  }, [refreshChatTasks, refreshSessions, setActiveTask])

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
          void refreshSessions()
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
  }, [cardBusy, applyTaskResult, handleCreateTask, handleSelectTask, refreshChatTasks, refreshSessions, recordDecision, sendMessage, model, effort, maxContext])

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

  // 分屏后两栏都会挂监听：只让「这张卡所属的那一栏」处理（taskId 对上当前任务）。
  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{
        taskId?: string | null
        actionId?: string
        activity?: AgentMessage['activity']
        messageId?: string
      }>).detail
      if (!detail?.taskId || !detail.actionId) return
      if (!activeTask || detail.taskId !== activeTask.id) return
      void executeTaskAction(detail.taskId, detail.actionId, detail.activity, detail.messageId)
    }
    window.addEventListener('octopus:task-card-action', onAction)
    return () => {
      window.removeEventListener('octopus:task-card-action', onAction)
    }
  }, [executeTaskAction, activeTask])

  // 运行事件卡的人选 → 回给 owner Agent，由它调 resolve_incident（决策权在
  // Agent，确认权在人）。卡片本身不改执行状态。点击卡片会先把该栏设为焦点，
  // 所以只有焦点栏回话（两栏都挂监听时不会重复发送）。
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  useEffect(() => {
    const onIncidentChoice = (event: Event) => {
      if (!focusedRef.current) return
      const detail = (event as CustomEvent<{
        incidentId?: string
        option?: string
      }>).detail
      if (!detail?.incidentId || !detail.option) return
      sendMessage(
        `[incident ${detail.incidentId}] 我选择：${detail.option}。` +
          '请据此调用 resolve_incident 继续处理，并用一句话说明结果；如果这个选择还需要补充信息，先问我。',
        { model, effort, maxContext },
      )
    }
    window.addEventListener('octopus:incident-choice', onIncidentChoice)
    return () => {
      window.removeEventListener('octopus:incident-choice', onIncidentChoice)
    }
  }, [sendMessage, model, effort, maxContext])

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

  // 运行窗（YAML / DAG）是栏内浮层：只有焦点栏响应（点击来源先聚焦该栏；
  // 顶栏「运行中 Agent」也落到焦点栏）。新建/打开任务的全局入口在 ChatTab 壳里。
  useEffect(() => {
    const onOpenWorkflow = (event: Event) => {
      if (!focusedRef.current) return
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

  // 作业详情「打开运行 →」：开作业坞同款运行窗（RunWindow：DAG + 日志 + YAML），
  // 与作业坞运行列表点进来的那条路径同一个模块窗，不另做只给 DAG 的弹层。
  useEffect(() => {
    const onOpenRunWindow = (event: Event) => {
      const detail = (event as CustomEvent<RunTarget>).detail
      if (!detail?.workspaceId || !detail?.executionId) return
      setTaskModuleRequest({ module: 'run', nonce: Date.now(), runTarget: detail })
    }
    window.addEventListener('octopus:open-run-window', onOpenRunWindow)
    return () => window.removeEventListener('octopus:open-run-window', onOpenRunWindow)
  }, [])

  // 项目绑定入口（2026-10-28 用户定稿：项目是任务维度资产）：
  //   · pending（任务未落盘）——作业坞尚不存在（无 workspaceId），留在 composer
  //     hero 第二行/停靠 ctrlbar；
  //   · 已落盘 —— 挪到作业坞「项目」图标（dockProject），composer 保持纯净。
  // workflow-dev 任务例外（2026-11-06 用户）：不绑定项目，需要时由 Agent 的
  // add_workspace_projects 工具按需引入仓库，不挂手动入口。
  const draftControls = (hero: boolean) =>
    pendingTaskSession?.kind === 'workflow-dev' ? undefined : (
      <TaskProjectChip
        hero={hero}
        org={pendingTaskSession?.org ?? preferredOrg}
        orgs={appOrgs}
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

  const dockProject = activeTask && activeTask.task_spec?.kind !== 'workflow-dev' ? (
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
  // 作战舱（classic-v3）：舱主对话的身份固定为汐音舰长、目录归左栏舱行承载，
  // 输入框下方不再重复目录名与可选身份。
  const mainLead = !taskThread && !cabinId && sessionId && workspaceLabel ? (
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
  // composer 居中、cwd/项目控件挪到第二行；已有实录或草稿已落盘追问时回落到
  // 停靠态。判定与 ChatArea 的 heroMode 对齐（空消息 + 非流式）。
  const heroActive = (draftScope ? !!pendingTaskSession : !sessionId)
    && !streaming && viewMessages.length === 0

  // 输入框控件条的「当前身份」贴纸（2026-10-30 用户定稿）：
  //   · 任务线程：身份由服务端按任务状态派生（草稿=作者 → 执行/验收=执行者 →
  //     终态=主 Agent），用户不能主动切身份 → 只读（锁形，无 ✕）；
  //   · 普通会话：显示当前分身身份，悬停 ✕ 清除回主身份；
  //   · hero 新会话：身份由下方单选选择器承担，不重复挂贴纸。
  const identityDisplay: ComposerIdentityDisplay | undefined = (() => {
    // 作战舱（classic-v3）：舱主对话只有一个身份 —— 汐音舰长，只读（不可切）。
    // 舱内打开的任务线程仍走下面按任务状态派生的只读身份。
    if (cabinId && !taskThread) {
      return {
        label: '汐音舰长',
        active: true,
        readOnly: true,
        title: '舱主对话身份固定为汐音舰长，不可切换',
      }
    }
    if (taskThread) {
      const status = activeTask?.status
      if (pendingTaskSession || status === 'draft') {
        return {
          label: workflowDraft ? '工作流开发者 · workflow-author' : '作者 · task-author',
          active: true,
          readOnly: true,
          title: '任务对话的身份由任务状态自动派生，不可手动切换',
        }
      }
      if (status === 'done' || status === 'aborted' || status === 'failed') {
        return { label: '主 Agent', active: false, readOnly: true, title: '任务已结束，对话回到主身份（只读）' }
      }
      return {
        label: workflowDraft ? '工作流开发者 · workflow-author' : '执行者 · task-doer',
        active: true,
        readOnly: true,
        title: '任务对话的身份由任务状态自动派生，不可手动切换',
      }
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
  // Task threads are excluded from the session list (one task = one main thread,
  // reached via the task row), so `activeSession` is undefined there — fall back
  // to the task's workspace. Without it the chat never subscribes to
  // `session_updated`, and server-appended cards (run / completion / acceptance
  // failure) only appear after F5 (2026-11-02 user bug).
  const activeWorkspaceId = activeTask?.workspace_id ?? activeSession?.workspace_id ?? null
  useEffect(() => {
    if (!activeWorkspaceId || !sessionId) return
    const off = subscribeSSE(
      `${getServerUrl()}/api/workspaces/${activeWorkspaceId}/events`,
      'session_updated',
      (event) => {
        try {
          const data = JSON.parse(event.data) as { sessionId?: string; wake?: boolean; phase?: string }
          if (data.sessionId !== sessionId) return
          if (data.wake && data.phase === 'started') {
            void checkAndResume(sessionId)
          } else {
            void loadMessages()
          }
          void refreshSessions()
        } catch {
          /* malformed frame — ignore */
        }
      },
    )
    return off
  }, [activeWorkspaceId, sessionId, checkAndResume, loadMessages, refreshSessions])

  // ── 壳 → 栏的指令（选择会话 / 任务、新建）──────────────────────────
  // 侧栏与顶栏只跟「壳」打交道；壳不持有栏内的 handler，用 nonce 指令下发。
  const lastCommandRef = useRef(0)
  useEffect(() => {
    if (!command || command.nonce === lastCommandRef.current) return
    lastCommandRef.current = command.nonce
    if (command.type === 'select-session') handleSelectSession(command.sessionId)
    else if (command.type === 'select-task') {
      handleSelectTask(command.task, command.module ? { module: command.module } : undefined)
    } else if (command.type === 'rename-task') openTaskRename(command.task)
    else if (command.type === 'delete-task') setDeleteTarget(command.task)
    else if (command.type === 'new-session') handleCreateSession()
    else if (command.type === 'new-task') void handleCreateTask(command.kind)
    // handlers are recreated per render; nonce guard keeps this one-shot.
  }, [command, handleCreateTask, handleSelectTask, handleSelectSession, handleCreateSession, openTaskRename])

  // 右栏空态：先给「选一个会话」的选择器，而不是直接开一页新对话。
  const [pickerBypassed, setPickerBypassed] = useState(false)
  const showPicker = secondary && !pickerBypassed && !sessionId && !pendingTaskSession && !activeTask
  const startNewFromPicker = () => {
    setPickerBypassed(true)
    handleCreateSession()
  }

  const paneRunning = streaming || (!!sessionId && runningAgents.some((agent) => agent.id === sessionId))
  const paneTitle = activeTask?.name ?? activeSession?.title ?? pendingTaskSession?.title
    ?? (showPicker ? '选择一个会话' : '新对话')
  // 工作区名与标题同名时不重复显示（任务线程两者常常就是同一个名字）。
  const paneWorkspace = explorerWorkspaceId && explorerWorkspaceName && explorerWorkspaceName !== paneTitle
    ? explorerWorkspaceName
    : ''

  return (
    <div
      data-chat-pane={pane}
      data-focused={focused ? 'true' : undefined}
      onPointerDownCapture={onFocus}
      className={cn(
        'relative flex min-w-0 flex-1 flex-col',
        split && 'overflow-hidden bg-pop-bg',
        split && !focused && 'opacity-[0.985]',
      )}
    >
      {/* 分屏标 / 焦点 + 栏操作：只占 34px 顶带，不挤压转录 */}
      {split && (
        <>
          <div
            data-testid={`pane-chip-${pane}`}
            title={`${paneTitle}${paneWorkspace ? ` · ${paneWorkspace}` : ''}`}
            className={cn(
              'absolute left-2.5 top-2 z-30 flex h-[26px] max-w-[calc(100%_-_130px)] items-center gap-1.5 rounded-full border bg-pop-paper/85 px-2.5 text-[11px] shadow-pop-sm backdrop-blur-xl transition-colors',
              focused
                ? 'border-white/[0.16] text-pop-ink'
                : 'border-white/[0.08] text-pop-dim',
            )}
          >
            <span
              className={cn(
                'grid size-4 shrink-0 place-items-center rounded-[4px] border font-mono text-[9px] font-semibold leading-none',
                focused
                  ? 'border-pop-yellow/50 bg-pop-yellow/[0.14] text-pop-yellow'
                  : 'border-white/[0.10] text-pop-dim',
              )}
            >
              {pane === 'left' ? 'L' : 'R'}
            </span>
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                paneRunning ? 'bg-pop-green shadow-[0_0_6px_var(--pop-green)]' : sessionId ? 'bg-pop-dim' : 'bg-pop-dim/40',
              )}
            />
            <span className="min-w-0 flex-1 truncate font-medium">{paneTitle}</span>
            {paneWorkspace && (
              <span className="shrink-0 border-l border-white/[0.08] pl-1.5 font-mono text-[9.5px] text-pop-dim/60">
                {paneWorkspace}
              </span>
            )}
          </div>
          <div className="absolute right-2.5 top-2 z-30 flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-pop-paper/85 p-0.5 shadow-pop-sm backdrop-blur-xl">
            {canSwap && pane === 'left' && (
              <button
                type="button"
                aria-label="交换左右两栏"
                title="交换左右两栏"
                onClick={onSwapPanes}
                className="grid size-5 place-items-center rounded text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
              >
                <SwapGlyph />
              </button>
            )}
            <button
              type="button"
              aria-label="退出分屏（保留当前焦点栏）"
              title="退出分屏（保留当前焦点栏）"
              onClick={onExitSplit}
              className="grid size-5 place-items-center rounded text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-red"
            >
              <span className="text-[13px] leading-none">×</span>
            </button>
          </div>
        </>
      )}

      <button
        type="button"
        aria-label="打开会话列表"
        title="打开会话列表"
        onClick={onOpenSidebar}
        className="absolute left-3 top-2.5 z-30 grid size-7 place-items-center rounded-md border border-white/10 bg-pop-paper/80 text-pop-dim backdrop-blur transition-colors hover:text-pop-ink md:hidden"
      >
        <Menu className="size-3.5" />
      </button>

      <div className={cn('flex min-h-0 flex-1 flex-col', split && 'pt-[34px]')}>
        {/* 顶部状态条已移除（2026-10-28 用户定稿）：状态/身份/工作区信息
            由侧栏任务行与作业坞承载，对话区保持纯净转录。 */}
        {showPicker ? (
          <ChatPanePicker
            sessions={sessions}
            loading={sessionsLoading}
            runningAgents={runningAgents}
            occupiedId={otherSessionId}
            occupiedMark={pane === 'right' ? 'L' : 'R'}
            onPick={onOpenSession}
            onNew={startNewFromPicker}
          />
        ) : (
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
            backgroundTasks={backgroundTasks}
            commands={slashCommandList}
            onSend={handleSendMessage}
            onStop={stopGenerate}
            onConfirm={handleConfirm}
            hasSession={!!sessionId}
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
            emptyStateTitle={draftScope ? (workflowDraft ? '描述要开发的工作流' : '描述要开发的任务') : undefined}
            emptyStateDescription={draftScope
              ? (workflowDraft
                ? '第一句话会成为工作流开发任务的标题；后续对话用于澄清需求、确认设计并生成可运行的 YAML。'
                : '第一句话会成为任务草稿的标题，后续对话用于澄清与拆分 Phase。')
              : undefined}
            composerLeading={draftScope && !heroActive ? draftLead : mainLead}
            composerPlaceholder={draftScope
              ? (workflowDraft
                ? '描述要开发或修改的工作流…　⏎ 发送'
                : '描述要开发的任务…　⏎ 发送')
              : cabinId && !taskThread
                // classic-v3：舱主对话固定问汐音舰长（不再露出「主 Agent」）。
                ? '问汐音舰长…　⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行'
                : '问主 Agent…　⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行'}
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
            identity={!taskThread && !cabinId ? (
              sessionId
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
            dockGutter={split}
          />
        )}
      </div>

      {/* One main chat for every task state. Task modules float over the whole
          chat region (portaled to ChatTab's region) so split-mode windows can
          cross the divider; z-order follows the focused pane.
          2026-10-31 消耗窗通用化：这一层在没有任务时也挂载，只承载会话账本。 */}
      {layerRoot && createPortal(
        <TaskModulesLayer
          task={activeTask}
          sessionId={activeTask ? null : sessionId}
          chatSessionId={sessionId}
          debugRefreshKey={`${messages.length}:${streaming ? '1' : '0'}`}
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
            void refreshSessions()
          }}
          openModule={taskModuleRequest}
          onOpenLinkedTask={openLinkedTask}
          onOpenYaml={setYamlTarget}
          className={focused ? 'z-[61]' : 'z-[60]'}
        />,
        layerRoot,
      )}

      <WorkspaceExplorerDock
        workspaceId={explorerWorkspaceId}
        workspaceName={explorerWorkspaceName}
        task={activeTask}
        taskProject={dockProject}
        cabinModules={dockCabinModules}
        cabinMoreModules={dockCabinMoreModules}
        elevated={dockElevated}
        taskWindows={activeTask ? (taskWindows[activeTask.id] ?? {}) : {}}
        usageWindow={activeTask ? (taskWindows[activeTask.id]?.usage ?? null) : (sessionUsageWindows.usage ?? null)}
        onOpenUsage={() => setTaskModuleRequest({ module: 'usage', nonce: Date.now() })}
        debugWindow={activeTask ? (taskWindows[activeTask.id]?.debug ?? null) : (sessionUsageWindows.debug ?? null)}
        onOpenDebug={() => setTaskModuleRequest({ module: 'debug', nonce: Date.now() })}
        debugSessionId={sessionId}
        debugRefreshKey={`${messages.length}:${streaming ? '1' : '0'}`}
        subagentSessionId={sessionId}
        subagentWindow={activeTask ? (taskWindows[activeTask.id]?.subagents ?? null) : (sessionUsageWindows.subagents ?? null)}
        onOpenSubagent={(run) => {
          setTaskModuleRequest({
            module: 'subagents',
            nonce: Date.now(),
            subagentTarget: {
              id: run.id,
              title: run.description ?? run.agent_type ?? run.id,
            },
          })
        }}
        onOpenTaskModule={(module) => setTaskModuleRequest({ module, nonce: Date.now() })}
        onOpenRun={(run) => {
          // 作业坞运行列表 → 指定执行（可能是验收规划这种 task_id=NULL 的系统运行）。
          setTaskModuleRequest({
            module: 'run',
            nonce: Date.now(),
            runTarget: {
              executionId: run.id,
              workspaceId: run.workspaceId,
              title: runTitle(run),
              workflowRef: run.workflowRef,
              phaseIndex: run.phaseIndex,
              roundIndex: run.roundIndex,
              status: run.status,
              system: run.isSystem,
            },
          })
        }}
        onOpenYaml={(run) => {
          // 行尾 </> —— 不切走运行窗，直接看这次执行的 YAML 快照。
          setYamlTarget({
            workspaceId: run.workspaceId,
            executionId: run.id,
            workflowRef: run.workflowRef,
            title: runTitle(run),
            phaseIndex: run.phaseIndex,
            roundIndex: run.roundIndex,
            status: run.status,
            from: 'dock',
          })
        }}
        onTaskAction={(action) => { if (activeTask) void executeTaskAction(activeTask.id, action) }}
        activity={activitySnapshot}
        sidebarWidth={sidebarWidth}
        compact={split}
      />

      {yamlTarget && (
        <WorkflowYamlWindow target={yamlTarget} onClose={() => setYamlTarget(null)} />
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
          void refreshSessions()
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

function SwapGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 5h9l-2.2-2.2" />
      <path d="M13 11H4l2.2 2.2" />
    </svg>
  )
}
