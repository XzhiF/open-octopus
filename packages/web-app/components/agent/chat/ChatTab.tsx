'use client'

// 对话分屏壳（2026-11-08）：
//   · 侧栏（会话 + 任务）两栏共享，只渲染一次；
//   · 左侧一栏 + 可选的右侧一栏（只支持左右两栏、只叠一层）；
//   · 作业坞跟着每栏走（左栏的坞正好落在分屏线上）；
//   · 任务模块窗提升到「整个聊天区」这一层（portal），可以跨过分屏线；
//   · 弹窗仍是 Radix dialog（body portal），天然覆盖两栏。
//
// 每栏自己的会话/任务/窗口状态在 ChatPane 里；这里只持有「哪栏开了什么」，
// 供侧栏打 L/R 标记与焦点高亮。

import {
  useState, useEffect, useCallback, useMemo, useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { PanelLeft, Search, SquarePen } from 'lucide-react'
import { toast } from 'sonner'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useChatTasks } from '@/hooks/use-chat-tasks'
import { useRunningAgents } from '@/hooks/use-running-agents'
import { useOrgs } from '@/hooks/useOrgs'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useViewport } from '@/hooks/use-viewport'
import { getTask, type TaskView } from '@/lib/tasks-api'
import { readLastChatContext, writeLastChatContext } from '@/lib/last-chat-context'
import { readRememberedTaskOrg, resolveTaskOrg } from '@/lib/task-org'
import type { TaskModule } from '@/components/chat-workbench/task-window-types'
import {
  CHAT_SPLIT_DEFAULT_RATIO,
  CHAT_SPLIT_DIVIDER_WIDTH,
  CHAT_SPLIT_MIN_PANE_WIDTH,
  readChatSplitPrefs,
  setChatSplitEnabled,
  type ChatSplitPrefs,
  useChatSplitEnabled,
  writeChatSplitPrefs,
  type ChatPaneId,
} from '@/lib/chat-split'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import type { CabinDetail } from '@/lib/cabin-api'
import { CabinDraftPane } from '@/components/cabin/CabinDraftPane'
import { ChatSidebar } from './chat-sidebar'
import { SidebarResizer } from './sidebar-resizer'
import { useSidebarWidth } from './sidebar-width'
import {
  ChatPane,
  type ChatPaneAction,
  type ChatPaneCommand,
  type ChatPaneShared,
  type PendingTaskSession,
} from './ChatPane'

const SIDEBAR_COLLAPSED_KEY = 'octopus.chat.sidebarCollapsed.v1'

/**
 * 桌面壳注入的作战舱桥（2026-11-13）：左栏作战舱段 + pendingCabin hero。
 * 缺省 undefined = 独立渲染（单测等）保持原来的两段侧栏。
 */
export interface ChatTabCabinBridge {
  cabins: CabinDetail[]
  drafting: boolean
  onSelectCabin: (id: string) => void
  onCreateCabin: () => void
  onCancelDraft: () => void
  onCabinCreated: (id: string) => void
}

export function ChatTab({ cabinBridge }: { cabinBridge?: ChatTabCabinBridge } = {}) {
  const {
    sessions, activeSessionId, setActiveSessionId,
    loading: sessionsLoading, createNewSession, renameSession, removeSession,
    updateSessionTitle, refetch: refetchSessions,
  } = useChatSessions()
  const { tasks: chatTasks, loading: chatTasksLoading, refresh: refreshChatTasks } = useChatTasks()
  const runningAgents = useRunningAgents()
  const { orgs: appOrgs } = useOrgs()
  const { workspaces } = useWorkspaces()
  const { breakpoint } = useViewport()
  const splitEnabled = useChatSplitEnabled()
  const splitAllowed = breakpoint === 'wide'
  const split = splitEnabled && splitAllowed

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

  // ── 分屏状态 ───────────────────────────────────────────────────────
  const [focus, setFocus] = useState<ChatPaneId>(() => readChatSplitPrefs().focused)
  const [ratio, setRatio] = useState(() => readChatSplitPrefs().ratio)
  const [leftSession, setLeftSession] = useState<string | null>(null)
  const [rightSession, setRightSession] = useState<string | null>(null)
  const [leftTask, setLeftTask] = useState<TaskView | null>(null)
  const [rightTask, setRightTask] = useState<TaskView | null>(null)
  const [leftPending, setLeftPending] = useState<PendingTaskSession | null>(null)
  const [rightPending, setRightPending] = useState<PendingTaskSession | null>(null)
  const [leftCommand, setLeftCommand] = useState<ChatPaneCommand | null>(null)
  const [rightCommand, setRightCommand] = useState<ChatPaneCommand | null>(null)
  const [streamingByPane, setStreamingByPane] = useState<Record<ChatPaneId, string | null>>({ left: null, right: null })
  const [regionNode, setRegionNode] = useState<HTMLDivElement | null>(null)
  const regionRef = useRef<HTMLDivElement | null>(null)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ startX: number; startRatio: number; width: number } | null>(null)
  const nonceRef = useRef(0)
  const userNavigatedRef = useRef(false)
  const bootRef = useRef(false)
  const bootPrefsRef = useRef<ChatSplitPrefs | null>(null)
  const [bootReady, setBootReady] = useState(false)
  const restoreRef = useRef(false)
  const lastPushedRef = useRef<string | null | undefined>(undefined)
  const lastStreamingAtRef = useRef<Map<string, number>>(new Map())
  /** 本会话内由某一栏新建出来的 session id —— provider 推上来时不再当作外部请求。 */
  const selfCreatedRef = useRef<Set<string>>(new Set())
  /** 正在 createNewSession 的次数：期间 provider 的 id 变化不是「外部请求」。 */
  const creatingSessionRef = useRef(0)

  const attachRegion = useCallback((node: HTMLDivElement | null) => {
    regionRef.current = node
    setRegionNode(node)
  }, [])

  const issueCommand = useCallback((pane: ChatPaneId, action: ChatPaneAction) => {
    userNavigatedRef.current = true
    nonceRef.current += 1
    const command: ChatPaneCommand = { ...action, nonce: nonceRef.current }
    if (pane === 'left') setLeftCommand(command)
    else setRightCommand(command)
  }, [])

  const collapseSplit = useCallback(() => {
    // 关闭分屏 = 保留焦点栏：焦点在右时把右栏的内容搬到剩下的一栏。
    // 右栏还是空选择器时（没内容可保留）就留在左栏，别把左栏清空。
    const rightHasContent = !!(rightSession || rightTask || rightPending)
    if (focus === 'right' && rightHasContent) {
      setLeftSession(rightSession)
      setLeftTask(rightTask)
      setLeftPending(rightPending)
    }
    setFocus('left')
    setRightSession(null)
    setRightTask(null)
    setRightPending(null)
    setRightCommand(null)
  }, [focus, rightSession, rightTask, rightPending])

  // 顶栏 / ⌘\ / 窄屏都会改这个开关；壳统一处理进入与退出。
  const prevSplitRef = useRef(split)
  useEffect(() => {
    const prev = prevSplitRef.current
    prevSplitRef.current = split
    if (prev && !split) collapseSplit()
    else if (!prev && split) setFocus('left')
  }, [split, collapseSplit])

  useEffect(() => {
    if (!splitEnabled || splitAllowed) return
    // 视口缩到 <1024：自动退出分屏（保留焦点栏），并把开关写回 false。
    setChatSplitEnabled(false)
  }, [splitEnabled, splitAllowed])

  useEffect(() => {
    // boot 之前不写：启动时会先读同一份记录恢复两栏，提前写会把 left/right 清掉。
    if (!bootReady) return
    writeChatSplitPrefs({
      ratio,
      focused: focus,
      left: leftSession,
      right: rightSession,
      leftTask: leftTask?.id ?? null,
      rightTask: rightTask?.id ?? null,
    })
  }, [bootReady, ratio, focus, leftSession, rightSession, leftTask, rightTask])

  // ── 启动恢复：会话列表就绪后落一次；右栏只在上次分屏时恢复 ──────────
  useEffect(() => {
    if (bootRef.current || sessionsLoading) return
    bootRef.current = true
    const prefs = readChatSplitPrefs()
    bootPrefsRef.current = prefs
    const exists = (id: string | null) => !id || sessions.some((session) => session.id === id)
    const nextLeft = prefs.left && exists(prefs.left)
      ? prefs.left
      : (activeSessionId ?? null)
    setLeftSession(nextLeft)
    if (splitEnabled) {
      const nextRight = prefs.right && exists(prefs.right) && prefs.right !== nextLeft
        ? prefs.right
        : null
      setRightSession(nextRight)
    }
    setBootReady(true)
  }, [sessionsLoading, sessions, activeSessionId, splitEnabled])

  // 非焦点栏的任务恢复：每栏各自记住打开的任务；会话本身在 boot 里恢复，
  // 这里补回任务 chrome（作业坞 / 验收 / 运行）。只做一次，之后用户说了算。
  const restoredPaneTasksRef = useRef<{ left: boolean; right: boolean }>({ left: false, right: false })
  useEffect(() => {
    if (!bootReady) return
    if (!splitEnabled) {
      restoredPaneTasksRef.current = { left: true, right: true }
      return
    }
    const prefs = bootPrefsRef.current
    if (!prefs) return
    for (const pane of ['left', 'right'] as const) {
      if (restoredPaneTasksRef.current[pane]) continue
      const taskId = pane === 'left' ? prefs.leftTask : prefs.rightTask
      if (!taskId) {
        restoredPaneTasksRef.current[pane] = true
        continue
      }
      const task = chatTasks.find((item) => item.id === taskId)
      if (!task) {
        if (!chatTasksLoading) restoredPaneTasksRef.current[pane] = true
        continue
      }
      // 任务挂在哪个会话上，就恢复进那一栏（两栏不会同时持有同一会话）。
      const target = task.source_chat_session_id === rightSession ? 'right'
        : task.source_chat_session_id === leftSession ? 'left'
          : pane
      const paneSession = pane === 'left' ? leftSession : rightSession
      if (target === pane && paneSession && task.source_chat_session_id && paneSession !== task.source_chat_session_id) {
        // 这一栏已经打开了别的会话（用户后来换过）——不抢。
        restoredPaneTasksRef.current[pane] = true
        continue
      }
      restoredPaneTasksRef.current[pane] = true
      restoredPaneTasksRef.current[target] = true
      issueCommand(target, { type: 'select-task', task })
    }
  }, [bootReady, chatTasks, chatTasksLoading, leftSession, rightSession, splitEnabled, issueCommand])

  // 焦点栏 → 全局 activeSessionId（顶栏「运行中 Agent」、外部入口都读它）。
  // 只在「焦点栏 / 栏内会话」变化时推；provider 自己的变化由下面的外部入口
  // effect 处理 —— 否则两边会互相顶回去。
  const providerSessionRef = useRef(activeSessionId)
  providerSessionRef.current = activeSessionId
  useEffect(() => {
    if (!bootReady) return
    const focusedSession = focus === 'left' ? leftSession : rightSession
    if (providerSessionRef.current === focusedSession) return
    lastPushedRef.current = focusedSession
    setActiveSessionId(focusedSession)
  }, [bootReady, focus, leftSession, rightSession, setActiveSessionId])

  // 外部（运行中 Agent 点击、通知）改 activeSessionId → 落到焦点栏。
  // 本栏刚 createNewSession 出来的会话不算「外部」：provider 会短暂地把新 id
  // 推上来，但栏内已经准备自己接管（否则会把待发首条消息清掉，导致重复发送）。
  const paneRef = useRef({ left: leftSession, right: rightSession, focus })
  paneRef.current = { left: leftSession, right: rightSession, focus }
  // provider 上一次的值：effect 里读到的 activeSessionId 可能是「本栏还没推上去的
  // 旧值」（同一次 commit 里 push effect 已经排了新值），这样就不会把旧值当成
  // 外部请求再路由一遍。
  const prevProviderRef = useRef(activeSessionId)
  useEffect(() => {
    const previous = prevProviderRef.current
    prevProviderRef.current = activeSessionId
    if (!bootReady) return
    if (activeSessionId === null) return
    if (activeSessionId === lastPushedRef.current) {
      lastPushedRef.current = undefined
      return
    }
    if (activeSessionId === previous) return
    if (creatingSessionRef.current > 0) return
    if (selfCreatedRef.current.delete(activeSessionId)) return
    const { left, right, focus: current } = paneRef.current
    if (activeSessionId === left) { setFocus('left'); return }
    if (activeSessionId === right) { setFocus('right'); return }
    issueCommand(current, { type: 'select-session', sessionId: activeSessionId })
  }, [bootReady, activeSessionId, issueCommand])

  // 兜底：两栏永远不持有同一个会话（任何入口漏了去重都在这里收口）。
  useEffect(() => {
    if (!split || !leftSession || leftSession !== rightSession) return
    toast.message('该会话已在另一栏打开')
    if (focus === 'left') {
      setRightSession(null)
      setRightTask(null)
      setRightPending(null)
    } else {
      setLeftSession(null)
      setLeftTask(null)
      setLeftPending(null)
    }
  }, [split, focus, leftSession, rightSession])

  // 焦点栏就是「上次的上下文」，刷新后恢复它。
  useEffect(() => {
    const task = focus === 'left' ? leftTask : rightTask
    const session = focus === 'left' ? leftSession : rightSession
    if (task) writeLastChatContext({ kind: 'task', taskId: task.id })
    else if (session) writeLastChatContext({ kind: 'session', sessionId: session })
  }, [focus, leftTask, rightTask, leftSession, rightSession])

  // 刷新恢复：上次停在任务里 → 回到该任务（与旧单栏行为一致）。
  useEffect(() => {
    if (restoreRef.current || !bootReady) return
    if (userNavigatedRef.current) {
      restoreRef.current = true
      return
    }
    const saved = readLastChatContext()
    if (saved?.kind !== 'task') {
      restoreRef.current = true
      return
    }
    // 任务挂在哪个会话上就恢复进哪一栏（避免把已在左栏的会话复制进右栏）。
    const targetFor = (task: TaskView): ChatPaneId => {
      const sid = task.source_chat_session_id
      if (sid && sid === leftSession) return 'left'
      if (sid && sid === rightSession) return 'right'
      return focus
    }
    const known = chatTasks.find((task) => task.id === saved.taskId)
    if (known) {
      restoreRef.current = true
      issueCommand(targetFor(known), { type: 'select-task', task: known })
      return
    }
    if (chatTasksLoading) return
    restoreRef.current = true
    getTask(saved.taskId)
      .then((task) => issueCommand(targetFor(task), { type: 'select-task', task }))
      .catch(() => { /* deleted — stay on the default chat */ })
  }, [bootReady, chatTasks, chatTasksLoading, focus, leftSession, rightSession, issueCommand])

  // ⌘\ / Ctrl+\：与顶栏按钮同效（对话框里不抢）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key !== '\\') return
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      if (!splitEnabled && !splitAllowed) {
        toast.message('分屏需要更宽的窗口（≥1024px）')
        return
      }
      setChatSplitEnabled(!splitEnabled)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [splitEnabled, splitAllowed])

  // ── 侧栏数据 / 焦点栏代理 ─────────────────────────────────────────
  const focusedTask = focus === 'left' ? leftTask : rightTask
  const focusedPending = focus === 'left' ? leftPending : rightPending
  const focusedSession = focus === 'left' ? leftSession : rightSession

  const sidebarTasks = useMemo(() => {
    const missing = [leftTask, rightTask].filter(
      (task): task is TaskView =>
        !!task && task.status === 'draft' && !chatTasks.some((item) => item.id === task.id),
    )
    return missing.length > 0 ? [...missing, ...chatTasks] : chatTasks
  }, [chatTasks, leftTask, rightTask])

  const openSessionInPane = useCallback((pane: ChatPaneId, id: string) => {
    userNavigatedRef.current = true
    // 同一会话不允许同时占两栏：已开着的行 = 聚焦那一栏。
    if (leftSession === id) {
      setFocus('left')
      if (split) toast.message('已在左栏打开')
      return
    }
    if (rightSession === id) {
      setFocus('right')
      if (split) toast.message('已在右栏打开')
      return
    }
    issueCommand(pane, { type: 'select-session', sessionId: id })
  }, [split, leftSession, rightSession, issueCommand])

  const handleSelectSession = useCallback((id: string) => {
    openSessionInPane(split ? focus : 'left', id)
  }, [split, focus, openSessionInPane])

  const handleSelectTask = useCallback((task: TaskView, opts?: { module?: TaskModule }) => {
    if (!split) {
      issueCommand('left', { type: 'select-task', task, ...(opts?.module ? { module: opts.module } : {}) })
      return
    }
    if (leftTask?.id === task.id) { setFocus('left'); toast.message('已在左栏打开'); return }
    if (rightTask?.id === task.id) { setFocus('right'); toast.message('已在右栏打开'); return }
    // 任务的主会话已经开在另一栏：把任务 chrome 挂到那一栏，而不是复制一份对话。
    const sid = task.source_chat_session_id
    if (sid && focus !== 'left' && leftSession === sid) {
      setFocus('left')
      issueCommand('left', { type: 'select-task', task, ...(opts?.module ? { module: opts.module } : {}) })
      toast.message('已在左栏打开')
      return
    }
    if (sid && focus !== 'right' && rightSession === sid) {
      setFocus('right')
      issueCommand('right', { type: 'select-task', task, ...(opts?.module ? { module: opts.module } : {}) })
      toast.message('已在右栏打开')
      return
    }
    issueCommand(focus, { type: 'select-task', task, ...(opts?.module ? { module: opts.module } : {}) })
  }, [split, leftTask, rightTask, leftSession, rightSession, focus, issueCommand])

  const handleCreateSession = useCallback(() => {
    issueCommand(split ? focus : 'left', { type: 'new-session' })
  }, [split, focus, issueCommand])

  const handleCreateTask = useCallback((kind?: 'workflow-dev') => {
    issueCommand(split ? focus : 'left', { type: 'new-task', ...(kind ? { kind } : {}) })
  }, [split, focus, issueCommand])

  const openInOtherPane = useCallback((target: { kind: 'session' | 'task'; id: string; task?: TaskView }) => {
    if (!split) return
    const other: ChatPaneId = focus === 'left' ? 'right' : 'left'
    if (target.kind === 'session') {
      if (leftSession === target.id) { setFocus('left'); toast.message('已在左栏打开'); return }
      if (rightSession === target.id) { setFocus('right'); toast.message('已在右栏打开'); return }
      setFocus(other)
      issueCommand(other, { type: 'select-session', sessionId: target.id })
      return
    }
    if (leftTask?.id === target.id) { setFocus('left'); toast.message('已在左栏打开'); return }
    if (rightTask?.id === target.id) { setFocus('right'); toast.message('已在右栏打开'); return }
    setFocus(other)
    if (target.task) issueCommand(other, { type: 'select-task', task: target.task })
  }, [split, focus, leftSession, rightSession, leftTask, rightTask, issueCommand])

  const handleDeleteSession = useCallback(async (id: string) => {
    await removeSession(id)
    if (leftSession === id) setLeftSession(null)
    if (rightSession === id) setRightSession(null)
  }, [removeSession, leftSession, rightSession])

  // 跨应用入口（任务板 [+新建任务] / 通知）只挂一次，路由到焦点栏 ——
  // 分屏时两栏各挂一份会重复建任务/重复开窗。
  useEffect(() => {
    const onNewTask = () => { handleCreateTask() }
    const onNewWorkflowTask = () => { handleCreateTask('workflow-dev') }
    const onOpenTask = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; view?: 'acceptance' }>).detail
      const taskId = detail?.taskId
      if (!taskId) return
      getTask(taskId)
        .then((task) => {
          handleSelectTask(task, detail?.view === 'acceptance' ? { module: 'acceptance' } : undefined)
          void refreshChatTasks()
        })
        .catch(() => toast.error('任务不存在或已被删除'))
    }
    window.addEventListener('octopus:new-task', onNewTask)
    window.addEventListener('octopus:new-workflow-task', onNewWorkflowTask)
    window.addEventListener('octopus:open-task', onOpenTask)
    return () => {
      window.removeEventListener('octopus:new-task', onNewTask)
      window.removeEventListener('octopus:new-workflow-task', onNewWorkflowTask)
      window.removeEventListener('octopus:open-task', onOpenTask)
    }
  }, [handleCreateTask, handleSelectTask, refreshChatTasks])

  const paneOfSession = useCallback((id: string): ChatPaneId | null => {
    if (leftSession === id) return 'left'
    if (rightSession === id) return 'right'
    return null
  }, [leftSession, rightSession])

  const paneOfTask = useCallback((id: string): ChatPaneId | null => {
    if (leftTask?.id === id) return 'left'
    if (rightTask?.id === id) return 'right'
    return null
  }, [leftTask, rightTask])

  const handleStreamingChange = useCallback((pane: ChatPaneId, sessionId: string | null) => {
    if (sessionId) lastStreamingAtRef.current.set(sessionId, Date.now())
    setStreamingByPane((prev) => (prev[pane] === sessionId ? prev : { ...prev, [pane]: sessionId }))
  }, [])
  const onLeftStreaming = useCallback((id: string | null) => handleStreamingChange('left', id), [handleStreamingChange])
  const onRightStreaming = useCallback((id: string | null) => handleStreamingChange('right', id), [handleStreamingChange])

  // 运行中徽标：真实运行列表 + 两栏的流式会话 + 6s 宽限（切走后服务端仍在跑）。
  const runningSessionIds = useMemo(() => {
    const ids = new Set(runningAgents.map((agent) => agent.id))
    if (streamingByPane.left) ids.add(streamingByPane.left)
    if (streamingByPane.right) ids.add(streamingByPane.right)
    const now = Date.now()
    for (const [id, at] of lastStreamingAtRef.current) {
      if (now - at < 6_000) ids.add(id)
    }
    return ids
  }, [runningAgents, streamingByPane])

  // ── 侧栏宽度 / 折叠 / 搜索 / 移动端抽屉 ─────────────────────────────
  // 宽度与舱内对话共用（sidebar-width.ts）：拖出的值两个视图都认。
  const { width: sidebarWidth, resizing: resizingSidebar, resizeHandlers } = useSidebarWidth()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  })
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [sidebarCollapsed])

  const expandSidebar = useCallback((opts?: { focusSearch?: boolean }) => {
    setSidebarCollapsed(false)
    if (opts?.focusSearch) setSidebarSearchOpen(true)
  }, [])

  // ── 分屏线拖拽 ─────────────────────────────────────────────────────
  const handleDividerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const region = regionRef.current
    if (!region) return
    event.preventDefault()
    dragRef.current = {
      startX: event.clientX,
      startRatio: ratio,
      width: region.clientWidth - CHAT_SPLIT_DIVIDER_WIDTH,
    }
    setResizing(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }

  const handleDividerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.width <= 0) return
    const min = Math.min(0.48, CHAT_SPLIT_MIN_PANE_WIDTH / drag.width)
    const next = Math.max(min, Math.min(1 - min, drag.startRatio + (event.clientX - drag.startX) / drag.width))
    setRatio(Math.round(next * 1000) / 1000)
  }

  const handleDividerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setResizing(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* pointer capture unavailable */
    }
  }

  // ── 共享数据（每栏各一份 hook 状态，数据只取一遍）──────────────────
  const createTrackedSession = useCallback<ChatPaneShared['createNewSession']>(async (opts) => {
    creatingSessionRef.current += 1
    try {
      const session = await createNewSession(opts)
      if (session) selfCreatedRef.current.add(session.id)
      return session
    } finally {
      creatingSessionRef.current -= 1
    }
  }, [createNewSession])

  const shared = useMemo<ChatPaneShared>(() => ({
    sessions,
    sessionsLoading,
    createNewSession: createTrackedSession,
    updateSessionTitle,
    refreshSessions: refetchSessions,
    chatTasks,
    chatTasksLoading,
    refreshChatTasks,
    runningAgents,
    appOrgs: appOrgs.map((org) => org.name),
    workspaces,
    preferredOrg,
    sidebarWidth: sidebarCollapsed ? 0 : sidebarWidth,
  }), [
    sessions, sessionsLoading, createTrackedSession, updateSessionTitle, refetchSessions,
    chatTasks, chatTasksLoading, refreshChatTasks, runningAgents, appOrgs, workspaces, preferredOrg,
    sidebarCollapsed, sidebarWidth,
  ])

  const canSwap = !!(rightSession || rightPending || rightTask)

  const handleSwapPanes = useCallback(() => {
    setLeftSession(rightSession)
    setLeftTask(rightTask)
    setLeftPending(rightPending)
    setRightSession(leftSession)
    setRightTask(leftTask)
    setRightPending(leftPending)
    setFocus((current) => (current === 'left' ? 'right' : 'left'))
    toast.message('已交换左右两栏')
  }, [leftSession, rightSession, leftTask, rightTask, leftPending, rightPending])

  const openTaskRename = useCallback((task: TaskView) => {
    const pane = task.source_chat_session_id && leftSession === task.source_chat_session_id
      ? 'left'
      : task.source_chat_session_id && rightSession === task.source_chat_session_id
        ? 'right'
        : focus
    issueCommand(pane, { type: 'rename-task', task })
  }, [leftSession, rightSession, focus, issueCommand])

  const openTaskDelete = useCallback((task: TaskView) => {
    const pane = task.source_chat_session_id && leftSession === task.source_chat_session_id
      ? 'left'
      : task.source_chat_session_id && rightSession === task.source_chat_session_id
        ? 'right'
        : focus
    issueCommand(pane, { type: 'delete-task', task })
  }, [leftSession, rightSession, focus, issueCommand])

  const sidebarProps = {
    // 桌面内的作战舱段（原型三段左栏：作战舱 · 任务 · 会话）。
    ...(cabinBridge
      ? {
          cabins: cabinBridge.cabins,
          activeCabinId: null,
          onSelectCabin: cabinBridge.onSelectCabin,
          onCreateCabin: cabinBridge.onCreateCabin,
        }
      : {}),
    tasks: sidebarTasks,
    tasksLoading: chatTasksLoading,
    activeTaskId: focusedTask?.id ?? null,
    onSelectTask: handleSelectTask,
    pendingTask: focusedPending ? {
      title: focusedPending.title,
      ...(focusedPending.kind ? { kind: focusedPending.kind } : {}),
    } : null,
    activePendingTask: !!focusedPending,
    sessions,
    sessionsLoading,
    activeSessionId: focusedTask ? null : focusedSession,
    onSelectSession: handleSelectSession,
    runningSessionIds,
    onCreateSession: handleCreateSession,
    onCreateTask: () => { handleCreateTask() },
    onCreateWorkflowTask: () => { handleCreateTask('workflow-dev') },
    onRenameSession: renameSession,
    onDeleteSession: (id: string) => { void handleDeleteSession(id) },
    onRenameTask: openTaskRename,
    onDeleteTask: openTaskDelete,
    searchOpen: sidebarSearchOpen,
    onSearchOpenChange: setSidebarSearchOpen,
    splitMode: split,
    paneOfSession,
    paneOfTask,
    onOpenSessionInOther: (id: string) => openInOtherPane({ kind: 'session', id }),
    onOpenTaskInOther: (task: TaskView) => openInOtherPane({ kind: 'task', id: task.id, task }),
    openInOtherLabel: focus === 'left' ? '在右栏打开' : '在左栏打开',
  }

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
            {...sidebarProps}
            onCollapse={() => setSidebarCollapsed(true)}
          />
          <SidebarResizer resizing={resizingSidebar} handlers={resizeHandlers} />
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
          <ChatSidebar {...sidebarProps} />
        </SheetContent>
      </Sheet>

      {/* 聊天区：左栏 +（可选）分屏线 + 右栏。任务模块窗 portal 到这里。 */}
      <div
        ref={attachRegion}
        data-testid="chat-split-region"
        data-split={split ? 'true' : undefined}
        className={cn('relative flex min-w-0 flex-1', resizing && 'cursor-col-resize select-none [&_*]:cursor-col-resize')}
      >
        {cabinBridge?.drafting ? (
          <CabinDraftPane
            onCreated={cabinBridge.onCabinCreated}
            onCancel={cabinBridge.onCancelDraft}
          />
        ) : split ? (
          <>
            <div
              className="flex min-w-0"
              style={{ width: `calc((100% - ${CHAT_SPLIT_DIVIDER_WIDTH}px) * ${ratio})` }}
            >
              <ChatPane
                pane="left"
                split
                focused={focus === 'left'}
                secondary={false}
                sessionId={leftSession}
                setSessionId={setLeftSession}
                activeTask={leftTask}
                setActiveTask={setLeftTask}
                pendingTaskSession={leftPending}
                setPendingTaskSession={setLeftPending}
                command={leftCommand}
                layerRoot={regionNode}
                otherSessionId={rightSession}
                otherTaskId={rightTask?.id ?? null}
                onOpenSession={(id) => openSessionInPane('left', id)}
                shared={shared}
                onFocus={() => setFocus('left')}
                onStreamingChange={onLeftStreaming}
                onOpenSidebar={() => setMobileSidebarOpen(true)}
                onExitSplit={() => setChatSplitEnabled(false)}
                onSwapPanes={handleSwapPanes}
                canSwap={canSwap}
              />
            </div>

            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整左右分栏宽度"
              aria-valuenow={Math.round(ratio * 100)}
              aria-valuemin={20}
              aria-valuemax={80}
              data-testid="chat-split-divider"
              title="拖动调整宽度 · 双击复位"
              onPointerDown={handleDividerDown}
              onPointerMove={handleDividerMove}
              onPointerUp={handleDividerEnd}
              onPointerCancel={handleDividerEnd}
              onDoubleClick={() => setRatio(CHAT_SPLIT_DEFAULT_RATIO)}
              className="group relative z-30 w-2 shrink-0 cursor-col-resize touch-none"
            >
              <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/[0.08] transition-colors group-hover:bg-pop-yellow/50" />
              <span
                className={cn(
                  'pointer-events-none absolute left-1/2 top-1/2 flex h-9 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-[2px] rounded-full border bg-pop-paper shadow-pop-sm transition-opacity',
                  resizing ? 'border-pop-yellow/60 opacity-100' : 'border-pop-bd opacity-0 group-hover:opacity-100',
                )}
              >
                <i className="size-[2px] rounded-full bg-pop-dim" />
                <i className="size-[2px] rounded-full bg-pop-dim" />
                <i className="size-[2px] rounded-full bg-pop-dim" />
              </span>
            </div>

            <div className="flex min-w-0 flex-1">
              <ChatPane
                pane="right"
                split
                focused={focus === 'right'}
                secondary
                sessionId={rightSession}
                setSessionId={setRightSession}
                activeTask={rightTask}
                setActiveTask={setRightTask}
                pendingTaskSession={rightPending}
                setPendingTaskSession={setRightPending}
                command={rightCommand}
                layerRoot={regionNode}
                otherSessionId={leftSession}
                otherTaskId={leftTask?.id ?? null}
                onOpenSession={(id) => openSessionInPane('right', id)}
                shared={shared}
                onFocus={() => setFocus('right')}
                onStreamingChange={onRightStreaming}
                onOpenSidebar={() => setMobileSidebarOpen(true)}
                onExitSplit={() => setChatSplitEnabled(false)}
                onSwapPanes={handleSwapPanes}
                canSwap={canSwap}
              />
            </div>
          </>
        ) : (
          <ChatPane
            pane="left"
            split={false}
            focused
            secondary={false}
            sessionId={leftSession}
            setSessionId={setLeftSession}
            activeTask={leftTask}
            setActiveTask={setLeftTask}
            pendingTaskSession={leftPending}
            setPendingTaskSession={setLeftPending}
            command={leftCommand}
            layerRoot={regionNode}
            otherSessionId={null}
            otherTaskId={null}
            onOpenSession={(id) => openSessionInPane('left', id)}
            shared={shared}
            onFocus={() => setFocus('left')}
            onStreamingChange={onLeftStreaming}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
            onExitSplit={() => setChatSplitEnabled(false)}
            onSwapPanes={handleSwapPanes}
            canSwap={canSwap}
          />
        )}
      </div>
    </div>
  )
}
