'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Menu, PanelsTopLeft } from 'lucide-react'
import { toast } from 'sonner'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useAgentChat, type UseAgentChatApiOverride } from '@/hooks/useAgentChat'
import { useSessionUsage } from '@/hooks/useSessionUsage'
import { useComposerSettings } from '@/hooks/useComposerSettings'
import { useKcFeed } from '@/hooks/use-kc-feed'
import { useChatTasks } from '@/hooks/use-chat-tasks'
import { useRunningAgents } from '@/hooks/use-running-agents'
import { useOrgs } from '@/hooks/useOrgs'
import * as agentApi from '@/lib/agent/api'
import { ChatSidebar } from './chat-sidebar'
import { TaskWorkbench } from '@/components/chat-workbench/task-workbench'
import { TaskOverview } from '@/components/chat-workbench/task-overview'
import { TaskProjectChip } from '@/components/chat-workbench/task-project-chip'
import { TaskModal } from '@/components/tasks/task-modal'
import type { TaskWindowMap } from '@/components/chat-workbench/task-window-types'
import { createTask, getTask, type TaskView } from '@/lib/tasks-api'
import { cn } from '@/lib/utils'
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
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [acceptTask, setAcceptTask] = useState<TaskView | null>(null)
  const [taskWindows, setTaskWindows] = useState<Record<string, TaskWindowMap>>({})
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

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      /* storage unavailable */
    }
  }, [sidebarWidth])

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
    steer, steeringRef, resumeStreaming,
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

  // Pending message when auto-creating a session (carries + panel expert delegation)
  const pendingMessageRef = useRef<{ message: string; delegate_to?: string } | null>(null)

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
        model, effort, maxContext, delegate_to: pending.delegate_to,
      }))
    }
  }, [activeSessionId, sendMessage, model, effort, maxContext])

  const handleSendMessage = useCallback((message: string, opts?: { delegate_to?: string }) => {
    if (!pendingTaskSession) {
      if (activeSessionId) {
        sendMessage(message, { model, effort, maxContext, delegate_to: opts?.delegate_to })
      } else {
        // No session — auto-create one, then send message
        pendingMessageRef.current = { message, delegate_to: opts?.delegate_to }
        createNewSession()
      }
      return
    }

    // First message of a task session: the draft is created from it, then the
    // same unified composer sends the turn to task-author.
    if (creatingTask) return
    const session = pendingTaskSession
    setCreatingTask(true)
    void (async () => {
      try {
        const task = await createTask({
          org: session.org || 'default',
          name: NEW_TASK_NAME,
          source_chat_session_id: session.sessionId,
          task_spec: { format: 'v4' },
          project_ids: session.projectIds,
        })
        setPendingTaskSession(null)
        setActiveTask(task)
        void refreshChatTasks()
        void refetchSessions()
        sendMessage(message, { model, effort, maxContext, delegate_to: opts?.delegate_to })
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : '创建任务失败')
      } finally {
        setCreatingTask(false)
      }
    })()
  }, [
    pendingTaskSession, creatingTask, activeSessionId, sendMessage, createNewSession,
    model, effort, maxContext, refreshChatTasks, refetchSessions,
  ])

  const handleSelectSession = (id: string) => {
    setActiveTask(null)
    setPendingTaskSession(null)
    setOverviewOpen(false)
    setAcceptTask(null)
    setActiveSessionId(id)
    setMobileSidebarOpen(false)
  }

  const handleSelectTask = useCallback((task: TaskView) => {
    setMobileSidebarOpen(false)
    setOverviewOpen(false)
    setAcceptTask(null)
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

  const handleCreateSession = () => {
    setActiveTask(null)
    setPendingTaskSession(null)
    setOverviewOpen(false)
    setAcceptTask(null)
    setMobileSidebarOpen(false)
    createNewSession()
  }

  const handleCreateTask = useCallback(async () => {
    if (creatingTask) return
    setCreatingTask(true)
    setActiveTask(null)
    setPendingTaskSession(null)
    setOverviewOpen(false)
    setAcceptTask(null)
    setMobileSidebarOpen(false)
    try {
      const session = await agentApi.createCloneSession('task-author')
      setPendingTaskSession({
        sessionId: session.id,
        org: preferredOrg,
        title: NEW_TASK_NAME,
        projectIds: [],
      })
      setActiveSessionId(session.id)
      void refetchSessions()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '创建任务会话失败')
    } finally {
      setCreatingTask(false)
    }
  }, [creatingTask, refetchSessions, setActiveSessionId, preferredOrg])

  // Cross-app entry points: the tasks board's [+新建任务] and draft cards
  // open the unified chat instead of the legacy authoring modal.
  useEffect(() => {
    const onNewTask = () => { void handleCreateTask() }
    const onOpenTask = (event: Event) => {
      const taskId = (event as CustomEvent<{ taskId?: string }>).detail?.taskId
      if (!taskId) return
      getTask(taskId)
        .then((task) => handleSelectTask(task))
        .catch(() => toast.error('任务不存在或已被删除'))
    }
    window.addEventListener('octopus:new-task', onNewTask)
    window.addEventListener('octopus:open-task', onOpenTask)
    return () => {
      window.removeEventListener('octopus:new-task', onNewTask)
      window.removeEventListener('octopus:open-task', onOpenTask)
    }
  }, [handleCreateTask, handleSelectTask])

  const sidebarTasks = useMemo(() => {
    if (activeTask?.status === 'draft' && !chatTasks.some((task) => task.id === activeTask.id)) {
      return [activeTask, ...chatTasks]
    }
    return chatTasks
  }, [chatTasks, activeTask])

  const authoringLead = authoring ? (
    <span className="flex items-center gap-1.5">
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
    </span>
  ) : undefined

  return (
    <div className={cn('ui-font relative flex h-full min-h-0', resizingSidebar && 'cursor-col-resize select-none [&_*]:cursor-col-resize')}>
      <h1 className="sr-only">对话</h1>
      {/* Desktop sidebar */}
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
        {activeTask && (
          <button
            type="button"
            aria-label="任务概览"
            title="任务概览"
            data-testid="task-overview-trigger"
            onClick={() => setOverviewOpen(true)}
            className="absolute right-3 top-2.5 z-30 grid size-7 place-items-center rounded-md border border-white/10 bg-pop-paper/80 text-pop-dim backdrop-blur transition-colors hover:text-pop-ink"
          >
            <PanelsTopLeft className="size-3.5" />
          </button>
        )}
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
              model, effort, maxContext, delegate_to: opts?.delegate_to,
            })}
            steerActiveRef={steeringRef}
            resumeTailing={resumeStreaming}
            emptyStateTitle={authoring ? '描述要开发的任务' : undefined}
            emptyStateDescription={authoring ? '第一句话会成为任务草稿的标题，后续对话用于澄清与拆分 Phase。' : undefined}
            composerLeading={authoringLead}
            composerPlaceholder={authoring ? '描述要开发的任务…　⏎ 发送' : '问主 Agent…　⏎ 发送 · ⇧⏎ 排队 · Alt⏎ 换行'}
            composerSeed={composerSeed}
            messageExtras={extras}
            transcriptTail={tail}
          />
        </div>

        {showWorkbench && activeTask && (
          <TaskWorkbench
            task={activeTask}
            windows={taskWindows[activeTask.id] ?? {}}
            onWindowsChange={(next) =>
              setTaskWindows((prev) => ({ ...prev, [activeTask.id]: next }))
            }
          />
        )}
      </div>

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

      {activeTask && overviewOpen && (
        <TaskOverview
          task={activeTask}
          onClose={() => setOverviewOpen(false)}
          onOpenAcceptance={(task) => {
            setOverviewOpen(false)
            setAcceptTask(task)
          }}
        />
      )}

      {acceptTask && (
        <TaskModal
          open
          onOpenChange={(open) => {
            if (!open) setAcceptTask(null)
          }}
          task={acceptTask}
          startOnAcceptance
          onMutated={() => {
            void refreshChatTasks()
            void refetchSessions()
          }}
        />
      )}
    </div>
  )
}
