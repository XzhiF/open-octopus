'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ListTodo,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import type { AgentSession } from '@/lib/agent/types'
import type { TaskView } from '@/lib/tasks-api'
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
  /** Task session being authored, before its draft row exists. */
  pendingTask?: { sessionId: string; title: string } | null
  activePendingTask?: boolean
  sessions: AgentSession[]
  sessionsLoading: boolean
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  /** Sessions with a live generation stream (running agents). */
  runningSessionIds?: ReadonlySet<string>
  onCreateSession: () => void
  onCreateTask: () => void
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
}

const ROW =
  'group flex h-[30px] w-full items-center gap-2.5 rounded-[7px] px-2 text-left text-[13px] leading-none transition-colors duration-100'

const STATUS_DOT: Record<string, string> = {
  draft: 'bg-pop-cyan',
  ready: 'bg-pop-navy',
  running: 'bg-pop-green',
  paused: 'bg-pop-dim',
  awaiting_review: 'bg-pop-amber',
  archiving: 'bg-pop-purple',
  done: 'bg-pop-green/50',
  failed: 'bg-pop-red',
  aborted: 'bg-pop-dim',
}

const TASK_SHORT_LABEL: Record<string, string> = {
  draft: '草稿',
  ready: '待执行',
  awaiting_review: '待验收',
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
  onRenameSession,
  onDeleteSession,
  onRenameTask,
  onDeleteTask,
  searchOpen,
  onSearchOpenChange,
  onCollapse,
}: ChatSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Task-author clone sessions live in the task group, never in the chat list.
  const visibleSessions = sessions.filter((session) => !session.clone_name)

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
  const filteredSessions = needle
    ? visibleSessions.filter((session) => session.title.toLowerCase().includes(needle))
    : visibleSessions

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
            <DropdownMenuItem onClick={onCreateTask} className="gap-2.5 py-2">
              <ListTodo className="size-3.5 shrink-0 text-pop-dim" strokeWidth={1.8} />
              <span className="flex flex-col">
                <span className="text-[12.5px] text-pop-ink">新建任务</span>
                <span className="text-[10.5px] text-pop-dim">从任务作者开始，首句即标题</span>
              </span>
            </DropdownMenuItem>
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
                    aria-current={activePendingTask ? 'page' : undefined}
                    title="新任务 · 等待第一句话"
                    className={cn(
                      ROW,
                      activePendingTask
                        ? 'bg-white/[0.07] text-pop-ink'
                        : 'text-pop-ink/80 hover:bg-white/[0.035] hover:text-pop-ink',
                    )}
                  >
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
                        data-running-task={running ? 'true' : undefined}
                        aria-current={active ? 'page' : undefined}
                        title={running ? `${task.name} · Agent 运行中` : task.name}
                        onClick={() => onSelectTask(task)}
                        className={cn(
                          ROW,
                          'pr-7',
                          active
                            ? 'bg-white/[0.07] text-pop-ink'
                            : 'text-pop-ink/80 hover:bg-white/[0.035] hover:text-pop-ink',
                        )}
                      >
                        <span
                          className={cn(
                            'size-[6px] shrink-0 rounded-full',
                            STATUS_DOT[task.status] ?? 'bg-pop-amber',
                            !active && 'opacity-70',
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate">{task.name}</span>
                        {running ? (
                          <RunningPill />
                        ) : TASK_SHORT_LABEL[task.status] ? (
                          <span className="shrink-0 text-[10px] text-pop-dim">
                            {TASK_SHORT_LABEL[task.status]}
                          </span>
                        ) : null}
                      </button>
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
                return (
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    title={running ? `${session.title} · Agent 运行中` : session.title}
                    data-session-id={session.id}
                    data-running-session={running ? 'true' : undefined}
                    onClick={() => onSelectSession(session.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onSelectSession(session.id)
                    }}
                    className={cn(
                      ROW,
                      'cursor-default',
                      active
                        ? 'bg-white/[0.07] text-pop-ink'
                        : 'text-pop-ink/80 hover:bg-white/[0.035] hover:text-pop-ink',
                    )}
                  >
                    <span className="relative flex size-[6px] shrink-0 items-center justify-center">
                      {running && (
                        <>
                          <span className="absolute size-[6px] animate-ping rounded-full bg-pop-green/60" />
                          <span className="relative size-[6px] rounded-full bg-pop-green" />
                          <span className="sr-only">Agent 运行中</span>
                        </>
                      )}
                    </span>
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
                      ) : (
                        <span className="text-[10.5px] tabular-nums text-pop-dim/50 group-hover:hidden">
                          {dateLabel(session.last_message_at)}
                        </span>
                      )}
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
