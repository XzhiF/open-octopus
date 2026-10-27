'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Menu, PanelLeft, Search, SquarePen } from 'lucide-react'
import { toast } from 'sonner'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useAgentChat, type UseAgentChatApiOverride, type ChatSubagentRef } from '@/hooks/useAgentChat'
import { useSessionUsage } from '@/hooks/useSessionUsage'
import { useComposerSettings } from '@/hooks/useComposerSettings'
import { useKcFeed } from '@/hooks/use-kc-feed'
import { useChatTasks } from '@/hooks/use-chat-tasks'
import { useRunningAgents } from '@/hooks/use-running-agents'
import { useOrgs } from '@/hooks/useOrgs'
import * as agentApi from '@/lib/agent/api'
import { ChatSidebar } from './chat-sidebar'
import { ExpertIdentityChip } from './expert-identity-chip'
import { CwdPicker, type CwdChoice } from './cwd-picker'
import { TaskWorkbench } from '@/components/chat-workbench/task-workbench'
import { TaskModulesLayer } from '@/components/chat-workbench/task-modules-layer'
import type { TaskModule } from '@/components/chat-workbench/task-window-types'
import { TaskProjectChip } from '@/components/chat-workbench/task-project-chip'
import { WorkspaceExplorerDock } from '@/components/workspace/workspace-explorer-dock'
import { useActivitySnapshot } from '@/components/chat-workbench/inspector-activity'
import { WorkflowWindow } from '@/components/chat-workbench/workflow-window'
import type { TaskWindowMap } from '@/components/chat-workbench/task-window-types'
import { createTask, getTask, readyTask, TaskReadyGateError, updateTask, deleteTask, abortTask, type TaskView } from '@/lib/tasks-api'
import { subscribeSSE } from '@/lib/sse-manager'
import { getServerUrl } from '@/lib/server-config'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/agent/shared/ConfirmDialog'
import { ChatArea } from './ChatArea'
import { ToolCallPanel } from './ToolCallPanel'
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

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))
}

interface PendingTaskSession {
  sessionId: string
  org: string
  title: string
  projectIds: string[]
}

/** Chat-created tasks start unnamed; the task-author autosave adopts the
 *  smart session title after the first turn (same as a main-agent session). */
const NEW_TASK_NAME = '新任务'

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
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  const [taskWindows, setTaskWindows] = useState<Record<string, TaskWindowMap>>({})
  const [renameTarget, setRenameTarget] = useState<TaskView | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [taskBusy, setTaskBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TaskView | null>(null)
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
  // The agent session's org may be the server default; tasks belong to the
  // user's working org (same source the task board/template used).
  const preferredOrg = appOrgs[0]?.name ?? 'default'

  /** Draft authoring + a not-yet-created task both run on the task-author clone. */
  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const authoring =
    pendingTaskSession !== null ||
    activeTask?.status === 'draft' ||
    activeSession?.clone_name === 'task-author'
  const showWorkbench = !!activeTask && activeTask.status !== 'draft'

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

  const mainChatApi = useMemo<UseAgentChatApiOverride>(() => ({
    checkRunning: agentApi.getSessionRunning,
  }), [])

  /** Task-author sessions live under /api/clones/task-author — the same
   *  unified chat surface, different persona endpoint. */
  const taskAuthorApi = useMemo<UseAgentChatApiOverride>(() => ({
    getSession: (id, query) => agentApi.getCloneSession('task-author', id, query),
    chatStream: (id, message, opts) =>
      agentApi.cloneChatStream('task-author', id, message, opts),
    stopChat: (id) => agentApi.stopCloneChat('task-author', id),
    checkRunning: (id) => agentApi.getCloneSessionRunning('task-author', id),
  }), [])

  const {
    messages, streaming, streamContent, streamThinking, streamTimeline, isThinking, toolCalls, pendingConfirm,
    error: chatError, statusMessage, contextUsage,
    sendMessage, stopGenerate, handleConfirm, loadMessages,
    steer, steeringRef, resumeStreaming, checkAndResume,
  } = useAgentChat(activeSessionId, {
    onTitleUpdate: handleTitleUpdate,
    api: authoring ? taskAuthorApi : mainChatApi,
  })
  const sessionUsage = useSessionUsage(activeSessionId, streaming)
  // Switching sessions aborts the local SSE, but task-author turns keep
  // generating server-side. Keep the badge for a short grace window while the
  // 2s running poll catches up.
  const lastStreamingAtRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    if (streaming && activeSessionId) {
      lastStreamingAtRef.current.set(activeSessionId, Date.now())
    }
  }, [streaming, activeSessionId, runningAgents])
  const runningSessionIds = useMemo(() => {
    const ids = new Set(runningAgents.map((agent) => agent.id))
    if (streaming && activeSessionId) ids.add(activeSessionId)
    const now = Date.now()
    for (const [id, at] of lastStreamingAtRef.current) {
      if (now - at < 6_000) ids.add(id)
    }
    return ids
  }, [runningAgents, streaming, activeSessionId])

  // The task-author autosave renames the draft at turn-end (and the LLM title
  // refinement may land shortly after). Refresh the task list on stream end so
  // the task row adopts the smart title without waiting for the 30s poll.
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      wasStreamingRef.current = false
      void refreshChatTasks()
      const timer = window.setTimeout(() => void refreshChatTasks(), 1_800)
      return () => window.clearTimeout(timer)
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

  const { viewMessages, laneAByMsgId, laneAIds, laneAIngestById } = useMemo(() => {
    const byMsgId = new Map<string, KcCardEvent[]>()
    const ids = new Set<string>()
    const ingestById = new Map<string, KcCardEvent>()
    const vm = messages.map((m): AgentMessage => {
      if (!m.content || !m.content.includes('kc-card')) return m
      const { events, rest } = parseKcCardBlocks(m.content)
      if (events.length === 0) return m
      byMsgId.set(m.id, events)
      for (const e of events) {
        ids.add(e.id)
        if (e.kind === 'ingest') ingestById.set(e.id, e)
      }
      return { ...m, content: rest }
    })
    return { viewMessages: vm, laneAByMsgId: byMsgId, laneAIds: ids, laneAIngestById: ingestById }
  }, [messages])

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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  // Pending message when auto-creating a session (carries + panel clone consult)
  const pendingMessageRef = useRef<{ message: string; subagents?: ChatSubagentRef[] } | null>(null)

  useEffect(() => {
    if (!activeSessionId) return
    // New session with pending message — server has 0 messages, skip load
    // to avoid wiping the optimistically-added user message
    if (pendingMessageRef.current) return
    // Always reload on switch: the hook resets the transcript, and the API
    // route (main vs task-author clone) is selected per session.
    loadMessages()
  }, [activeSessionId, loadMessages])

  // When a session is created and there's a pending message, send it
  useEffect(() => {
    if (activeSessionId && pendingMessageRef.current) {
      const pending = pendingMessageRef.current
      pendingMessageRef.current = null
      // Small delay to ensure useAgentChat has updated with new sessionId
      requestAnimationFrame(() => sendMessage(pending.message, {
        model, effort, maxContext, subagents: pending.subagents,
      }))
    }
  }, [activeSessionId, sendMessage, model, effort, maxContext])

  const handleSendMessage = useCallback((message: string, opts?: { subagents?: ChatSubagentRef[] }) => {
    if (!pendingTaskSession) {
      if (activeSessionId) {
        sendMessage(message, { model, effort, maxContext, subagents: opts?.subagents })
      } else {
        // First prompt creates the session (lazy). cwd/workspace is chosen here,
        // not when the empty "+" tab was opened.
        pendingMessageRef.current = { message, subagents: opts?.subagents }
        const cwdOpts = mainCwd.kind === 'default'
          ? undefined
          : { workspace_id: mainCwd.workspaceId, cwd: mainCwd.path }
        createNewSession(cwdOpts)
      }
      return
    }

    // First message of a task session: create the clone session + draft from it,
    // then hand the same message to the unified composer.
    if (creatingTask) return
    const session = pendingTaskSession
    setCreatingTask(true)
    void (async () => {
      try {
        let sid = session.sessionId
        if (!sid) {
          const created = await agentApi.createCloneSession('task-author')
          sid = created.id
        }
        const task = await createTask({
          org: session.org || 'default',
          name: NEW_TASK_NAME,
          source_chat_session_id: sid,
          task_spec: { format: 'v4' },
          project_ids: session.projectIds,
          ...(taskCwd.kind === 'default'
            ? {}
            : { workspace_id: taskCwd.workspaceId, cwd: taskCwd.path }),
        })
        setPendingTaskSession(null)
        setActiveTask(task)
        void refreshChatTasks()
        void refetchSessions()
        pendingMessageRef.current = { message, subagents: opts?.subagents }
        setActiveSessionId(sid)
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : '创建任务失败')
      } finally {
        setCreatingTask(false)
      }
    })()
  }, [
    pendingTaskSession, creatingTask, activeSessionId, sendMessage, createNewSession,
    model, effort, maxContext, refreshChatTasks, refetchSessions, mainCwd, taskCwd,
  ])

  const handleSelectSession = (id: string) => {
    setActiveTask(null)
    setPendingTaskSession(null)
    setTaskModuleRequest(null)
    setActiveSessionId(id)
    setMobileSidebarOpen(false)
  }

  const handleSelectTask = useCallback((task: TaskView, opts?: { module?: TaskModule }) => {
    setMobileSidebarOpen(false)
    setTaskModuleRequest(opts?.module ? { module: opts.module, nonce: Date.now() } : null)
    if (task.status === 'draft') {
      if (!task.source_chat_session_id) {
        toast.error('该草稿没有关联的任务会话')
        return
      }
      setPendingTaskSession(null)
      setActiveTask(task)
      setActiveSessionId(task.source_chat_session_id)
      return
    }
    setPendingTaskSession(null)
    setActiveTask(task)
  }, [setActiveSessionId])

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
    setActiveTask(null)
    setPendingTaskSession(null)
    setTaskModuleRequest(null)
    setMobileSidebarOpen(false)
    // Lazy: the DB session is created on the first prompt, after cwd selection.
    setActiveSessionId(null)
    setMainCwd({ kind: 'default', label: 'Main Agent 工作区' })
  }

  const handleCreateTask = useCallback(async () => {
    if (creatingTask) return
    setActiveTask(null)
    setPendingTaskSession({
      sessionId: '',
      org: preferredOrg,
      title: NEW_TASK_NAME,
      projectIds: [],
    })
    setActiveSessionId(null)
    setTaskCwd({ kind: 'default', label: '新建工作空间' })
    setTaskModuleRequest(null)
    setMobileSidebarOpen(false)
  }, [creatingTask, preferredOrg])

  const handleEnqueueTask = useCallback(async (task: TaskView) => {
    if (enqueueBusy) return
    setEnqueueBusy(true)
    try {
      await readyTask(task.id)
      toast.success('已入队 · 在任务看板触发执行')
      await refreshChatTasks()
      void refetchSessions()
    } catch (err: unknown) {
      if (err instanceof TaskReadyGateError) {
        toast.error(`入队被拒：缺少 ${err.missing.join('、')}`)
        setTaskModuleRequest({ module: 'plan', nonce: Date.now() })
      } else {
        toast.error(err instanceof Error ? err.message : '入队失败')
      }
    } finally {
      setEnqueueBusy(false)
    }
  }, [enqueueBusy, refreshChatTasks, refetchSessions])

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

  const authoringLead = authoring ? (
    <span className="flex items-center gap-1.5">
      <CwdPicker
        mode="task"
        org={pendingTaskSession?.org ?? activeTask?.org ?? preferredOrg}
        value={taskCwd}
        onChange={setTaskCwd}
        disabled={!!activeTask}
      />
      <TaskProjectChip
        org={pendingTaskSession?.org ?? activeTask?.org ?? preferredOrg}
        projectIds={pendingTaskSession?.projectIds ?? activeTask?.project_ids ?? []}
        taskId={pendingTaskSession ? undefined : activeTask?.id}
        onSaved={(ids, updated) => {
          if (pendingTaskSession) {
            setPendingTaskSession({ ...pendingTaskSession, projectIds: ids })
          }
          if (updated) {
            setActiveTask(updated)
            void refreshChatTasks()
          }
        }}
      />
      <span aria-hidden className="h-3 w-px bg-white/10" />
      <span className="flex h-[22px] items-center gap-1 rounded-[7px] px-1.5 text-[10.5px] text-pop-purple">
        <span className="size-1.5 rounded-full bg-pop-purple" />
        task-author
      </span>
      {activeSessionId && (
        <>
          <span aria-hidden className="h-3 w-px bg-white/10" />
          <ExpertIdentityChip kind="clone" cloneName="task-author" sessionId={activeSessionId} />
        </>
      )}
    </span>
  ) : undefined

  const mainLead = !authoring && activeSessionId ? (
    <span className="flex items-center gap-1.5">
      <CwdPicker mode="main" org={preferredOrg} value={mainCwd} onChange={setMainCwd} disabled />
      <ExpertIdentityChip kind="agent" sessionId={activeSessionId} />
    </span>
  ) : !authoring ? (
    <CwdPicker mode="main" org={preferredOrg} value={mainCwd} onChange={setMainCwd} />
  ) : undefined

  const explorerWorkspaceId =
    activeTask?.workspace_id ??
    activeSession?.workspace_id ??
    (authoring ? taskCwd.workspaceId : mainCwd.workspaceId) ??
    null
  const explorerWorkspaceName =
    activeTask?.name ?? activeSession?.title ?? (authoring ? taskCwd.label : mainCwd.label)
  const activitySnapshot = useActivitySnapshot(explorerWorkspaceId, chatTasks, runningAgents, toolCalls)

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
        <div className={cn('flex min-h-0 flex-1 flex-col', showWorkbench && 'hidden')}>
          <ChatArea
            messages={viewMessages}
            streaming={streaming}
            streamContent={streamContent}
            streamThinking={streamThinking}
            streamTimeline={streamTimeline}
            isThinking={isThinking}
            toolCalls={toolCalls}
            pendingConfirm={pendingConfirm}
            error={chatError}
            statusMessage={statusMessage}
            onSend={handleSendMessage}
            onStop={stopGenerate}
            onConfirm={handleConfirm}
            hasSession={!!activeSessionId}
            contextUsage={contextUsage}
            sessionUsage={sessionUsage}
            currentModel={model}
            onModelChange={setModel}
            effort={effort}
            onEffortChange={setEffort}
            maxContext={maxContext}
            onMaxContextChange={setMaxContext}
            modelPresets={modelPresets}
            showUsagePlaceholders
            showComposerAttach={!authoring}
            tui
            onSteer={(message, opts) => void steer(message, {
              model, effort, maxContext, subagents: opts?.subagents,
            })}
            steerActiveRef={steeringRef}
            resumeTailing={resumeStreaming}
            emptyStateTitle={authoring ? '描述要开发的任务' : undefined}
            emptyStateDescription={authoring ? '第一句话会成为任务草稿的标题，后续对话用于澄清与拆分 Phase。' : undefined}
            composerLeading={authoring ? authoringLead : mainLead}
            composerPlaceholder={authoring ? '描述要开发的任务…　⏎ 发送' : '问主 Agent…　⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行'}
            composerSeed={composerSeed}
            messageExtras={extras}
            transcriptTail={tail}
            timelineClearDock={!!explorerWorkspaceId}
          />
        </div>

        {/* Draft keeps the authoring chat in the center; the same floating
            dock/windows surface as running tasks lives on top of it. */}
        {activeTask && !showWorkbench && (
          <TaskModulesLayer
            task={activeTask}
            windows={taskWindows[activeTask.id] ?? {}}
            onWindowsChange={(next) =>
              setTaskWindows((prev) => ({ ...prev, [activeTask.id]: next }))
            }
            onMutated={() => {
              void refreshChatTasks()
              void refetchSessions()
            }}
            openModule={taskModuleRequest}
          />
        )}

        {showWorkbench && activeTask && (
          <TaskWorkbench
            task={activeTask}
            windows={taskWindows[activeTask.id] ?? {}}
            onMutated={() => {
              void refreshChatTasks()
              void refetchSessions()
            }}
            onWindowsChange={(next) =>
              setTaskWindows((prev) => ({ ...prev, [activeTask.id]: next }))
            }
            openModule={taskModuleRequest}
          />
        )}
      </div>

      <WorkspaceExplorerDock
        workspaceId={explorerWorkspaceId}
        workspaceName={explorerWorkspaceName}
        task={activeTask}
        taskWindows={activeTask ? (taskWindows[activeTask.id] ?? {}) : {}}
        onOpenTaskModule={(module) => setTaskModuleRequest({ module, nonce: Date.now() })}
        onEnqueue={activeTask ? () => void handleEnqueueTask(activeTask) : undefined}
        enqueueBusy={enqueueBusy}
        activity={activitySnapshot}
        sidebarWidth={sidebarCollapsed ? 0 : sidebarWidth}
      />

        {/* Tool call panel */}
        {!showWorkbench && showToolPanel && toolCalls.length > 0 && (
          <aside className="hidden w-80 border-l border-agent-divider bg-agent-surface-raised lg:block">
            <ToolCallPanel
              toolCalls={toolCalls}
              onClose={() => setShowToolPanel(false)}
            />
          </aside>
        )}

        {/* Tool panel toggle */}
      {!showWorkbench && toolCalls.length > 0 && !showToolPanel && (
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
