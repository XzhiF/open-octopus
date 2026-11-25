'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  Container,
  Copy,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Search,
  SquarePen,
  Trash2,
  UserRound,
  Workflow,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { AgentSession } from '@/lib/agent/types'
import type { TaskView } from '@/lib/tasks-api'
import type { CabinDetail } from '@/lib/cabin-api'
import { CABIN_STATUS_META } from '@/components/cabin/cabin-meta'
import { CabinDeleteDialog, CabinRenameDialog } from '@/components/cabin/CabinRowDialogs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { cn, copyToClipboard } from '@/lib/utils'

interface ChatSidebarProps {
  tasks: TaskView[]
  tasksLoading: boolean
  activeTaskId: string | null
  onSelectTask: (task: TaskView) => void
  /** Task session being authored, before its draft row exists. `kind` follows
   *  task_spec.kind so the row can show the workflow-dev marker (2026-11-06). */
  pendingTask?: { title: string; kind?: 'workflow-dev' | 'clone-dev' } | null
  activePendingTask?: boolean
  sessions: AgentSession[]
  sessionsLoading: boolean
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  /** Sessions with a live generation stream (running agents). */
  runningSessionIds?: ReadonlySet<string>
  onCreateSession: () => void
  onCreateTask: () => void
  /** workflow-dev task kind (2026-11-06): author a workflow YAML. Optional so
   *  read-only/test renderings keep working without the entry. */
  onCreateWorkflowTask?: () => void
  /** clone-dev task kind (2026-11-25): create/maintain a clone via chat. */
  onCreateCloneTask?: () => void
  onRenameSession: (id: string, title: string) => void
  onDeleteSession: (id: string) => void
  /** Task row management (chat sidebar mirrors the board's rename/delete). */
  onRenameTask?: (task: TaskView) => void
  onDeleteTask?: (task: TaskView) => void
  /** Search filter (controlled: the collapsed rail re-opens it). */
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  /** Desktop-only collapse-to-rail affordance. */
  onCollapse?: () => void
  /** 分屏模式：行内标 L/R，并给未占用的行一个「在另一栏打开」入口。 */
  splitMode?: boolean
  paneOfSession?: (sessionId: string) => 'left' | 'right' | null
  paneOfTask?: (taskId: string) => 'left' | 'right' | null
  onOpenSessionInOther?: (sessionId: string) => void
  onOpenTaskInOther?: (task: TaskView) => void
  /** hover 入口的文案，例如「在右栏打开」（由焦点栏决定）。 */
  openInOtherLabel?: string
  /** 作战舱段（Cabin P2，原型 sidebar 三段：作战舱·任务·会话）。缺省 = 桌面
   *  原样两段，不渲染舱段也不渲染新建舱菜单项。 */
  cabins?: CabinDetail[]
  activeCabinId?: string | null
  onSelectCabin?: (id: string) => void
  onCreateCabin?: () => void
  /** 新建舱草稿行（v4）：跟 pendingTask 同一套语义 —— 呼吸点 + 草稿中 + 悬停 ×。 */
  pendingCabin?: { name: string } | null
  activePendingCabin?: boolean
  /** 点草稿行：回到新建页（草稿还在）。 */
  onOpenDraft?: () => void
  /** 悬停 ×：丢弃草稿（零请求）。 */
  onCancelDraft?: () => void
  /** 舱行「⋯」：重命名（2026-11-15 用户要求，跟任务行同一个手感）。 */
  onRenameCabin?: (cabin: CabinDetail, name: string) => Promise<void>
  /** 舱行「⋯」：删除。软删除 + 确认弹框；`deleteFiles` = 勾了「同时删除本地文件」。 */
  onDeleteCabin?: (cabin: CabinDetail, opts: { deleteFiles: boolean }) => Promise<void>
  /** 桌面舱模式：退出回普通对话（舱段标题右侧的小箭头）。兄弟壳不传。 */
  onExitCabin?: () => void
}

const ROW =
  'group flex h-[30px] w-full cursor-pointer items-center gap-2.5 rounded-[7px] px-2 text-left text-[13px] leading-none transition-colors duration-100'

const STATUS_DOT: Record<string, string> = {
  draft: 'bg-pop-cyan',
  ready: 'bg-pop-navy',
  running: 'bg-pop-green',
  paused: 'bg-pop-dim',
  awaiting_review: 'bg-pop-amber',
  awaiting_archive: 'bg-pop-pink',
  archiving: 'bg-pop-purple',
  done: 'bg-pop-green/50',
  failed: 'bg-pop-red',
  aborted: 'bg-pop-dim',
}

const TASK_SHORT_LABEL: Record<string, string> = {
  draft: '草稿',
  ready: '待执行',
  awaiting_review: '待验收',
  awaiting_archive: '待归档',
  archiving: '归档中',
  done: '完成',
  failed: '失败',
  aborted: '中止',
}

function SectionLabel({ label, count, action }: { label: string; count: number; action?: ReactNode }) {
  return (
    <div className="flex h-7 items-center px-2 pt-3">
      <span className="text-[11px] font-medium text-pop-dim/80">{label}</span>
      <span className="ml-1.5 text-[10.5px] tabular-nums text-pop-dim/45">{count}</span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  )
}

/** 范围：当前舱 / 外部 / 全部。只在有「当前舱」时出现。 */
type CabinScope = 'cabin' | 'external' | 'all'

const SCOPE_LABEL: Record<CabinScope, string> = {
  cabin: '当前舱',
  external: '外部',
  all: '全部',
}

/**
 * 行上的舱归属 chip（2026-11-17）：只在「全部」范围、且这一行真的属于某个舱时
 * 显示。舱外行不挂「外部」牌子 —— 默认就是舱外，逐行重复只会挤掉标题；
 * 规则写在范围开关的 title 里（有 ⌂ = 舱内，没有 = 外部）。
 */
function CabinChip({ cabin, cabinId }: { cabin?: CabinDetail; cabinId: string }) {
  const label = cabin?.name ?? '已归档舱'
  return (
    <span
      data-cabin-chip={cabinId}
      title={`归属作战舱：${cabin?.name ?? cabinId}`}
      className="flex max-w-[78px] shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 text-[9px] leading-[15px] text-pop-dim/80"
    >
      <span aria-hidden className="text-[8px]">⌂</span>
      <span className="truncate">{label}</span>
    </span>
  )
}

function dateLabel(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function RunningPill() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-pop-green/10 px-1.5 py-0.5 text-[9.5px] font-medium text-pop-green">
      <span className="agent-eq" aria-hidden><i /><i /><i /></span>
      运行中
    </span>
  )
}

/** 分屏行标记：这一行当前开在哪一栏（点击行 = 聚焦那一栏）。 */
function PaneMark({ pane }: { pane: 'left' | 'right' }) {
  const label = pane === 'left' ? '已在左栏打开' : '已在右栏打开'
  return (
    <span
      data-pane-mark={pane}
      aria-label={label}
      title={label}
      className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-pop-yellow/40 bg-pop-yellow/12 font-mono text-[9px] font-semibold leading-none text-pop-yellow"
    >
      {pane === 'left' ? 'L' : 'R'}
    </span>
  )
}

/** 行 hover 的「在另一栏打开」——只在分屏时出现。 */
function OpenInOther({
  label,
  onClick,
  group,
}: {
  label: string
  onClick: () => void
  group: 'session' | 'task'
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={`open-in-other-${group}`}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded text-pop-dim opacity-0 transition-all hover:bg-white/[0.08] hover:text-pop-ink',
        group === 'session' ? 'group-hover/session:opacity-100' : 'group-hover/task:opacity-100',
      )}
    >
      <PanelRightOpen className="size-3.5" strokeWidth={1.8} />
    </button>
  )
}

/** 任务类型（2026-11-06 / 2026-11-25）：缺省 = 开发任务；workflow-dev = 工作流开发；clone-dev = 分身开发。 */
type TaskKind = 'workflow-dev' | 'clone-dev' | 'dev'

function taskKindOf(task: TaskView): TaskKind {
  const kind = task.task_spec?.kind
  if (kind === 'workflow-dev') return 'workflow-dev'
  if (kind === 'clone-dev') return 'clone-dev'
  return 'dev'
}

const TASK_KIND_LABEL: Record<TaskKind, string> = {
  'workflow-dev': '工作流开发任务',
  'clone-dev': '分身任务',
  dev: '开发任务',
}

/** 类型标识（用户定稿方案 A）：类型图标 + 状态点各占一列，互不遮挡。
 *  工作流开发用 --pop-purple（与作业坞「工作流」入口同色），开发任务用弱化的
 *  --pop-dim，避免整列都是高饱和。 */
function TaskKindIcon({ kind }: { kind: TaskKind }) {
  const Icon = kind === 'workflow-dev' ? Workflow : kind === 'clone-dev' ? UserRound : ListTodo
  return (
    <span
      aria-hidden
      data-task-kind-icon={kind}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center',
        kind === 'workflow-dev'
          ? 'text-pop-purple'
          : kind === 'clone-dev'
            ? 'text-pop-amber'
            : 'text-pop-dim/70',
      )}
    >
      <Icon className="size-[13px]" strokeWidth={1.9} />
    </span>
  )
}

/** Chat sidebar: one row with the solid "开启新对话" menu (new chat / new
 *  task) + search + collapse, then task + session source lists (hairline rows). */
export function ChatSidebar({
  tasks,
  tasksLoading,
  activeTaskId,
  onSelectTask,
  pendingTask,
  activePendingTask,
  sessions,
  sessionsLoading,
  activeSessionId,
  onSelectSession,
  runningSessionIds,
  onCreateSession,
  onCreateTask,
  onCreateWorkflowTask,
  onCreateCloneTask,
  onRenameSession,
  onDeleteSession,
  onRenameTask,
  onDeleteTask,
  searchOpen,
  onSearchOpenChange,
  onCollapse,
  splitMode = false,
  paneOfSession,
  paneOfTask,
  onOpenSessionInOther,
  onOpenTaskInOther,
  openInOtherLabel,
  cabins,
  activeCabinId,
  onSelectCabin,
  onCreateCabin,
  pendingCabin,
  activePendingCabin,
  onOpenDraft,
  onCancelDraft,
  onRenameCabin,
  onDeleteCabin,
  onExitCabin,
}: ChatSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  // 舱行的两个弹框：null = 关着。
  const [cabinRenameTarget, setCabinRenameTarget] = useState<CabinDetail | null>(null)
  const [cabinDeleteTarget, setCabinDeleteTarget] = useState<CabinDetail | null>(null)
  const [cabinBusy, setCabinBusy] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  // 菜单关闭时 Radix 会把焦点还给「⋯」触发器；正在进入行内重命名时不能还，
  // 否则输入框刚挂载就被夺焦 → onBlur 立刻提交（2026-11-14 用户反馈：重命名没反应）。
  const renameFocusPendingRef = useRef(false)
  const renameInFlightRef = useRef(false)
  // 行内改名刚打开的前 250ms 里，菜单关闭动画会把焦点来回搬一次；那一下
  // blur 不是「用户离开输入框」，不能当成提交（否则输入框刚出现就消失）。
  const editStartedAtRef = useRef(0)
  // Task-author clone sessions live in the task group, never in the chat list.
  // 2026-10-28: 被任务绑定的主会话也不出现在会话列表 —— 它就是任务线程本体，
  // 再挂一块"会话"牌子会让人以为是两个对话（切换中间历史"不变化"的困惑来源）。
  const boundSessionIds = useMemo(
    () =>
      new Set(
        tasks
          .map((task) => task.source_chat_session_id)
          .filter((id): id is string => !!id),
      ),
    [tasks],
  )
  const visibleSessions = sessions.filter(
    (session) => !session.clone_name && !boundSessionIds.has(session.id),
  )

  // 归属范围（2026-11-17）：舱内默认只看本舱；「外部」= 不属于任何舱的活动；
  // 「全部」= 不筛，行上补一枚舱 chip。归属是写一次的服务端字段（tasks /
  // sessions.cabin_id），这里只做视图过滤，不推算。
  const [scope, setScope] = useState<CabinScope>('cabin')
  useEffect(() => { setScope('cabin') }, [activeCabinId])
  const scopeEligible = !!activeCabinId && !!cabins
  const cabinById = useMemo(
    () => new Map((cabins ?? []).map((cabin) => [cabin.id, cabin] as const)),
    [cabins],
  )
  const inScope = (cabinId?: string | null) => {
    if (!scopeEligible || scope === 'all') return true
    if (scope === 'cabin') return cabinId === activeCabinId
    return !cabinId
  }
  const scopedTasks = tasks.filter((task) => inScope(task.cabin_id))
  const scopedSessions = visibleSessions.filter((session) => inScope(session.cabin_id))

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  // 行内重命名：焦点交给输入框并全选。菜单关闭动画的焦点回收是异步的，
  // 这里多补两次 focus，保证最终焦点落在输入框上。
  useEffect(() => {
    if (!editingId) return
    const timers = [0, 60, 160].map((delay) => window.setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, delay))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [editingId])

  const closeSearch = () => {
    setQuery('')
    onSearchOpenChange(false)
  }

  const needle = query.trim().toLowerCase()
  const filteredTasks = needle
    ? scopedTasks.filter((task) => task.name.toLowerCase().includes(needle))
    : scopedTasks
  const pendingMatches = !!pendingTask && (!needle || pendingTask.title.toLowerCase().includes(needle))
  const pendingKind: TaskKind =
    pendingTask?.kind === 'workflow-dev' ? 'workflow-dev' : pendingTask?.kind === 'clone-dev' ? 'clone-dev' : 'dev'
  const filteredSessions = needle
    ? scopedSessions.filter((session) => session.title.toLowerCase().includes(needle))
    : scopedSessions
  // 「当前舱」范围下，被折叠掉的活动数（其它舱 + 外部）。不做静默隐藏：给一个
  // 可点的出口，避免以后找不到 CLI / 调度跑出来的东西。
  const outsideCount = scopeEligible && scope === 'cabin'
    ? tasks.filter((task) => task.cabin_id !== activeCabinId).length
      + visibleSessions.filter((session) => session.cabin_id !== activeCabinId).length
    : 0
  const filteredCabins = useMemo(() => {
    if (!cabins) return []
    return needle ? cabins.filter((c) => c.name.toLowerCase().includes(needle)) : cabins
  }, [cabins, needle])
  // 新建舱草稿行（v4）：跟 pendingTask 一样参与搜索与计数。
  const pendingCabinMatches = !!pendingCabin && (!needle || pendingCabin.name.toLowerCase().includes(needle))

  const confirmRename = async () => {
    if (renameInFlightRef.current) return
    const id = editingId
    const next = editTitle.trim()
    setEditingId(null)
    if (!id || !next) return
    renameInFlightRef.current = true
    try {
      await onRenameSession(id, next)
    } finally {
      renameInFlightRef.current = false
    }
  }

  const beginRename = (id: string, title: string) => {
    editStartedAtRef.current = Date.now()
    renameFocusPendingRef.current = true
    // 兜底：onCloseAutoFocus 万一没来（菜单被外部卸载），别让标记永久挂着。
    window.setTimeout(() => { renameFocusPendingRef.current = false }, 500)
    setEditingId(id)
    setEditTitle(title)
  }

  const handleRenameBlur = () => {
    if (Date.now() - editStartedAtRef.current < 250) {
      // 菜单关闭时的焦点回收，不是用户离开：把焦点还回去，别提交。
      renameInputRef.current?.focus()
      return
    }
    void confirmRename()
  }

  const copyName = async (name: string) => {
    const shown = name.trim()
    if (!shown) return
    // copyToClipboard 在非安全上下文（局域网 HTTP）会直接返回 false，
    // 那里 navigator.clipboard 也不可用 —— 给一次明确的失败提示，不静默。
    if (copyToClipboard(shown)) {
      toast.success('名称已复制', { duration: 1500 })
      return
    }
    try {
      await navigator.clipboard.writeText(shown)
      toast.success('名称已复制', { duration: 1500 })
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  // ── 舱行：重命名 / 删除（2026-11-15）──────────────────────────────
  // 写库交给宿主（CabinChatHost）：它知道要不要刷新当前舱、删的是不是当前舱。
  const confirmCabinRename = async (name: string) => {
    const target = cabinRenameTarget
    if (!target || cabinBusy) return
    setCabinBusy(true)
    try {
      await onRenameCabin?.(target, name)
      setCabinRenameTarget(null)
      toast.success('作战舱已重命名')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setCabinBusy(false)
    }
  }

  const confirmCabinDelete = async (opts: { deleteFiles: boolean }) => {
    const target = cabinDeleteTarget
    if (!target || cabinBusy) return
    setCabinBusy(true)
    try {
      await onDeleteCabin?.(target, opts)
      setCabinDeleteTarget(null)
      toast.success('作战舱已删除（历史与计费保留）')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setCabinBusy(false)
    }
  }

  return (
    <div className="ui-font flex h-full min-h-0 flex-col bg-pop-idle">
      <div className="flex h-11 shrink-0 items-center gap-1.5 px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="sidebar-new"
              className="relative flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[8px] bg-white/[0.09] text-[12px] font-medium text-pop-ink transition-colors hover:bg-white/[0.14] active:bg-white/[0.17]"
            >
              <SquarePen className="size-[13px]" strokeWidth={1.8} />
              <span className="truncate">开启新对话</span>
              <ChevronDown
                className="absolute right-2 size-3 text-pop-dim"
                strokeWidth={1.8}
                aria-hidden
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="w-56">
            <DropdownMenuItem onClick={onCreateSession} className="gap-2.5 py-2">
              <MessageSquare className="size-3.5 shrink-0 text-pop-dim" strokeWidth={1.8} />
              <span className="flex flex-col">
                <span className="text-[12.5px] text-pop-ink">新建对话</span>
                <span className="text-[10.5px] text-pop-dim">与主 Agent 对话</span>
              </span>
            </DropdownMenuItem>
            {onCreateCabin && (
              <DropdownMenuItem
                onClick={onCreateCabin}
                data-testid="sidebar-new-cabin"
                className="gap-2.5 bg-pop-yellow/10 py-2 focus:bg-pop-yellow/15"
              >
                <Container className="size-3.5 shrink-0 text-pop-yellow" strokeWidth={1.8} />
                <span className="flex flex-col">
                  <span className="text-[12.5px] font-semibold text-pop-yellow">新建作战舱</span>
                  <span className="text-[10.5px] text-pop-dim">目录级长期开发 · agent 在对话里初始化</span>
                </span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onCreateTask} className="gap-2.5 py-2">
              <ListTodo className="size-3.5 shrink-0 text-pop-dim" strokeWidth={1.8} />
              <span className="flex flex-col">
                <span className="text-[12.5px] text-pop-ink">新建开发任务</span>
                <span className="text-[10.5px] text-pop-dim">从任务作者开始，AI 总结标题</span>
              </span>
            </DropdownMenuItem>
            {onCreateWorkflowTask && (
              <DropdownMenuItem onClick={onCreateWorkflowTask} className="gap-2.5 py-2">
                <Workflow className="size-3.5 shrink-0 text-pop-dim" strokeWidth={1.8} />
                <span className="flex flex-col">
                  <span className="text-[12.5px] text-pop-ink">工作流开发</span>
                  <span className="text-[10.5px] text-pop-dim">从工作流开发者开始，产出可运行的 YAML</span>
                </span>
              </DropdownMenuItem>
            )}
            {onCreateCloneTask && (
              <DropdownMenuItem onClick={onCreateCloneTask} className="gap-2.5 py-2">
                <UserRound className="size-3.5 shrink-0 text-pop-dim" strokeWidth={1.8} />
                <span className="flex flex-col">
                  <span className="text-[12.5px] text-pop-ink">新建分身任务</span>
                  <span className="text-[10.5px] text-pop-dim">从铸分身者开始，对话产出可用的分身</span>
                </span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          aria-label="搜索对话"
          title="搜索对话"
          aria-pressed={searchOpen}
          onClick={() => (searchOpen ? closeSearch() : onSearchOpenChange(true))}
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-md transition-colors',
            searchOpen
              ? 'bg-white/[0.08] text-pop-ink'
              : 'text-pop-dim hover:bg-white/[0.06] hover:text-pop-ink',
          )}
        >
          <Search className="size-[15px]" strokeWidth={1.8} />
        </button>
        {onCollapse && (
          <button
            type="button"
            aria-label="收起侧栏"
            title="收起侧栏"
            onClick={onCollapse}
            className="grid size-7 shrink-0 place-items-center rounded-md text-pop-dim transition-colors hover:bg-white/[0.06] hover:text-pop-ink"
          >
            <PanelLeftClose className="size-[15px]" strokeWidth={1.8} />
          </button>
        )}
      </div>

      {searchOpen && (
        <div className="shrink-0 px-3 pb-1.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-pop-dim/70"
              strokeWidth={1.8}
            />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeSearch()
              }}
              placeholder="搜索任务与对话…"
              aria-label="搜索任务与对话"
              data-testid="chat-sidebar-search"
              maxLength={120}
              className="h-[30px] w-full rounded-[8px] border border-white/[0.08] bg-white/[0.04] pl-8 pr-7 text-[12.5px] text-pop-ink outline-none transition-colors placeholder:text-pop-dim/60 focus:border-pop-yellow/40"
            />
            {query && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => {
                  setQuery('')
                  searchInputRef.current?.focus()
                }}
                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-pop-dim transition-colors hover:text-pop-ink"
              >
                <X className="size-3.5" strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>
      )}

      {scopeEligible && (
        <div className="shrink-0 px-3 pb-1.5" data-testid="chat-scope-switch">
          <div className="flex items-center gap-0.5 rounded-[8px] border border-white/[0.06] bg-white/[0.02] p-0.5">
            {(['cabin', 'external', 'all'] as const).map((id) => (
              <button
                key={id}
                type="button"
                data-scope={id}
                data-active={scope === id ? 'true' : undefined}
                title={id === 'cabin'
                  ? `只看当前作战舱${cabinById.get(activeCabinId!) ? `：${cabinById.get(activeCabinId!)!.name}` : ''}`
                  : id === 'external' ? '只看不属于任何作战舱的活动' : '全部活动（带 ⌂ 的是舱内，没有标识的是外部）'}
                onClick={() => setScope(id)}
                className={cn(
                  'h-[22px] flex-1 rounded-[6px] text-[11px] transition-colors',
                  scope === id
                    ? 'bg-white/[0.08] text-pop-ink'
                    : 'text-pop-dim hover:text-pop-ink',
                )}
              >
                {SCOPE_LABEL[id]}
              </button>
            ))}
          </div>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <div className="px-2.5 pb-4">
          {cabins && (
            <div data-testid="cabin-section">
              <SectionLabel
                label="作战舱"
                count={filteredCabins.length + (pendingCabinMatches ? 1 : 0)}
                action={onCreateCabin || onExitCabin ? (
                  <span className="flex items-center gap-0.5">
                    {onExitCabin && (
                      <button
                        type="button"
                        data-testid="cabin-section-exit"
                        title="返回普通对话"
                        aria-label="返回普通对话"
                        onClick={onExitCabin}
                        className="grid size-5 place-items-center rounded text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
                      >
                        <ArrowLeft className="size-3.5" strokeWidth={1.8} />
                      </button>
                    )}
                    {onCreateCabin && (
                      <button
                        type="button"
                        data-testid="cabin-section-new"
                        title="新建作战舱"
                        aria-label="新建作战舱"
                        onClick={onCreateCabin}
                        className="grid size-5 place-items-center rounded text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink"
                      >
                        <Plus className="size-3.5" strokeWidth={1.8} />
                      </button>
                    )}
                  </span>
                ) : undefined}
              />
              {filteredCabins.length === 0 && !pendingCabinMatches ? (
                <p className="px-2 py-1 text-[12px] text-pop-dim/60">
                  {needle ? '未找到匹配作战舱' : '暂无作战舱'}
                </p>
              ) : (
                <div className="space-y-px">
                  {/* 新建舱草稿行（v4）：跟任务段的 pendingTask 同一个语义 ——
                      呼吸点 + 名字 + 草稿中 + 悬停 ×（丢弃，零请求）。 */}
                  {pendingCabin && pendingCabinMatches && (
                    <div className="group/draftcabin relative">
                      <button
                        type="button"
                        data-testid="pending-cabin-item"
                        aria-current={activePendingCabin ? 'page' : undefined}
                        title={`${pendingCabin.name} · 还没创建，可以先放一放`}
                        onClick={() => onOpenDraft?.()}
                        className={cn(
                          ROW,
                          'gap-2 pr-7',
                          activePendingCabin
                            ? 'bg-white/[0.07] text-pop-ink shadow-[inset_2px_0_0_var(--pop-cyan)]'
                            : 'text-pop-ink/80 hover:bg-white/[0.035] hover:text-pop-ink',
                        )}
                      >
                        <span className="relative flex size-[6px] shrink-0">
                          <span className="absolute size-[6px] animate-ping rounded-full bg-pop-cyan/70" />
                          <span className="relative size-[6px] rounded-full bg-pop-cyan" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{pendingCabin.name}</span>
                        <span className="shrink-0 text-[10px] text-pop-dim">草稿中</span>
                      </button>
                      {onCancelDraft && (
                        <button
                          type="button"
                          aria-label="丢弃草稿"
                          title="丢弃草稿"
                          data-testid="pending-cabin-cancel"
                          onClick={(event) => {
                            event.stopPropagation()
                            onCancelDraft()
                          }}
                          className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-pop-dim opacity-0 transition-all hover:bg-white/[0.08] hover:text-pop-ink group-hover/draftcabin:opacity-100"
                        >
                          <X className="size-3" strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  )}
                  {filteredCabins.map((c) => {
                    const meta = CABIN_STATUS_META[c.status]
                    const active = activeCabinId === c.id
                    // 行菜单（2026-11-15）：跟任务行同一套 —— 悬停出「⋯」，
                    // 点开是 重命名 / 复制名称 / 删除。
                    const manageable = !!onRenameCabin || !!onDeleteCabin
                    return (
                      <div key={c.id} className="group/cabin relative">
                        <button
                          type="button"
                          data-cabin-row={c.id}
                          aria-current={active ? 'page' : undefined}
                          title={`${c.name} · ${meta.label}`}
                          onClick={() => onSelectCabin?.(c.id)}
                          className={cn(
                            ROW,
                            'gap-2',
                            manageable && 'pr-7',
                            active ? 'bg-white/[0.07] text-pop-ink' : 'text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
                          )}
                        >
                          <Container className="size-[13px] shrink-0 text-pop-yellow/80" strokeWidth={1.9} />
                          <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                          {/* 悬停让位给「⋯」，不然状态字和按钮会叠在一起 */}
                          <span
                            className={cn(
                              'shrink-0 text-[9.5px] text-pop-dim/70',
                              manageable && 'group-hover/cabin:opacity-0',
                            )}
                          >
                            {meta.label}
                          </span>
                        </button>
                        {manageable && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label={`作战舱操作 ${c.name}`}
                                title="作战舱操作"
                                data-testid="cabin-row-menu"
                                onClick={(event) => event.stopPropagation()}
                                className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-pop-dim opacity-0 transition-all hover:bg-white/[0.08] hover:text-pop-ink group-hover/cabin:opacity-100"
                              >
                                <MoreHorizontal className="size-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                              {onRenameCabin && (
                                <DropdownMenuItem
                                  data-testid="cabin-row-rename"
                                  onClick={() => setCabinRenameTarget(c)}
                                  className="gap-2"
                                >
                                  <Pencil className="size-3.5" /> 重命名
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => void copyName(c.name)} className="gap-2">
                                <Copy className="size-3.5" /> 复制名称
                              </DropdownMenuItem>
                              {onDeleteCabin && (
                                <DropdownMenuItem
                                  data-testid="cabin-row-delete"
                                  onClick={() => setCabinDeleteTarget(c)}
                                  className="gap-2 text-pop-red focus:text-pop-red"
                                >
                                  <Trash2 className="size-3.5" /> 删除
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          <div data-testid="task-session-section">
            <SectionLabel
              label="任务"
              count={filteredTasks.length + (pendingMatches ? 1 : 0)}
            />
            {tasksLoading && !pendingTask ? (
              <div className="space-y-0.5 px-0.5">
                <Skeleton className="h-[30px] w-full rounded-[7px]" />
                <Skeleton className="h-[30px] w-full rounded-[7px]" />
              </div>
            ) : filteredTasks.length === 0 && !pendingMatches ? (
              <p className="px-2 py-1 text-[12px] text-pop-dim/60">
                {needle
                  ? '未找到匹配任务'
                  : scopeEligible && scope === 'cabin'
                    ? '当前舱暂无任务'
                    : scopeEligible && scope === 'external'
                      ? '没有舱外任务'
                      : '暂无任务'}
              </p>
            ) : (
              <div className="space-y-px">
                {pendingTask && pendingMatches && (
                  <button
                    type="button"
                    data-testid="pending-task-item"
                    data-task-kind={pendingKind}
                    aria-current={activePendingTask ? 'page' : undefined}
                    title={`${TASK_KIND_LABEL[pendingKind]} · 等待第一句话`}
                    className={cn(
                      ROW,
                      'gap-2',
                      activePendingTask
                        ? 'bg-white/[0.07] text-pop-ink'
                        : 'text-pop-ink/80 hover:bg-white/[0.035] hover:text-pop-ink',
                    )}
                  >
                    <TaskKindIcon kind={pendingKind} />
                    <span className="relative flex size-[6px] shrink-0">
                      <span className="absolute size-[6px] animate-ping rounded-full bg-pop-cyan/70" />
                      <span className="relative size-[6px] rounded-full bg-pop-cyan" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{pendingTask.title}</span>
                    <span className="shrink-0 text-[10px] text-pop-dim">草稿中</span>
                  </button>
                )}
                {filteredTasks.map((task) => {
                  const active = activeTaskId === task.id
                  const kind = taskKindOf(task)
                  const paneMark = paneOfTask?.(task.id) ?? null
                  const running =
                    task.status === 'running' ||
                    (!!task.source_chat_session_id &&
                      !!runningSessionIds?.has(task.source_chat_session_id))
                  return (
                    <div key={task.id} className="group/task relative">
                      <button
                        type="button"
                        data-testid="task-session-item"
                        data-task-id={task.id}
                        data-task-status={task.status}
                        data-task-kind={kind}
                        data-running-task={running ? 'true' : undefined}
                        data-pane={paneMark ?? undefined}
                        aria-current={active ? 'page' : undefined}
                        title={running
                          ? `${task.name} · ${TASK_KIND_LABEL[kind]} · Agent 运行中`
                          : `${task.name} · ${TASK_KIND_LABEL[kind]}`}
                        onClick={() => onSelectTask(task)}
                        className={cn(
                          ROW,
                          'gap-2',
                          splitMode ? 'pr-12' : 'pr-7',
                          active
                            ? 'bg-white/[0.07] text-pop-ink'
                            : 'text-pop-ink/80 hover:bg-white/[0.035] hover:text-pop-ink',
                        )}
                      >
                        <TaskKindIcon kind={kind} />
                        <span
                          className={cn(
                            'size-[6px] shrink-0 rounded-full',
                            STATUS_DOT[task.status] ?? 'bg-pop-amber',
                            !active && 'opacity-70',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{task.name}</span>
                        {scopeEligible && scope === 'all' && task.cabin_id && (
                          <CabinChip
                            cabinId={task.cabin_id}
                            cabin={cabinById.get(task.cabin_id)}
                          />
                        )}
                        {running && <RunningPill />}
                        {paneMark ? (
                          <PaneMark pane={paneMark} />
                        ) : !splitMode && TASK_SHORT_LABEL[task.status] ? (
                          <span className="shrink-0 text-[10px] text-pop-dim">
                            {TASK_SHORT_LABEL[task.status]}
                          </span>
                        ) : null}
                      </button>
                      {splitMode && !paneMark && onOpenTaskInOther && openInOtherLabel && (
                        <div className="absolute right-6 top-1/2 -translate-y-1/2">
                          <OpenInOther
                            group="task"
                            label={openInOtherLabel}
                            onClick={() => onOpenTaskInOther(task)}
                          />
                        </div>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`任务操作 ${task.name}`}
                            data-testid="task-session-menu"
                            onClick={(event) => event.stopPropagation()}
                            className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-pop-dim opacity-0 transition-all hover:bg-white/[0.08] hover:text-pop-ink group-hover/task:opacity-100"
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                          <DropdownMenuItem
                            onClick={() => onRenameTask?.(task)}
                            className="gap-2"
                          >
                            <Pencil className="size-3.5" /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void copyName(task.name)}
                            className="gap-2"
                          >
                            <Copy className="size-3.5" /> 复制名称
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onDeleteTask?.(task)}
                            className="gap-2 text-pop-red focus:text-pop-red"
                          >
                            <Trash2 className="size-3.5" /> 删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <SectionLabel label="会话" count={filteredSessions.length} />
          {sessionsLoading ? (
            <div className="space-y-0.5 px-0.5">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-[30px] w-full rounded-[7px]" />
              ))}
            </div>
          ) : filteredSessions.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-pop-dim/60">
              {needle
                ? '未找到匹配对话'
                : scopeEligible && scope === 'cabin'
                  ? '当前舱暂无对话'
                  : scopeEligible && scope === 'external'
                    ? '没有舱外对话'
                    : '暂无对话'}
            </p>
          ) : (
            <nav aria-label="会话列表" className="space-y-px">
              {filteredSessions.map((session) => {
                const active = activeSessionId === session.id
                const running = !!runningSessionIds?.has(session.id)
                const paneMark = paneOfSession?.(session.id) ?? null
                return (
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    title={running ? `${session.title} · Agent 运行中` : session.title}
                    data-session-id={session.id}
                    data-running-session={running ? 'true' : undefined}
                    data-pane={paneMark ?? undefined}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelectSession(session.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onSelectSession(session.id)
                    }}
                    className={cn(
                      ROW,
                      'group/session gap-2',
                      active
                        ? 'bg-white/[0.07] text-pop-ink'
                        : 'text-pop-ink/80 hover:bg-white/[0.035] hover:text-pop-ink',
                    )}
                  >
                    {/* 会话行图标（2026-11-06 用户定稿方案 A）：与任务行类型图标
                        同槽位同尺寸，只补节奏不新增语义；运行中仍由右侧药丸表示。 */}
                    <span
                      data-session-icon="chat"
                      className="flex size-4 shrink-0 items-center justify-center text-pop-dim/70"
                    >
                      <MessageSquare className="size-[13px]" strokeWidth={1.9} aria-hidden />
                    </span>
                    {running && <span className="sr-only">Agent 运行中</span>}
                    <div className="flex min-w-0 flex-1 items-center">
                      {editingId === session.id ? (
                        <input
                          ref={renameInputRef}
                          autoFocus
                          value={editTitle}
                          onChange={(event) => setEditTitle(event.target.value)}
                          onBlur={handleRenameBlur}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void confirmRename()
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                          onClick={(event) => event.stopPropagation()}
                          className="w-full border-b border-pop-yellow bg-transparent text-[13px] text-pop-ink outline-none"
                          maxLength={200}
                        />
                      ) : (
                        <span className="truncate">{session.title}</span>
                      )}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      {scopeEligible && scope === 'all' && session.cabin_id && (
                        <CabinChip
                          cabinId={session.cabin_id}
                          cabin={cabinById.get(session.cabin_id)}
                        />
                      )}
                      {running ? (
                        <RunningPill />
                      ) : !splitMode ? (
                        <span className="text-[10.5px] tabular-nums text-pop-dim/50 group-hover/session:hidden">
                          {dateLabel(session.last_message_at)}
                        </span>
                      ) : null}
                      {paneMark ? (
                        <PaneMark pane={paneMark} />
                      ) : splitMode && onOpenSessionInOther && openInOtherLabel ? (
                        <OpenInOther
                          group="session"
                          label={openInOtherLabel}
                          onClick={() => onOpenSessionInOther(session.id)}
                        />
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="grid size-5 place-items-center rounded text-pop-dim opacity-0 transition-all hover:bg-white/[0.08] hover:text-pop-ink group-hover:opacity-100"
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`会话操作 ${session.title}`}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          side="bottom"
                          sideOffset={4}
                          onCloseAutoFocus={(event) => {
                            if (!renameFocusPendingRef.current) return
                            renameFocusPendingRef.current = false
                            // 焦点直接交给行内输入框：让 Radix 的「还焦点给触发器」
                            // 收不到这次焦点，输入框也就不会被立刻 blur 掉。
                            event.preventDefault()
                            renameInputRef.current?.focus()
                            renameInputRef.current?.select()
                          }}
                        >
                          <DropdownMenuItem
                            onClick={() => beginRename(session.id, session.title)}
                          >
                            <Pencil className="mr-2 size-3.5" />
                            重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void copyName(session.title)}>
                            <Copy className="mr-2 size-3.5" />
                            复制名称
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(session.id)}
                          >
                            <Trash2 className="mr-2 size-3.5" />
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                )
              })}
            </nav>
          )}
          {outsideCount > 0 && (
            <button
              type="button"
              data-testid="chat-scope-outside"
              onClick={() => setScope('all')}
              className="mt-1 flex w-full items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-left text-[11px] text-pop-dim/70 transition-colors hover:bg-white/[0.035] hover:text-pop-ink"
            >
              <span className="text-pop-dim/50">另有</span>
              <b className="font-medium tabular-nums">{outsideCount}</b>
              <span>条舱外活动 · 看全部</span>
            </button>
          )}
        </div>
      </ScrollArea>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="删除会话"
        description="删除后无法恢复，确认删除此会话？"
        confirmLabel="删除"
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) onDeleteSession(deleteTarget)
          setDeleteTarget(null)
        }}
      />

      <CabinRenameDialog
        cabin={cabinRenameTarget}
        busy={cabinBusy}
        onClose={() => { if (!cabinBusy) setCabinRenameTarget(null) }}
        onSubmit={(name) => void confirmCabinRename(name)}
      />

      <CabinDeleteDialog
        cabin={cabinDeleteTarget}
        busy={cabinBusy}
        onClose={() => { if (!cabinBusy) setCabinDeleteTarget(null) }}
        onConfirm={(opts) => void confirmCabinDelete(opts)}
      />
    </div>
  )
}
