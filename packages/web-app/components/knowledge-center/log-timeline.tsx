"use client"

import { cn } from "@/lib/utils"
import type { KcLogLine } from "@/lib/knowledge/knowledge-center-api"

/**
 * LOG.md 时间线视图 — 票11 AC5（spec 故事 17：行格式 `## [date] op | title → 结果` 渲染）。
 * 前缀过滤 = 票面六动作（ingest/compile/query/lint/revert；split/retire/case+ 等编译服务
 * 实际动作以「全部」兜底呈现，不丢行）。数据源 = GET /api/knowledge/log 行数组。
 */

const FILTER_OPS = ["all", "ingest", "compile", "query", "lint", "revert"] as const
export type KcLogFilter = (typeof FILTER_OPS)[number]

const OP_TONE: Record<string, string> = {
  ingest: "bg-pop-cyan-soft text-pop-cyan",
  compile: "bg-pop-green-soft text-pop-green",
  query: "bg-pop-navy text-pop-ink",
  lint: "bg-pop-amber-soft text-pop-amber",
  revert: "bg-pop-pink-soft text-pop-pink",
}

interface LogTimelineProps {
  lines: KcLogLine[]
  filter: KcLogFilter
  onFilter: (f: KcLogFilter) => void
}

export function LogTimeline({ lines, filter, onFilter }: LogTimelineProps) {
  const shown = filter === "all" ? lines : lines.filter(l => l.op === filter)
  return (
    <div data-testid="kc-log-view" className="p-6">
      <h1 className="mb-2 text-lg font-black text-pop-ink">📜 LOG.md 时间线</h1>
      <div className="mb-4 text-[10px] text-pop-dim">append-only · 行首「## [日期] 动作 | 对象」可 grep · 详情看 git show</div>

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="前缀过滤">
        {FILTER_OPS.map(op => (
          <button
            key={op}
            type="button"
            onClick={() => onFilter(op)}
            className={cn(
              "rounded-full border-[1.5px] border-pop-bd px-3 py-1 text-[11px] font-black",
              filter === op ? "bg-pop-yellow text-pop-bg" : "bg-pop-paper text-pop-dim hover:text-pop-ink",
            )}
          >
            {op}
          </button>
        ))}
      </div>

      <ol className="space-y-2">
        {shown.map((l, i) => (
          <li key={`${l.date}-${i}`} data-testid="kc-log-row" className="rounded-md border-[1.5px] border-pop-bd bg-pop-paper px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-mono text-[10px] text-pop-dim">## [{l.date}]</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-black", OP_TONE[l.op] ?? "bg-pop-idle text-pop-dim")}>{l.op}</span>
              <span className="break-all font-mono text-[11px] font-bold text-pop-ink">{l.title}</span>
            </div>
            {l.result && <div className="mt-1 text-[11px] text-pop-dim">→ {l.result}</div>}
          </li>
        ))}
        {shown.length === 0 && <li className="py-6 text-center text-xs text-pop-dim">该过滤下暂无行（wiki 首编译后出现）</li>}
      </ol>
    </div>
  )
}
