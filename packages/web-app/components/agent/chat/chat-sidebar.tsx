'use client'

import { useState } from 'react'
import { ListTodo, MessageSquare, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
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
}

const ROW =
  'group flex h-[30px] w-full items-center gap-2.5 rounded-[7px] px-2 text-left text-[13px] leading-none transition-colors duration-100'

const STATUS_DOT: Record<string, string> = {
  awaiting_review: 'bg-pop-amber',
  running: 'bg-pop-green',
  paused: 'bg-pop-dim',
  draft: 'bg-pop-cyan',
}

function SectionLabel({
  label,
  count,
  action,
}: {
  label: string
  count: number
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-7 items-center px-2 pt-3">
      <span className="text-[11px] font-medium text-pop-dim/80">{label}</span>
      <span className="ml-1.5 text-[10.5px] tabular-nums text-pop-dim/45">{count}</span>
      {action && <span className="ml-auto flex items-center">{action}</span>}
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

/** macOS source-list sidebar: one material, hairline rows, no boxes or pills. */
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
}: ChatSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  // Task-author clone sessions live in the task group, never in the chat list.
  const visibleSessions = sessions.filter((session) => !session.clone_name)

  const confirmRename = async () => {
    if (editingId && editTitle.trim()) {
      await onRenameSession(editingId, editTitle.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="ui-font flex h-full min-h-0 flex-col bg-pop-idle">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-pop-ink">对话</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="新建"
              title="新建"
              className="ml-auto grid size-6 place-items-center rounded-md text-pop-dim transition-colors hover:bg-white/[0.06] hover:text-pop-ink"
            >
              <Plus className="size-[15px]" strokeWidth={1.8} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-56">
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
      </div>

      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <div className="px-2.5 pb-4">
          <div data-testid="task-session-section">
            <SectionLabel
              label="任务"
              count={tasks.length + (pendingTask ? 1 : 0)}
            />
            {tasksLoading && !pendingTask ? (
              <div className="space-y-0.5 px-0.5">
                <Skeleton className="h-[30px] w-full rounded-[7px]" />
                <Skeleton className="h-[30px] w-full rounded-[7px]" />
              </div>
            ) : tasks.length === 0 && !pendingTask ? (
              <p className="px-2 py-1 text-[12px] text-pop-dim/60">暂无任务</p>
            ) : (
              <div className="space-y-px">
                {pendingTask && (
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
                {tasks.map((task) => {
                  const active = activeTaskId === task.id
                  const running =
                    !!task.source_chat_session_id &&
                    !!runningSessionIds?.has(task.source_chat_session_id)
                  return (
                    <button
                      key={task.id}
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
                      ) : task.status === 'draft' ? (
                        <span className="shrink-0 text-[10px] text-pop-dim">草稿</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <SectionLabel label="最近" count={visibleSessions.length} />
          {sessionsLoading ? (
            <div className="space-y-0.5 px-0.5">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-[30px] w-full rounded-[7px]" />
              ))}
            </div>
          ) : visibleSessions.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-pop-dim/60">暂无对话</p>
          ) : (
            <nav aria-label="会话列表" className="space-y-px">
              {visibleSessions.map((session) => {
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
                            className="hidden size-5 place-items-center rounded text-pop-dim transition-colors hover:bg-white/[0.08] hover:text-pop-ink group-hover:grid"
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`会话操作 ${session.title}`}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
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
