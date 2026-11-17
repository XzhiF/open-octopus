'use client'

// S2 门禁卡：舱初始化 7 项门禁的 transcript 卡（桥接 cabin.init 事件落消息，
// metadata.displayType='event' + payload.cabinInit=true）。在舱壳内读
// CabinProvider 的实时 initState 覆盖快照 —— 门禁逐项推进时卡跟着活；壳外
// （桌面误开舱会话）退化为消息里的静态快照。重试/去修自包含，不依赖壳。

import { useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentMessage } from '@/lib/agent/types'
import type { CabinInitItem } from '@octopus/shared'
import { retryCabinInit } from '@/lib/cabin-api'
import { cn } from '@/lib/utils'
import { useCabinOptional } from './cabin-provider'
import { cabinModuleForDeepLink } from './cabin-meta'

type GateStatus = 'running' | 'done' | 'failed'

function deriveStatus(items: CabinInitItem[]): GateStatus {
  if (items.some((i) => i.state === 'failed')) return 'failed'
  if (items.length > 0 && items.every((i) => i.state === 'done')) return 'done'
  return 'running'
}

export function CabinInitGateCard({ message }: { message: AgentMessage }) {
  const activity = message.activity
  const payload = (activity?.payload ?? {}) as {
    cabinId?: string
    status?: GateStatus
    items?: CabinInitItem[]
  }
  const cabinId = payload.cabinId ?? ''
  const ctx = useCabinOptional()
  const live = ctx && ctx.cabinId === cabinId ? ctx.initState : null
  const items = live?.items ?? payload.items ?? []
  const status = live ? deriveStatus(live.items) : (payload.status ?? 'running')
  const [retrying, setRetrying] = useState(false)

  const retry = async () => {
    if (!cabinId || retrying) return
    setRetrying(true)
    try {
      await retryCabinInit(cabinId)
      toast.success('门禁重试已启动')
      await ctx?.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试失败')
    } finally {
      setRetrying(false)
    }
  }

  const tone =
    status === 'failed'
      ? 'border-pop-red/40 bg-pop-red/[0.06]'
      : status === 'done'
        ? 'border-pop-green/40 bg-pop-green/[0.05]'
        : 'border-pop-amber/40 bg-pop-amber/[0.05]'

  return (
    <div
      data-tui-msg="event"
      data-message-id={message.id}
      data-testid="cabin-init-gate-card"
      data-status={status}
      className={cn('rounded-md border px-3 py-2 font-mono text-[11.5px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]', tone)}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded-full border text-[9px]',
            status === 'failed' ? 'border-pop-red text-pop-red' : status === 'done' ? 'border-pop-green text-pop-green' : 'border-pop-amber text-pop-amber',
          )}
        >
          {status === 'failed' ? '✕' : status === 'done' ? '✓' : '…'}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold text-pop-ink">
          {activity?.title ?? '舱初始化'}
        </span>
        <span
          className={cn(
            'shrink-0 text-[9.5px] font-bold',
            status === 'failed' ? 'text-pop-red' : status === 'done' ? 'text-pop-green' : 'text-pop-amber',
          )}
        >
          {status === 'failed' ? '门禁失败' : status === 'done' ? '舱已就绪' : '门禁进行中'}
        </span>
      </div>

      <ul className="mt-2 space-y-1 pl-6" data-testid="cabin-gate-items">
        {items.map((item) => (
          <li key={item.key} data-gate-key={item.key} data-gate-state={item.state}>
            <div className="flex items-center gap-1.5">
              {item.state === 'done' && <Check className="size-3 shrink-0 text-pop-green" />}
              {item.state === 'failed' && <X className="size-3 shrink-0 text-pop-red" />}
              {item.state === 'running' && <Loader2 className="size-3 shrink-0 animate-spin text-pop-amber" />}
              {item.state === 'pending' && <span className="size-3 shrink-0 text-center text-[9px] leading-3 text-pop-dim/60">○</span>}
              <span className={cn('text-[11px]', item.state === 'pending' ? 'text-pop-dim/70' : 'text-pop-ink')}>
                {item.label}
              </span>
              {item.sub && <span className="truncate text-[9.5px] text-pop-dim">{item.sub}</span>}
              {item.state === 'failed' && ctx && item.deep_link && cabinModuleForDeepLink(item.deep_link) && (
                <button
                  type="button"
                  data-testid={`cabin-gate-fix-${item.key}`}
                  onClick={() => ctx.openModule(cabinModuleForDeepLink(item.deep_link)!)}
                  className="ml-auto shrink-0 rounded border border-pop-red/40 px-1.5 py-0.5 text-[9.5px] text-pop-red transition-colors hover:bg-pop-red/10"
                >
                  去修
                </button>
              )}
            </div>
            {item.state === 'failed' && (item.error || item.fix_hint) && (
              <div className="mt-0.5 pl-[18px] text-[9.5px] leading-relaxed">
                {item.error && <div className="text-pop-red/90">{item.error}</div>}
                {item.fix_hint && <div className="text-pop-dim">{item.fix_hint}</div>}
              </div>
            )}
          </li>
        ))}
      </ul>

      {status === 'failed' && (
        <div className="mt-2 pl-6">
          <button
            type="button"
            data-testid="cabin-gate-retry"
            disabled={retrying || !cabinId}
            onClick={() => void retry()}
            className="rounded border border-pop-red/40 bg-black/10 px-2 py-0.5 text-[10px] font-bold text-pop-ink transition-colors hover:bg-pop-red/10 disabled:opacity-50"
          >
            {retrying ? '重试中…' : '重试门禁（跳过已完成项）'}
          </button>
        </div>
      )}
    </div>
  )
}