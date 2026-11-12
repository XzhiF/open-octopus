'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Container,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelRightOpen,
  Pencil,
  Search,
  SquarePen,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import type { AgentSession } from '@/lib/agent/types'
import type { TaskView } from '@/lib/tasks-api'
import type { CabinDetail } from '@/lib/cabin-api'
import { CABIN_STATUS_META } from '@/components/cabin/cabin-meta'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { cn } from '@/lib/utils'

interface ChatSidebarProps {
  tasks: TaskView[]
  tasksLoading: boolean
  activeTaskId: string | null
  onSelectTask: (task: TaskView) => void
  /** Task session being authored, before its draft row exists. `kind` follows
   *  task_spec.kind so the row can show the workflow-dev marker (2026-11-06). */
  pendingTask?: { title: string; kind?: 'workflow-dev' } | null
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
  /** 工作舱段（Cabin P2，原型 sidebar 三段：工作舱·任务·会话）。缺省 = 桌面
   *  原样两段，不渲染舱段也不渲染新建舱菜单项。 */
  cabins?: CabinDetail[]
  activeCabinId?: string | null
  onSelectCabin?: (id: string) => void
  onCreateCabin?: () => void
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

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex h-7 items-center px-2 pt-3">
      <span className="text-[11px] font-medium text-pop-dim/80">{label}</span>
      <span className="ml-1.5 text-[10.5px] tabular-nums text-pop-dim/45">{count}</span>
    </div>
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

/** 任务类型（2026-11-06）：缺省 = 开发任务；workflow-dev = 工作流开发。 */
type TaskKind = 'workflow-dev' | 'dev'

function taskKindOf(task: TaskView): TaskKind {
  return task.task_spec?.kind === 'workflow-dev' ? 'workflow-dev' : 'dev'
}

const TASK_KIND_LABEL: Record<TaskKind, string> = {
  'workflow-dev': '工作流开发任务',
  dev: '开发任务',
}

/** 类型标识（用户定稿方案 A）：类型图标 + 状态点各占一列，互不遮挡。
 *  工作流开发用 --pop-purple（与作业坞「工作流」入口同色），开发任务用弱化的
 *  --pop-dim，避免整列都是高饱和。 */
function TaskKindIcon({ kind }: { kind: TaskKind }) {
  const Icon = kind === 'workflow-dev' ? Workflow : ListTodo
  return (
    <span
      aria-hidden
      data-task-kind-icon={kind}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center',
        kind === 'workflow-dev' ? 'text-pop-purple' : 'text-pop-dim/70',
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
}: ChatSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
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

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const closeSearch = () => {
    setQuery('')
    onSearchOpenChange(false)
  }

  const needle = query.trim().toLowerCase()
  const filteredTasks = needle
    ? tasks.filter((task) => task.name.toLowerCase().includes(needle))
    : tasks
  const pendingMatches = !!pendingTask && (!needle || pendingTask.title.toLowerCase().includes(needle))
  const pendingKind: TaskKind = pendingTask?.kind === 'workflow-dev' ? 'workflow-dev' : 'dev'
  const filteredSessions = needle
    ? visibleSessions.filter((session) => session.title.toLowerCase().includes(needle))
    : visibleSessions
  const filteredCabins = useMemo(() => {
    if (!cabins) return []
    return needle ? cabins.filter((c) => c.name.toLowerCase().includes(needle)) : cabins
  }, [cabins, needle])

  const confirmRename = async () => {
    if (editingId && editTitle.trim()) {
      await onRenameSession(editingId, editTitle.trim())
    }
    setEditingId(null)
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
                  <span className="text-[12.5px] font-semibold text-pop-yellow">新建工作舱</span>
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

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <div className="px-2.5 pb-4">
          {cabins && (
            <div data-testid="cabin-section">
              <SectionLabel label="工作舱" count={filteredCabins.length} />
              {filteredCabins.length === 0 ? (
                <p className="px-2 py-1 text-[12px] text-pop-dim/60">
                  {needle ? '未找到匹配工作舱' : '暂无工作舱'}
                </p>
              ) : (
                <div className="space-y-px">
                  {filteredCabins.map((c) => {
                    const meta = CABIN_STATUS_META[c.status]
                    const active = activeCabinId === c.id
                    return (
                      <button
                        key={c.id}
                        type="button"
                        data-cabin-row={c.id}
                        aria-current={active ? 'page' : undefined}
                        title={`${c.name} · ${meta.label}`}
                        onClick={() => onSelectCabin?.(c.id)}
                        className={cn(
                          ROW,
                          'gap-2',
                          active ? 'bg-white/[0.07] text-pop-ink' : 'text-pop-dim hover:bg-white/[0.04] hover:text-pop-ink',
                        )}
                      >
                        <Container className="size-[13px] shrink-0 text-pop-yellow/80" strokeWidth={1.9} />
                        <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="shrink-0 text-[9.5px] text-pop-dim/70">{meta.label}</span>
                      </button>
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
                {needle ? '未找到匹配任务' : '暂无任务'}
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
              {needle ? '未找到匹配对话' : '暂无对话'}
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
                          autoFocus
                          value={editTitle}
                          onChange={(event) => setEditTitle(event.target.value)}
                          onBlur={confirmRename}
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
                    <div className="ml-auto flex shrink-0 items-center">
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
                        <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
                          <DropdownMenuItem
                            onClick={() => {
                              setEditingId(session.id)
                              setEditTitle(session.title)
                            }}
                          >
                            <Pencil className="mr-2 size-3.5" />
                            重命名
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
    </div>
  )
}
