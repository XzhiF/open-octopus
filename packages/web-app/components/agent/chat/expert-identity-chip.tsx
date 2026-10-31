'use client'

// Session-level identity switch (v59: identities are clones).
// This is the "role switch" surface: the selected clone becomes the session's
// lead role via an append-only role card (whole role pack: persona + skills +
// boundary). It is deliberately distinct from `@` in the composer, which
// delegates a one-turn subagent consultation.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Search, Users, UserRound, X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as agentApi from '@/lib/agent/api'
import type { CloneInfo } from '@/lib/agent/types'
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

const CLONE_STATUS: Record<CloneInfo['status'], { dot: string; label: string }> = {
  active: { dot: 'bg-pop-green', label: '活跃' },
  idle: { dot: 'bg-pop-dim', label: '空闲' },
  executing: { dot: 'bg-pop-amber', label: '执行中' },
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
  const [query, setQuery] = useState('')
  const [clones, setClones] = useState<CloneInfo[] | null>(null)
  const [clonesLoading, setClonesLoading] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const enabled = kind === 'task' ? !!taskId : !!sessionId

  // 每次打开都是干净的一次检索（名册会越装越多，别让旧词残留）。
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // Roster loads once, lazily — the panel lists clones, not the agency catalog.
  useEffect(() => {
    if (!open || clones) return
    let alive = true
    setClonesLoading(true)
    agentApi.listClones()
      .then((res) => { if (alive) setClones(res.clones.filter((c) => c.name !== 'main-agent')) })
      .catch(() => { if (alive) setClones([]) })
      .finally(() => { if (alive) setClonesLoading(false) })
    return () => { alive = false }
  }, [open, clones])

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

  const switchTo = async (target: string | null) => {
    if (!enabled || busy) return
    setBusy(true)
    try {
      const next = kind === 'task'
        ? await setTaskChatRole(taskId!, target)
        : kind === 'clone'
          ? await agentApi.setCloneSessionRole(cloneName, sessionId!, target)
          : await agentApi.setSessionRole(sessionId!, target)
      setRole(next)
      setOpen(false)
      toast.success(target ? '已切换分身身份 · 下一条消息生效' : '已恢复基础身份')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '切换分身身份失败')
    } finally {
      setBusy(false)
    }
  }

  if (!enabled) return null
  const activeLabel = role?.clone?.display_name ?? role?.expert?.name ?? null

  const needle = query.trim().toLowerCase()
  const hit = (text?: string | null) => !needle || !!text && text.toLowerCase().includes(needle)
  const filtered = (clones ?? []).filter(
    (c) => hit(c.display_name) || hit(c.name) || c.skills.some((name) => hit(name)),
  )
  const builtins = filtered.filter((c) => c.type === 'built-in')
  const users = filtered.filter((c) => c.type !== 'built-in')

  const cloneRow = (c: CloneInfo) => {
    const on = role?.clone?.id === c.name
    const status = CLONE_STATUS[c.status] ?? CLONE_STATUS.idle
    const sub = c.skills.length > 0
      ? `SKILL ${c.skills.join(' · ')}`
      : (c.persona || (c.type === 'built-in' ? '系统分身' : '自定义分身'))
    return (
      <button
        key={c.name}
        type="button"
        disabled={busy}
        data-expert-option={c.name}
        onClick={() => void switchTo(c.name)}
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
        <Users className={cn('size-3.5 shrink-0', on ? 'text-pop-purple' : 'text-pop-dim')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-pop-ink">{c.display_name}</span>
          <span className="block truncate text-[10px] text-pop-dim" title={sub}>{sub}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[9.5px] text-pop-dim">
          <span className={cn('size-1.5 rounded-full', status.dot)} />
          {status.label}
        </span>
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="expert-identity-chip"
          data-expert-id={role?.active_expert ?? ''}
          title={activeLabel ? `当前分身身份：${activeLabel}（点击切换）` : '切换分身身份（以某分身的岗位包持久工作）'}
          className={cn(
            'flex h-[22px] max-w-[220px] shrink-0 items-center gap-1 rounded-[7px] border px-1.5 text-[10.5px] transition-colors',
            role?.active_expert
              ? 'border-pop-purple/50 bg-pop-purple-soft text-pop-purple'
              : 'border-transparent text-pop-dim hover:bg-pop-paper hover:text-pop-ink',
            className,
          )}
        >
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">{activeLabel ? `分身 · ${activeLabel}` : '切换分身'}</span>
          {role?.active_expert && (
            <span
              role="button"
              tabIndex={0}
              aria-label="退出分身身份"
              title="退出分身身份"
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
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="border-b border-pop-bd/60 px-3 py-2.5">
          <div className="text-[12px] font-bold text-pop-ink">当前会话的身份（分身）</div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-pop-dim">
            身份切换：让这个会话以某分身的岗位包（人设 + 方法论 + 技能 + 边界）持久工作，对后续每一轮生效。
            要一次性委派子代理会诊，请在输入框里用 <span className="font-mono text-pop-purple">@</span>。
          </p>
        </div>
        <div className="border-b border-pop-bd/60 px-2.5 pb-2 pt-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-pop-dim/70"
              strokeWidth={1.8}
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索分身…"
              aria-label="搜索分身"
              data-testid="identity-search"
              maxLength={80}
              className="h-[28px] w-full rounded-[8px] border border-white/[0.08] bg-white/[0.04] pl-8 pr-7 text-[11.5px] text-pop-ink outline-none transition-colors placeholder:text-pop-dim/60 focus:border-pop-purple/40"
            />
            {query && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-pop-dim transition-colors hover:text-pop-ink"
              >
                <X className="size-3.5" strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>
        <div className="max-h-[300px] overflow-y-auto p-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => void switchTo(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
              !role?.active_expert && 'bg-pop-cyan-soft/40',
            )}
          >
            <span className={cn(
              'grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px]',
              !role?.active_expert ? 'border-pop-cyan bg-pop-cyan text-pop-bg' : 'border-pop-bd text-transparent',
            )}>
              {!role?.active_expert && <Check className="size-2.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] text-pop-ink">恢复基础身份</span>
              <span className="block text-[10px] text-pop-dim">回到主 Agent / task-author 的默认角色</span>
            </span>
          </button>
          {clonesLoading && !clones ? (
            <div className="px-2 py-6 text-center text-[11px] text-pop-dim">加载分身…</div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-[11px] text-pop-dim">
              {needle ? '未找到匹配的分身' : '暂无分身'}
            </div>
          ) : (
            <>
              {builtins.length > 0 && (
                <>
                  <div className="px-2 pb-0.5 pt-2 text-[10px] font-bold tracking-[0.08em] text-pop-dim/70">
                    系统分身
                  </div>
                  {builtins.map(cloneRow)}
                </>
              )}
              {users.length > 0 && (
                <>
                  <div className="px-2 pb-0.5 pt-2 text-[10px] font-bold tracking-[0.08em] text-pop-dim/70">
                    我的分身
                  </div>
                  {users.map(cloneRow)}
                </>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
