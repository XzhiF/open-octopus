'use client'

// Composer 上下文角标（2026-10-29 用户定的形态）：
// `80.1K / 1M · 8.0%` 装在一个圆角框里，框内用进度底条 + 填充宽度表达占用比例。
// 分档配色：常规青 → 偏高琥珀（≥60%）→ 吃紧红（≥85%）。
// 纯展示组件；点击/弹层由调用方（ChatArea）的 Popover 负责。

import { formatTokenCount } from '@/lib/format'
import type { ContextUsageData } from '@/lib/agent/types'
import { cn } from '@/lib/utils'

/** 用量分档 —— 底条前景色、框线、百分比文字色随档位走。 */
export function ctxUsageTone(percentage: number) {
  if (percentage >= 85) {
    return { bar: 'bg-pop-red', fill: 'bg-pop-red/15', border: 'border-pop-red/50', text: 'text-pop-red' }
  }
  if (percentage >= 60) {
    return { bar: 'bg-pop-amber', fill: 'bg-pop-amber/15', border: 'border-pop-amber/50', text: 'text-pop-amber' }
  }
  return { bar: 'bg-pop-cyan', fill: 'bg-pop-cyan/15', border: 'border-pop-cyan/40', text: 'text-pop-cyan' }
}

const CHIP_CLASS =
  'relative flex h-[22px] shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full border pl-2 pr-1.5 font-mono text-[11px] leading-none tabular-nums transition-colors'

function clampPct(percentage: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(percentage) ? percentage : 0))
}

/** 触发器按钮的无障碍名 —— 视觉文本拆成多个行内 span，读屏需要一条连贯的句子。 */
export function contextUsageAriaLabel(contextUsage: ContextUsageData): string {
  const pct = clampPct(contextUsage.percentage)
  return `上下文占用 ${formatTokenCount(contextUsage.totalTokens)} / ${formatTokenCount(contextUsage.maxTokens, 0)} · ${contextUsage.estimated ? '~' : ''}${pct.toFixed(1)}%` // fmt-ok: 无障碍名，百分比量纲为 0–100（SDK context_usage）
}

export function ContextUsageChip({
  contextUsage,
  expanded,
  className,
}: {
  contextUsage: ContextUsageData
  expanded?: boolean
  className?: string
}) {
  const pct = clampPct(contextUsage.percentage)
  const tone = ctxUsageTone(pct)
  return (
    <span data-ctx-usage={contextUsage.estimated ? 'estimated' : 'exact'} className={cn(CHIP_CLASS, tone.border, className)}>
      {/* 整格淡填充 —— 一眼看出大概用了多少 */}
      <span aria-hidden className={cn('absolute inset-y-0 left-0', tone.fill)} style={{ width: `${pct}%` }} data-ctx-fill />
      {/* 底边细进度条 —— 低占用时也能读出比例 */}
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-pop-bd/35">
        <span className={cn('block h-full', tone.bar)} style={{ width: `${pct}%` }} />
      </span>
      <span className="relative text-pop-dim">
        {formatTokenCount(contextUsage.totalTokens)} / {formatTokenCount(contextUsage.maxTokens, 0)}
      </span>
      <span className="relative text-pop-dim/60">{' · '}</span>
      <span className={cn('relative', tone.text)}>
        {contextUsage.estimated ? '~' : ''}
        {pct.toFixed(1)}%{/* fmt-ok: percentage 量纲为 0–100（SDK context_usage），非 0–1 比率 */}
      </span>
      <span aria-hidden className={cn('relative text-[8px]', tone.text)}>
        {' '}
        {expanded ? '▴' : '▾'}
      </span>
    </span>
  )
}

/** 无用量数据时的同形占位（空会话）。 */
export function ContextUsagePlaceholder({ className }: { className?: string }) {
  return (
    <span
      title="暂无上下文用量"
      className={cn(
        'flex h-[22px] shrink-0 items-center rounded-full border border-pop-bd/40 px-2 font-mono text-[11px] leading-none tabular-nums text-pop-dim/60',
        className,
      )}
    >
      -- / -- · --%
    </span>
  )
}
