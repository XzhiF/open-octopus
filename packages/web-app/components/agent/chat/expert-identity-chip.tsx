'use client'

// Session-level expert identity switch.
// This is the "role switch" surface: the selected expert becomes the session's
// lead role via an append-only role card. It is deliberately distinct from
// `@专家` in the composer, which dispatches a one-turn subagent.

import { useCallback, useEffect, useState } from 'react'
import { Check, UserRound, X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { EXPERT_ROLES } from '@/lib/expert-roles'
import * as agentApi from '@/lib/agent/api'
import { getTaskChatRole, setTaskChatRole, type TaskChatRoleState } from '@/lib/tasks-api'
import { cn } from '@/lib/utils'

type IdentityKind = 'agent' | 'clone' | 'task'

interface ExpertIdentityChipProps {
  kind: IdentityKind
  sessionId?: string | null
  cloneName?: string
  taskId?: string
  className?: string
}

export function ExpertIdentityChip({
  kind,
  sessionId,
  cloneName = 'task-author',
  taskId,
  className,
}: ExpertIdentityChipProps) {
  const [role, setRole] = useState<TaskChatRoleState | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const enabled = kind === 'task' ? !!taskId : !!sessionId

  const load = useCallback(async () => {
    if (!enabled) {
      setRole(null)
      return
    }
    try {
      const next = kind === 'task'
        ? await getTaskChatRole(taskId!)
        : kind === 'clone'
          ? await agentApi.getCloneSessionRole(cloneName, sessionId!)
          : await agentApi.getSessionRole(sessionId!)
      setRole(next)
    } catch {
      setRole(null)
    }
  }, [enabled, kind, taskId, cloneName, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const switchTo = async (expert: string | null) => {
    if (!enabled || busy) return
    setBusy(true)
    try {
      const next = kind === 'task'
        ? await setTaskChatRole(taskId!, expert)
        : kind === 'clone'
          ? await agentApi.setCloneSessionRole(cloneName, sessionId!, expert)
          : await agentApi.setSessionRole(sessionId!, expert)
      setRole(next)
      setOpen(false)
      toast.success(expert ? '已切换专家身份 · 下一条消息生效' : '已恢复基础身份')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '切换专家身份失败')
    } finally {
      setBusy(false)
    }
  }

  if (!enabled) return null
  const active = role?.expert ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="expert-identity-chip"
          data-expert-id={active?.id ?? ''}
          title={active ? `当前专家身份：${active.name}（点击切换）` : '以专家身份工作（身份切换）'}
          className={cn(
            'flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] border px-1.5 text-[10.5px] transition-colors',
            active
              ? 'border-pop-purple/50 bg-pop-purple-soft text-pop-purple'
              : 'border-transparent text-pop-dim hover:bg-pop-paper hover:text-pop-ink',
            className,
          )}
        >
          <UserRound className="size-3" />
          <span>{active ? active.name : '专家身份'}</span>
          {active && (
            <span
              role="button"
              tabIndex={0}
              aria-label="退出专家身份"
              title="退出专家身份"
              onClick={(e) => {
                e.stopPropagation()
                void switchTo(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  void switchTo(null)
                }
              }}
              className="ml-0.5 grid size-3 place-items-center rounded-full text-pop-purple/70 hover:bg-pop-purple/15 hover:text-pop-purple"
            >
              <X className="size-2.5" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw_-_24px)] overflow-hidden rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-0 shadow-pop"
      >
        <div className="border-b border-pop-bd/60 px-3 py-2.5">
          <div className="text-[12px] font-bold text-pop-ink">当前会话的主专家</div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-pop-dim">
            身份切换：改变这个会话的工作角色。要派一次性专家会诊，请在输入框里用 <span className="font-mono text-pop-purple">@专家</span>。
          </p>
        </div>
        <div className="max-h-[300px] overflow-y-auto p-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void switchTo(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
              !active && 'bg-pop-cyan-soft/40',
            )}
          >
            <span className={cn(
              'grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px]',
              !active ? 'border-pop-cyan bg-pop-cyan text-pop-bg' : 'border-pop-bd text-transparent',
            )}>
              {!active && <Check className="size-2.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-pop-ink">恢复基础身份</span>
              <span className="block text-[10px] text-pop-dim">回到主 Agent / task-author 的默认角色</span>
            </span>
          </button>
          {EXPERT_ROLES.map((expert) => {
            const on = active?.id === expert.id
            return (
              <button
                key={expert.id}
                type="button"
                disabled={busy}
                data-expert-option={expert.id}
                onClick={() => void switchTo(expert.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
                  on && 'bg-pop-purple-soft/60',
                )}
              >
                <span className={cn(
                  'grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px]',
                  on ? 'border-pop-purple bg-pop-purple text-pop-bg' : 'border-pop-bd text-transparent',
                )}>
                  {on && <Check className="size-2.5" />}
                </span>
                <span className="w-5 shrink-0 text-center text-[13px]">{expert.label.split(' ')[0]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-pop-ink">{expert.name}</span>
                  <span className="block truncate text-[10px] text-pop-dim">{expert.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
