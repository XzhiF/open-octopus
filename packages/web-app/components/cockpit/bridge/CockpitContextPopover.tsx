'use client'

// S6 owns this file —— 上下文 popover（向上贴舰桥）。
//
// 数据全部来自真接口：
//   · 构成 / 记忆文件 ← chat.contextUsage，**直接复用 classic 的 ContextUsagePanel**
//     （2026-11-14 用户：全域自己那套大字号 + 每行百分比跟 classic 下方这块对不上）；
//   · 本舱按主体 ← getCabinUsage(entryCabinId).byJob（每行一条），子代理单列；
//   · 压缩上下文 = chat.submit('/compact') —— 真正的斜杠命令，不伪造本地数字。
//
// header 的关闭按钮是第一个可聚焦元素（plans §1.6）；Esc 交给 CockpitLayerStack。

import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ContextUsageChip } from '@/components/agent/chat/context-usage-chip'
import { ContextUsagePanel } from '@/components/agent/chat/context-usage-panel'
import { formatCost, type CostDisplay } from '@/lib/format'
import type { CabinUsagePayload } from '@/lib/cabin-api'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitChatApi } from '../state/cockpit-state'
import { BRIDGE_POP_LAYER_PRIORITY } from './CockpitModelPopover'

const ROW_COLORS = [
  'var(--pop-cyan)',
  'var(--pop-violet)',
  'var(--pop-green)',
  'var(--pop-amber)',
  'var(--pop-red)',
  'var(--pop-pink)',
] as const

export interface CockpitContextPopoverProps {
  chat: CockpitChatApi
  usage: CabinUsagePayload | null
  usageStale: boolean
  currency: CostDisplay
}

export function CockpitContextPopover({ chat, usage, usageStale, currency }: CockpitContextPopoverProps) {
  const { layer } = useCockpitState()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    return layer.register('bridge-pop', BRIDGE_POP_LAYER_PRIORITY, () => setOpen(false))
  }, [open, layer])

  const context = chat.contextUsage

  const rows = usage?.byJob ?? []
  const subagents = usage?.subagents ?? null
  const subagentCount = subagents?.count ?? 0
  const maxCost = Math.max(
    0,
    ...rows.map((row) => row.totals.cost.usd ?? 0),
    subagents?.cost.usd ?? 0,
  )

  const compact = useCallback(() => {
    chat.submit('/compact')
    toast.success('已请汐音压缩上下文')
    setOpen(false)
  }, [chat])

  const costOf = (usd: number | null, complete: boolean) => formatCost(usd, complete, currency)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ck12-rig-ctx"
          title="上下文与消耗"
          aria-label="上下文与消耗"
          data-testid="ck12-rig-context"
        >
          {/* 与 classic composer 的 ctx 角标同一个组件：`84.7K / 1M · 8.0%` 胶囊。 */}
          {context ? (
            <ContextUsageChip contextUsage={context} expanded={open} />
          ) : (
            <b>未就绪</b>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="ck12-rig-pop ck12-rig-pop-wide"
        data-testid="ck12-rig-context-pop"
        onEscapeKeyDown={(event) => {
          // Esc 一律由本层先收：LayerStack 在 Radix 弹层打开时会主动让行
          // （lib/escape-stack.isRadixLayerOpen），所以这里不能只 preventDefault，
          // 还要真的关掉自己；layer.register 仍保留，兼容不让行的旧栈。
          event.preventDefault()
          setOpen(false)
        }}
      >
        <div className="ck12-rig-pop-h">
          <button
            type="button"
            className="ck12-rig-pop-x"
            onClick={() => setOpen(false)}
            aria-label="关闭上下文与消耗"
            data-testid="ck12-rig-context-close"
          ><X className="size-3" aria-hidden="true" /></button>
          <b>上下文与消耗</b>
          <span>本舱 · 本轮</span>
        </div>

        <div className="ck12-rig-pop-b">
          {context ? (
            <ContextUsagePanel contextUsage={context} />
          ) : (
            <div className="ck12-rig-empty" data-testid="ck12-rig-context-empty">
              未就绪 · 这一轮还没有上下文数据
            </div>
          )}

          <div className="ck12-rig-pop-sep" />

          <div className="ck12-rig-sect">
            本舱按主体
            <small>{usageStale ? '读取失败 · 上次值' : '30s 刷新'}</small>
          </div>

          <div className="ck12-rig-urows" data-testid="ck12-rig-usage-rows">
            {rows.map((row, index) => {
              const usd = row.totals.cost.usd
              const width = usd != null && maxCost > 0 ? Math.max(2, (usd / maxCost) * 100) : 0
              const color = ROW_COLORS[index % ROW_COLORS.length]
              return (
                <div className="ck12-rig-urow" key={row.job_id ?? `${row.kind}:${row.label}:${index}`}>
                  <span className="un">
                    <i style={{ backgroundColor: color }} />
                    <span title={row.label}>{row.label}</span>
                  </span>
                  <span className="ub">
                    <i style={{ width: `${width}%`, backgroundColor: color }} />
                  </span>
                  <span className="uc">{costOf(usd, row.totals.cost.complete)}</span>
                </div>
              )
            })}

            {subagents && subagentCount > 0 && (
              <div className="ck12-rig-urow" data-testid="ck12-rig-usage-subagents">
                <span className="un">
                  <i style={{ backgroundColor: 'var(--pop-violet)' }} />
                  <span>子代理 · {subagentCount}</span>
                </span>
                <span className="ub">
                  <i
                    style={{
                      width: `${subagents.cost.usd != null && maxCost > 0 ? Math.max(2, (subagents.cost.usd / maxCost) * 100) : 0}%`,
                      backgroundColor: 'var(--pop-violet)',
                    }}
                  />
                </span>
                <span className="uc">{costOf(subagents.cost.usd, subagents.cost.complete)}</span>
              </div>
            )}

            {rows.length === 0 && subagentCount === 0 && (
              <div className="ck12-rig-empty" data-testid="ck12-rig-usage-empty">
                — · 本舱还没有用量
              </div>
            )}
          </div>
        </div>

        <div className="ck12-rig-pop-f">
          <button
            type="button"
            className="ck12-rig-action"
            onClick={compact}
            data-testid="ck12-rig-compact"
          >压缩上下文</button>
          <span className="ck12-rig-spacer" />
        </div>
      </PopoverContent>
    </Popover>
  )
}