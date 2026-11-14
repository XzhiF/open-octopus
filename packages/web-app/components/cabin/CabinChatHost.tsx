'use client'

// 舱 chat tab（原型 body：sidebar + chat-region）。左侧复用生产 ChatSidebar
// （作战舱·任务·会话三段 + 新建菜单含「新建作战舱」），右侧 chat 底座宿主单个
// ChatPane（pane='left'、不分屏、恒焦点），会话钉在 cabin.main_session_id
// （orchestrator 主对话，C3/C4 单线程）。ChatArea/TuiTranscript/useAgentChat/
// chatStream 全部原样复用。
//
// 舱主对话不是一个「会话」：服务端 listSessions 不返回它（2026-11-13 用户反馈
// 它和左栏某个会话看起来在同步）。但 chat 底座仍需要它的 workspace/title
// （SSE wake 订阅、作业坞标题），所以这里单独取一次，只并进喂给 ChatPane 的
// shared.sessions，不进左栏的会话列表。
//
// 模块导航在悬浮作业坞（原型 DOCK_MOD）：ChatPane 透传 cabinModules 给
// WorkspaceExplorerDock；点模块 → CabinProvider 开浮窗（CabinModulesLayer 全几何）。
// 座舱 attention 的「打开任务」经 octopus:open-task 进来，与桌面同一协议。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  LayoutGrid, PanelLeft, Search, SquarePen,
} from 'lucide-react'
import { useCabins } from '@/hooks/use-cabins'
import type { TaskView } from '@/lib/tasks-api'
import { useRouter } from '@/lib/app-navigation'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { ChatSidebar } from '@/components/agent/chat/chat-sidebar'
import { SidebarResizer } from '@/components/agent/chat/sidebar-resizer'
import { useSidebarWidth } from '@/components/agent/chat/sidebar-width'
import {
  ChatPane,
} from '@/components/agent/chat/ChatPane'
import type { CabinDockModule } from '@/components/workspace/workspace-explorer-dock'
import { useCabinContext } from './cabin-provider'
import { useCabinChatWiring } from './use-cabin-chat-wiring'
import { CabinModulesLayer } from './CabinModulesLayer'
import { CabinAtmosphere } from './CabinAtmosphere'
import { CabinCrew } from './CabinCrew'
import { CabinFleet } from './CabinFleet'
import { useCockpitEntry } from '@/components/cockpit/entry/use-cockpit-entry'
import { useCockpit } from './CockpitProvider'
import { CABIN_DOCK_PRIMARY } from './cabin-meta'

const DOCK_ICONS: Record<string, typeof LayoutGrid> = {
  overview: LayoutGrid,
}

export interface CabinChatHostProps {
  /** 桌面内壳传入：切舱保持在桌面里（不跳 /cabin/:id）。 */
  onSelectCabin?: (id: string) => void
  /** 桌面内壳传入：新建走 pendingCabin hero（不跳 /cabin/new）。 */
  onCreateCabin?: () => void
  /** 桌面内壳传入：退出舱模式回普通对话（入口在左栏作战舱段）。 */
  onExitCabin?: () => void
}

export function CabinChatHost({ onSelectCabin, onCreateCabin, onExitCabin }: CabinChatHostProps = {}) {
  const {
    cabinId, cabin, view, openWindows, minimizedWindows, openModule,
  } = useCabinContext()
  const { setStreaming, setPresenceActive } = useCockpit()
  const { enterCockpit } = useCockpitEntry()
  const router = useRouter()
  const { cabins } = useCabins()

  const [regionNode, setRegionNode] = useState<HTMLDivElement | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 左栏宽度与桌面对话共用（拖动 + 最大 380），不再是写死的 236。
  const { width: sidebarWidth, resizing: resizingSidebar, resizeHandlers } = useSidebarWidth()
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  // 主会话解析 / shared / command / 事件桥（S5 抽出，与全域座舱共用）。
  // 旧舱行为与 DOM 不变：这里拿到的每个字段与抽取前逐字对应。
  const {
    sessionId, setSessionId,
    activeTask, setActiveTask,
    pendingTaskSession, setPendingTaskSession,
    command, issueCommand,
    mainSessionId, shared, handleDeleteSession,
    sessions, sessionsLoading, chatTasks, chatTasksLoading, runningAgents, renameSession,
  } = useCabinChatWiring({ sidebarWidth: sidebarCollapsed ? 0 : sidebarWidth })

  const attachRegion = useCallback((node: HTMLDivElement | null) => {
    setRegionNode(node)
  }, [])

  const noop = useCallback(() => {}, [])

  const runningSessionIds = useMemo(
    () => new Set(runningAgents.map((agent) => agent.id)),
    [runningAgents],
  )

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

  // 舱模块段只属于舱主对话（2026-11-13 用户要求）：舱内从跳转点打开任务线程 /
  // 别的会话时，作业坞退回桌面原样（文件/活动/子代理/调试/消耗 + 任务段）。
  // 舱功能再大改也只动「舱主对话的坞」，成熟功能的坞保持独立。
  const showingCabinThread =
    !activeTask && !pendingTaskSession && !!mainSessionId && sessionId === mainSessionId

  // 汐音只在舱主对话里在场（2026-11-14 用户口径）：左栏点任务 / 别的会话时，
  // 右侧显示的不是舱自己的 chat —— 立绘不出现，也不排主动搭话。
  useEffect(() => { setPresenceActive(showingCabinThread) }, [showingCabinThread, setPresenceActive])

  // classic-v3：坞里舱模块只留「概览」—— 任务/工程/记录都从概览三入口进，
  // 运行/变更/验收在作业详情里。
  const dockModules = useMemo<CabinDockModule[]>(() => CABIN_DOCK_PRIMARY.map((id) => ({
    id,
    label: '概览',
    icon: DOCK_ICONS[id],
    ...moduleState(id),
    attention: id === 'overview' && personCount > 0 && !openWindows.includes(id),
    badge: id === 'overview' ? attentionCount : undefined,
    badgeTone: 'amber' as const,
    onClick: () => openModule(id),
  })), [moduleState, openModule, personCount, attentionCount, openWindows])

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
    onExitCabin,
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
    // 舱内任务行的「⋯」与桌面对话同一套动作：重命名/删除都经 ChatPane 命令执行
    // （2026-11-14 用户反馈：舱里点重命名没反应 —— 之前这两个 prop 没接）。
    onRenameTask: (task: TaskView) => issueCommand({ type: 'rename-task', task }),
    onDeleteTask: (task: TaskView) => issueCommand({ type: 'delete-task', task }),
    searchOpen: sidebarSearchOpen,
    onSearchOpenChange: setSidebarSearchOpen,
  }

  return (
    // min-w-0：这一行是舱壳里的 flex 项，默认自动最小宽度 = 内容最小宽度。
    // 流式回复里出现长 token / 宽工具行时，会把整行（连同编队、作业坞的定位
    // 基准）撑到视口外，回复收拢成折叠 meta 才恢复 —— 2026-11-13 用户实测。
    <div className={cn('ui-font relative flex h-full min-h-0 min-w-0 flex-1', resizingSidebar && 'cursor-col-resize select-none [&_*]:cursor-col-resize')}>
      {/* 全域座舱的**唯一**入口（classic 侧）。方向是单向的：
          这套 classic 界面不因全域而改变任何行为（编队行仍是作业详情窗），
          只有这个按钮把人送到 /cabin/:id/cockpit；那边的「← 返回作战舱」回来。
          右上角在编队面板（top 52 / right 84）与作业坞图标之上，不重叠。 */}
      <button
        type="button"
        data-testid="cabin-enter-cockpit"
        title="进入全域座舱"
        onClick={() => enterCockpit({ cabinId })}
        className="absolute right-3 top-2.5 z-30 inline-flex items-center gap-1 rounded-md border border-white/10 bg-pop-paper/80 px-1.5 py-1 text-[10px] text-pop-dim backdrop-blur transition-colors hover:text-pop-ink"
      >
        ⛶ 全域
      </button>
      {!sidebarCollapsed && (
        <aside
          className="relative hidden shrink-0 border-r border-white/[0.06] md:flex md:flex-col"
          style={{ width: sidebarWidth }}
          data-chat-sidebar
        >
          <ChatSidebar {...sidebarProps} onCollapse={() => setSidebarCollapsed(true)} />
          <SidebarResizer resizing={resizingSidebar} handlers={resizeHandlers} />
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
        data-cabin-thread={showingCabinThread ? 'true' : 'false'}
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
          dockCabinModules={showingCabinThread ? dockModules : undefined}
          dockElevated
          cabinId={cabinId}
          cabinWorkspaceId={cabin?.workspace_id ?? null}
        />
        {showingCabinThread && <CabinFleet />}
        {showingCabinThread && <CabinCrew />}
        <CabinModulesLayer onNewTask={() => issueCommand({ type: 'new-task' })} />
      </div>
    </div>
  )
}