'use client'

// 舱 chat tab（原型 body：sidebar + chat-region）。左侧复用生产 ChatSidebar
// （工作舱·任务·会话三段 + 新建菜单含「新建工作舱」），右侧 chat 底座宿主单个
// ChatPane（pane='left'、不分屏、恒焦点），会话钉在 cabin.main_session_id
// （orchestrator 主对话，C3/C4 单线程）。ChatArea/TuiTranscript/useAgentChat/
// chatStream 全部原样复用。
//
// 模块导航在悬浮作业坞（原型 DOCK_MOD）：ChatPane 透传 cabinModules 给
// WorkspaceExplorerDock；点模块 → CabinProvider 开浮窗（CabinModulesLayer 全几何）。
// 座舱 attention 的「打开任务」经 octopus:open-task 进来，与桌面同一协议。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Archive, BarChart3, BookOpen, ClipboardCheck, ClipboardList, Folder, GitBranch, GitCompare,
  Layers, LayoutGrid, ListTodo, PanelLeft, Play, Search, Send, SlidersHorizontal,
  SquarePen, User, Boxes,
} from 'lucide-react'
import { toast } from 'sonner'
import { useChatSessions } from '@/components/providers/chat-sessions'
import { useChatTasks } from '@/hooks/use-chat-tasks'
import { useRunningAgents } from '@/hooks/use-running-agents'
import { useOrgs } from '@/hooks/useOrgs'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useCabins } from '@/hooks/use-cabins'
import { getTask, listTasks, type TaskView } from '@/lib/tasks-api'
import { readRememberedTaskOrg, resolveTaskOrg } from '@/lib/task-org'
import { useRouter } from '@/lib/app-navigation'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { ChatSidebar } from '@/components/agent/chat/chat-sidebar'
import {
  ChatPane,
  type ChatPaneAction,
  type ChatPaneCommand,
  type ChatPaneShared,
  type PendingTaskSession,
} from '@/components/agent/chat/ChatPane'
import type { CabinDockModule } from '@/components/workspace/workspace-explorer-dock'
import { useCabinContext } from './cabin-provider'
import { CabinModulesLayer } from './CabinModulesLayer'
import { CabinAtmosphere } from './CabinAtmosphere'
import { CabinCrew } from './CabinCrew'
import { useCockpit } from './CockpitProvider'
import { CABIN_DOCK_OVERFLOW, CABIN_DOCK_PRIMARY } from './cabin-meta'

const DOCK_ICONS: Record<string, typeof LayoutGrid> = {
  overview: LayoutGrid,
  queue: Send,
  tasks: ListTodo,
  missions: ClipboardList,
  run: Play,
  repos: Folder,
  worktree: GitBranch,
  iterations: Layers,
  jobs: Boxes,
  trace: Activity,
  changes: GitCompare,
  acceptance: ClipboardCheck,
  knowledge: BookOpen,
  usage: BarChart3,
  archive: Archive,
  tuning: SlidersHorizontal,
  gallery: User,
}

const SIDEBAR_WIDTH = 236

export interface CabinChatHostProps {
  /** 桌面内壳传入：切舱保持在桌面里（不跳 /cabin/:id）。 */
  onSelectCabin?: (id: string) => void
  /** 桌面内壳传入：新建走 pendingCabin hero（不跳 /cabin/new）。 */
  onCreateCabin?: () => void
}

export function CabinChatHost({ onSelectCabin, onCreateCabin }: CabinChatHostProps = {}) {
  const {
    cabinId, cabin, view, openWindows, minimizedWindows, openModule,
  } = useCabinContext()
  const { setStreaming } = useCockpit()
  const router = useRouter()
  const {
    sessions, loading: sessionsLoading, createNewSession, renameSession, removeSession,
    updateSessionTitle, refetch: refetchSessions,
  } = useChatSessions()
  const { tasks: chatTasks, loading: chatTasksLoading, refresh: refreshChatTasks } = useChatTasks()
  const runningAgents = useRunningAgents()
  const { orgs: appOrgs } = useOrgs()
  const { workspaces } = useWorkspaces()
  const { cabins } = useCabins()

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [activeTask, setActiveTask] = useState<TaskView | null>(null)
  const [pendingTaskSession, setPendingTaskSession] = useState<PendingTaskSession | null>(null)
  const [command, setCommand] = useState<ChatPaneCommand | null>(null)
  const [regionNode, setRegionNode] = useState<HTMLDivElement | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const nonceRef = useRef(0)

  // 主会话钉住：舱加载完成 / 切换舱时落一次。用户经 select-task 打开任务线程
  // 后不再强拉回来（ChatPane 自己管 sessionId）。
  const mainSessionId = cabin?.main_session_id ?? null
  useEffect(() => {
    setSessionId(mainSessionId)
    setActiveTask(null)
    setPendingTaskSession(null)
  }, [mainSessionId])

  // 舱主会话可能不在最近 50 条里：进壳时刷一次会话列表。
  useEffect(() => {
    void refetchSessions()
  }, [refetchSessions])

  const issueCommand = useCallback((action: ChatPaneAction) => {
    nonceRef.current += 1
    setCommand({ ...action, nonce: nonceRef.current })
  }, [])

  const preferredOrg = useMemo(
    () => cabin?.org ?? resolveTaskOrg({
      orgs: appOrgs.map((o) => o.name),
      remembered: readRememberedTaskOrg(),
      recentTaskOrgs: [...chatTasks]
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .map((task) => task.repo_group),
    }),
    [cabin?.org, appOrgs, chatTasks],
  )

  const shared = useMemo<ChatPaneShared>(() => ({
    sessions,
    sessionsLoading,
    createNewSession,
    updateSessionTitle,
    refreshSessions: refetchSessions,
    chatTasks,
    chatTasksLoading,
    refreshChatTasks,
    runningAgents,
    appOrgs: appOrgs.map((org) => org.name),
    workspaces,
    preferredOrg,
    sidebarWidth: sidebarCollapsed ? 0 : SIDEBAR_WIDTH,
  }), [
    sessions, sessionsLoading, createNewSession, updateSessionTitle, refetchSessions,
    chatTasks, chatTasksLoading, refreshChatTasks, runningAgents, appOrgs, workspaces,
    preferredOrg, sidebarCollapsed,
  ])

  // 座舱 attention / 外部入口打开任务：与桌面 ChatTab 同一事件协议。
  useEffect(() => {
    const onOpenTask = (event: Event) => {
      const detail = (event as CustomEvent<{ taskId?: string; view?: 'acceptance' | 'changes' }>).detail
      const taskId = detail?.taskId
      if (!taskId) return
      getTask(taskId)
        .then((task) => {
          issueCommand({
            type: 'select-task',
            task,
            ...(detail?.view === 'acceptance' ? { module: 'acceptance' as const } : {}),
            ...(detail?.view === 'changes' ? { module: 'changes' as const } : {}),
          })
          void refreshChatTasks()
        })
        .catch(() => toast.error('任务不存在或已被删除'))
    }
    window.addEventListener('octopus:open-task', onOpenTask)
    return () => window.removeEventListener('octopus:open-task', onOpenTask)
  }, [issueCommand, refreshChatTasks])

  // 舱 dock「变更/验收」→ 任务级窗（复用 per-task TaskModulesLayer）：已选任务
  // 直接开；未选则按原型自动挑（验收=待验收优先，变更=活态优先）；无任务开舱窗空态。
  const openTaskModule = useCallback(async (module: 'changes' | 'acceptance') => {
    if (activeTask) {
      issueCommand({ type: 'select-task', task: activeTask, module })
      return
    }
    try {
      const { items } = await listTasks({ cabin_id: cabinId })
      const pick = module === 'acceptance'
        ? items.find((t) => t.status === 'awaiting_review') ?? items[0]
        : items.find((t) => ['running', 'awaiting_review', 'done'].includes(t.status)) ?? items[0]
      if (pick) {
        const full = await getTask(pick.id)
        issueCommand({ type: 'select-task', task: full, module })
        return
      }
    } catch {
      /* 落舱窗空态 */
    }
    openModule(module)
  }, [activeTask, cabinId, issueCommand, openModule])

  const attachRegion = useCallback((node: HTMLDivElement | null) => {
    setRegionNode(node)
  }, [])

  const noop = useCallback(() => {}, [])

  const runningSessionIds = useMemo(
    () => new Set(runningAgents.map((agent) => agent.id)),
    [runningAgents],
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    await removeSession(id)
    if (sessionId === id) setSessionId(mainSessionId)
  }, [removeSession, sessionId, mainSessionId])

  // ── dock 舱模块段（原型 DOCK_PRIMARY + 更多溢出）─────────────────────
  const moduleState = useCallback((id: string) => {
    const open = openWindows.includes(id)
    const minimized = minimizedWindows.includes(id)
    return {
      active: open && !minimized,
      marker: (minimized ? 'minimized' : open ? 'open' : undefined) as 'open' | 'minimized' | undefined,
    }
  }, [openWindows, minimizedWindows])

  const personCount = view?.attention.filter((a) => a.awaiting === 'person').length ?? 0
  const attentionCount = view?.attention.length ?? 0
  const reviewCount = view?.attention.filter((a) => a.stage === 'review').length ?? 0
  const runningCount = view?.health.running ?? 0

  const dockModules = useMemo<CabinDockModule[]>(() => CABIN_DOCK_PRIMARY.map((id) => ({
    id,
    label: id === 'overview' ? '概览' : id === 'queue' ? '队列' : id === 'tasks' ? '任务' : id === 'missions' ? '作战' : '运行',
    icon: DOCK_ICONS[id],
    ...moduleState(id),
    attention: id === 'overview' && personCount > 0 && !openWindows.includes(id),
    // 原型 renderDock badge：overview=attention 数(amber) / queue=待路由(amber) / run=运行数(green)
    badge: id === 'overview' ? attentionCount : id === 'queue' ? attentionCount : id === 'run' ? runningCount : undefined,
    badgeTone: id === 'run' ? 'green' as const : 'amber' as const,
    onClick: () => openModule(id),
  })), [moduleState, openModule, personCount, attentionCount, runningCount, openWindows])

  const dockMoreModules = useMemo<CabinDockModule[]>(() => CABIN_DOCK_OVERFLOW.map((id) => ({
    id,
    label: id === 'repos' ? '仓库' : id === 'worktree' ? '工作树' : id === 'iterations' ? '迭代'
      : id === 'jobs' ? '作业' : id === 'trace' ? 'Trace' : id === 'changes' ? '变更'
        : id === 'acceptance' ? '验收' : id === 'knowledge' ? '知识' : id === 'usage' ? '消耗'
          : id === 'archive' ? '归档' : id === 'tuning' ? '调校' : '立绘',
    icon: DOCK_ICONS[id],
    ...moduleState(id),
    badge: id === 'acceptance' ? reviewCount : id === 'knowledge' ? (view?.open_findings ?? 0) : undefined,
    badgeTone: 'amber' as const,
    onClick: () => {
      if (id === 'changes' || id === 'acceptance') void openTaskModule(id)
      else openModule(id)
    },
  })), [moduleState, openModule, openTaskModule, reviewCount, view?.open_findings])

  const sidebarProps = {
    cabins,
    activeCabinId: cabinId,
    onSelectCabin: (id: string) => {
      if (id === cabinId) {
        // 点当前舱 = 回到舱主对话。左栏切到别的会话/任务后，这一下必须能回去
        // （2026-11-13 用户反馈：活跃舱行点了没反应）。
        if (cabin?.main_session_id) {
          issueCommand({ type: 'select-session', sessionId: cabin.main_session_id })
        }
        return
      }
      if (onSelectCabin) onSelectCabin(id)
      else router.push(`/cabin/${id}`)
    },
    onCreateCabin: onCreateCabin ?? (() => router.push('/cabin/new')),
    tasks: chatTasks,
    tasksLoading: chatTasksLoading,
    activeTaskId: activeTask?.id ?? null,
    onSelectTask: (task: TaskView) => issueCommand({ type: 'select-task', task }),
    pendingTask: pendingTaskSession ? { title: pendingTaskSession.title, ...(pendingTaskSession.kind ? { kind: pendingTaskSession.kind } : {}) } : null,
    activePendingTask: !!pendingTaskSession,
    sessions,
    sessionsLoading,
    activeSessionId: activeTask ? null : sessionId,
    onSelectSession: (id: string) => issueCommand({ type: 'select-session', sessionId: id }),
    runningSessionIds,
    onCreateSession: () => issueCommand({ type: 'new-session' }),
    onCreateTask: () => issueCommand({ type: 'new-task' }),
    onCreateWorkflowTask: () => issueCommand({ type: 'new-task', kind: 'workflow-dev' }),
    onRenameSession: renameSession,
    onDeleteSession: (id: string) => { void handleDeleteSession(id) },
    searchOpen: sidebarSearchOpen,
    onSearchOpenChange: setSidebarSearchOpen,
  }

  return (
    <div className="ui-font relative flex h-full min-h-0 flex-1">
      {!sidebarCollapsed && (
        <aside
          className="relative hidden shrink-0 border-r border-white/[0.06] md:flex md:flex-col"
          style={{ width: SIDEBAR_WIDTH }}
          data-chat-sidebar
        >
          <ChatSidebar {...sidebarProps} onCollapse={() => setSidebarCollapsed(true)} />
        </aside>
      )}

      {sidebarCollapsed && (
        <div
          data-testid="cabin-sidebar-collapsed"
          className="absolute left-3 top-2.5 z-30 hidden items-center gap-0.5 rounded-full border border-white/[0.08] bg-pop-paper/85 p-1 shadow-pop-lg backdrop-blur-xl md:flex"
        >
          <button
            type="button"
            aria-label="开启新对话"
            title="开启新对话"
            onClick={() => issueCommand({ type: 'new-session' })}
            className="grid size-7 place-items-center rounded-full text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
          >
            <SquarePen className="size-[15px]" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="搜索对话"
            title="搜索对话"
            onClick={() => { setSidebarCollapsed(false); setSidebarSearchOpen(true) }}
            className="grid size-7 place-items-center rounded-full text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
          >
            <Search className="size-[15px]" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="展开侧栏"
            title="展开侧栏"
            onClick={() => setSidebarCollapsed(false)}
            className="grid size-7 place-items-center rounded-full text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
          >
            <PanelLeft className="size-[15px]" strokeWidth={1.8} />
          </button>
        </div>
      )}

      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="w-[264px] border-0 bg-pop-idle p-0 pt-10 md:hidden">
          <ChatSidebar {...sidebarProps} />
        </SheetContent>
      </Sheet>

      <div
        ref={attachRegion}
        data-testid="cabin-chat-region"
        className={cn('relative flex min-w-0 flex-1')}
      >
        <CabinAtmosphere />
        <ChatPane
          pane="left"
          split={false}
          focused
          secondary={false}
          sessionId={sessionId}
          setSessionId={setSessionId}
          activeTask={activeTask}
          setActiveTask={setActiveTask}
          pendingTaskSession={pendingTaskSession}
          setPendingTaskSession={setPendingTaskSession}
          command={command}
          layerRoot={regionNode}
          otherSessionId={null}
          otherTaskId={null}
          onOpenSession={(id) => issueCommand({ type: 'select-session', sessionId: id })}
          shared={shared}
          onFocus={noop}
          onStreamingChange={(sid) => setStreaming(sid !== null)}
          onOpenSidebar={() => setMobileSidebarOpen(true)}
          onExitSplit={noop}
          onSwapPanes={noop}
          canSwap={false}
          dockCabinModules={dockModules}
          dockCabinMoreModules={dockMoreModules}
          cabinId={cabinId}
          cabinWorkspaceId={cabin?.workspace_id ?? null}
        />
        <CabinCrew />
        <CabinModulesLayer onNewTask={() => issueCommand({ type: 'new-task' })} />
      </div>
    </div>
  )
}