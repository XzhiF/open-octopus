'use client'

// S6 owns this file —— 上下文 popover（v12 #popCtx，392 宽，向上贴按钮）。
//
// 数据全部来自真接口：
//   · 构成条 / 图例 ← chat.contextUsage.categories（颜色用 category.color，缺失才兜底）；
//   · 本舱按主体 ← getCabinUsage(entryCabinId).byJob（每行一条），子代理单列；
//   · 压缩上下文 = chat.submit('/compact') —— 真正的斜杠命令，不伪造本地数字；
//   · token 读数 ← chat.usage，回合结束才刷新（footer 里注明）。
//
// header 的关闭按钮是第一个可聚焦元素（plans §1.6）；Esc 交给 CockpitLayerStack。

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatCost, formatPercent, formatTokenCount, type CostDisplay } from '@/lib/format'
import type { ContextUsageData } from '@/lib/agent/types'
import type { CabinUsagePayload } from '@/lib/cabin-api'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitChatApi } from '../state/cockpit-state'
import { BRIDGE_POP_LAYER_PRIORITY } from './CockpitModelPopover'
import { categoryColor, clampPercent } from './rig-model'

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

interface Composition {
  name: string
  tokens: number
  color: string
  share: number
}

function composition(context: ContextUsageData): { parts: Composition[]; total: number } {
  const sum = context.categories.reduce((acc, item) => acc + (Number.isFinite(item.tokens) ? item.tokens : 0), 0)
  const total = sum > 0 ? sum : context.totalTokens
  return {
    total,
    parts: context.categories.map((item, index) => ({
      name: item.name,
      tokens: item.tokens,
      color: categoryColor(item.color, index),
      share: total > 0 ? Math.max(0, (item.tokens / total) * 100) : 0,
    })),
  }
}

export function CockpitContextPopover({ chat, usage, usageStale, currency }: CockpitContextPopoverProps) {
  const { layer } = useCockpitState()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    return layer.register('bridge-pop', BRIDGE_POP_LAYER_PRIORITY, () => setOpen(false))
  }, [open, layer])

  const context = chat.contextUsage
  const percent = context ? clampPercent(context.percentage) : 0
  const composed = useMemo(() => (context ? composition(context) : null), [context])
  const tokenUsage = chat.usage

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
          className="ck12-rig-btn ck12-rig-ctx"
          title="上下文与消耗"
          aria-label="上下文与消耗"
          data-testid="ck12-rig-context"
        >
          {context ? (
            <>
              <span
                aria-hidden="true"
                className="ck12-rig-ring"
                style={{ '--p': percent } as CSSProperties}
              />
              <b>{context.estimated ? '~' : ''}{Math.round(percent)}%</b>
            </>
          ) : (
            <b>未就绪</b>
          )}
          <span className="ck12-rig-lbl">上下文</span>
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
          >✕</button>
          <b>上下文与消耗</b>
          <span>本舱 · 本轮</span>
        </div>

        <div className="ck12-rig-pop-b">
          {context && composed ? (
            <>
              <div className="ck12-rig-ctxhead">
                <span>
                  <b>{formatTokenCount(context.totalTokens)}</b>
                  <span className="ck12-rig-dim"> / {formatTokenCount(context.maxTokens, 0)}</span>
                </span>
                <span className="ck12-rig-pct">
                  已用 {Math.round(percent)}%{context.estimated ? '（估算）' : ''}
                </span>
              </div>

              {composed.total > 0 && (
                <div className="ck12-rig-mix" data-testid="ck12-rig-context-mix">
                  {composed.parts.map((part) => (
                    <i
                      key={part.name}
                      style={{ width: `${part.share}%`, backgroundColor: part.color }}
                      title={`${part.name} · ${formatTokenCount(part.tokens)}`}
                    />
                  ))}
                </div>
              )}

              <div className="ck12-rig-legend" data-testid="ck12-rig-context-legend">
                {composed.parts.map((part) => (
                  <span key={part.name}>
                    <i style={{ backgroundColor: part.color }} />
                    {part.name} {formatPercent(part.share / 100, 0)}
                  </span>
                ))}
              </div>
            </>
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
          <span className="ck12-rig-note" data-testid="ck12-rig-context-note">
            {tokenUsage
              ? `↑ ${formatTokenCount(tokenUsage.usage.inputTokens)} · ↓ ${formatTokenCount(tokenUsage.usage.outputTokens)} · ${tokenUsage.totalCalls} 次调用 · 回合结束更新`
              : 'token · 回合结束更新'}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
