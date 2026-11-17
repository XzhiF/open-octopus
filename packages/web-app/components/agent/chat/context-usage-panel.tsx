'use client'

// ctx 占用明细（单源）：classic composer 的 ctx 弹层与全域座舱的「上下文」弹层
// 渲染同一份 JSX —— 之前全域自己实现了一套（大字号 + 每行百分比），与 classic
// 对不上（2026-11-14 用户）。改这里会同时改到两边，别再复制。

import { formatTokenCount } from '@/lib/format'
import type { ContextUsageData } from '@/lib/agent/types'

export function ContextUsagePanel({ contextUsage }: { contextUsage: ContextUsageData }) {
  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-pop-ink">上下文占用</span>
        <span className="font-mono text-[10px] tabular-nums text-pop-dim">
          {formatTokenCount(contextUsage.totalTokens)} / {formatTokenCount(contextUsage.maxTokens, 0)} · {contextUsage.percentage.toFixed(1)}%{/* fmt-ok: percentage 量纲为 0–100（SDK context_usage），非 0–1 比率 */}
        </span>
      </div>
      {contextUsage.estimated && (
        <div className="mb-2 rounded-[7px] border border-dashed border-pop-bd/70 px-2 py-1 text-[10px] leading-relaxed text-pop-dim" data-tui-ctx-estimated>
          估算值：该会话最后一轮早于 ctx 落库，这里按 token 账本推算；下一轮对话后自动换成精确值。
        </div>
      )}
      <div className="space-y-1">
        {contextUsage.categories.map((cat) => (
          <div key={cat.name} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex min-w-0 items-center gap-1.5 text-pop-dim">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ backgroundColor: cat.color }} />
              <span className="truncate">{cat.name}</span>
            </span>
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-pop-ink">{formatTokenCount(cat.tokens)}</span>
          </div>
        ))}
      </div>
      {contextUsage.memoryFiles && contextUsage.memoryFiles.length > 0 && (
        <div className="mt-2 border-t border-dashed border-pop-bd/60 pt-2">
          <div className="mb-1 text-[10px] text-pop-dim">记忆文件 ({contextUsage.memoryFiles.length})</div>
          {contextUsage.memoryFiles.map((f) => (
            <div key={f.path} className="flex items-center justify-between gap-2 py-0.5 text-[10.5px]">
              <span className="max-w-[190px] truncate font-mono text-pop-dim/80" title={f.path}>{f.path}</span>
              <span className="shrink-0 font-mono tabular-nums text-pop-ink">{formatTokenCount(f.tokens)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}