'use client'

// 分屏右栏的空态：先选一个会话，或开一页新对话。
// 只在这一栏还没有会话时出现；选完（或新建）后立刻交给 ChatPane 的转录。

import { useMemo } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import type { AgentSession } from '@/lib/agent/types'
import type { RunningAgentSession } from '@/lib/agent/api'
import { cn } from '@/lib/utils'

interface ChatPanePickerProps {
  sessions: AgentSession[]
  loading: boolean
  runningAgents: RunningAgentSession[]
  /** 另一栏已打开的会话 —— 行尾标 L/R，点击 = 聚焦那一栏。 */
  occupiedId?: string | null
  occupiedMark?: 'L' | 'R'
  onPick: (sessionId: string) => void
  onNew: () => void
}

function relativeTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export function ChatPanePicker({
  sessions,
  loading,
  runningAgents,
  occupiedId = null,
  occupiedMark = 'L',
  onPick,
  onNew,
}: ChatPanePickerProps) {
  const runningIds = useMemo(() => new Set(runningAgents.map((agent) => agent.id)), [runningAgents])
  const recent = useMemo(
    () => sessions
      .filter((session) => !session.clone_name)
      .sort((a, b) => (b.last_message_at ?? b.updated_at ?? '').localeCompare(a.last_message_at ?? a.updated_at ?? ''))
      .slice(0, 6),
    [sessions],
  )

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-10">
      <div className="w-full max-w-[380px]">
        <div className="flex items-center gap-2 px-1">
          <span className="grid size-5 place-items-center rounded-[6px] border border-pop-yellow/40 bg-pop-yellow/[0.12] font-mono text-[10px] font-semibold text-pop-yellow">
            R
          </span>
          <span className="text-[13px] font-medium text-pop-ink">在右栏打开一个会话</span>
        </div>
        <p className="mt-1 px-1 text-[11.5px] leading-relaxed text-pop-dim">
          两栏各自独立：会话、运行中的 Agent 与作业坞互不干扰。也可以直接开一页新对话。
        </p>

        <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.08] bg-pop-paper/60 shadow-pop-sm">
          {loading && recent.length === 0 ? (
            <div className="space-y-1 p-1.5">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={index} className="h-[34px] animate-pulse rounded-[7px] bg-white/[0.04]" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <p className="px-3 py-4 text-[12px] text-pop-dim/70">还没有会话。开一页新对话吧。</p>
          ) : (
            <div className="p-1.5">
              {recent.map((session) => {
                const running = runningIds.has(session.id)
                const occupied = session.id === occupiedId
                return (
                  <button
                    key={session.id}
                    type="button"
                    data-testid="pane-picker-session"
                    data-occupied={occupied ? 'true' : undefined}
                    title={occupied
                      ? `已在${occupiedMark === 'L' ? '左' : '右'}栏打开 —— 点击聚焦那一栏`
                      : session.title}
                    onClick={() => onPick(session.id)}
                    className="group flex h-[34px] w-full items-center gap-2 rounded-[7px] px-2 text-left transition-colors hover:bg-white/[0.05]"
                  >
                    <MessageSquare className="size-[13px] shrink-0 text-pop-dim/70" strokeWidth={1.9} aria-hidden />
                    {running && <span className="sr-only">Agent 运行中</span>}
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-pop-ink/85">
                      {session.title}
                    </span>
                    {running ? (
                      <span className="flex shrink-0 items-center gap-1 rounded-full bg-pop-green/10 px-1.5 py-0.5 text-[9.5px] font-medium text-pop-green">
                        <span className="agent-eq" aria-hidden><i /><i /><i /></span>
                        运行中
                      </span>
                    ) : !occupied ? (
                      <span className={cn(
                        'shrink-0 text-[10px] tabular-nums text-pop-dim/50',
                        'group-hover:text-pop-dim',
                      )}>
                        {relativeTime(session.last_message_at ?? session.updated_at)}
                      </span>
                    ) : null}
                    {occupied && (
                      <span
                        aria-label={`已在${occupiedMark === 'L' ? '左' : '右'}栏打开`}
                        className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-pop-yellow/40 bg-pop-yellow/12 font-mono text-[9px] font-semibold leading-none text-pop-yellow"
                      >
                        {occupiedMark}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
          <button
            type="button"
            data-testid="pane-picker-new"
            onClick={onNew}
            className="flex h-10 w-full items-center justify-center gap-1.5 border-t border-white/[0.06] text-[12px] text-pop-dim transition-colors hover:bg-white/[0.04] hover:text-pop-ink"
          >
            <Plus className="size-3.5" strokeWidth={2} />
            开启新对话
          </button>
        </div>
      </div>
    </div>
  )
}
