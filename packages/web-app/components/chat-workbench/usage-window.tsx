'use client'

// 2026-10-28 task-thread M5: the task's whole-lifecycle ledger as its own
// window (main chat + every round + fix + archiving reflection).

import { useEffect, useState } from 'react'
import { getTaskUsage, type TaskUsagePayload } from '@/lib/tasks-api'
import { formatCost, formatPercent, formatTokenCount } from '@/lib/format'
import { useBillingCurrency } from '@/lib/billing-currency'
import { Spinner } from '@/components/ui/spinner'

export function UsageWindow({ taskId, versionKey }: { taskId: string; versionKey?: string | number }) {
  const [usage, setUsage] = useState<TaskUsagePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currency = useBillingCurrency()

  useEffect(() => {
    let alive = true
    const load = () => {
      getTaskUsage(taskId)
        .then((next) => { if (alive) { setUsage(next); setError(null) } })
        .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : '读取任务账本失败') })
    }
    load()
    const timer = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [taskId, versionKey])

  if (error) {
    return <div className="p-4 text-[11.5px] text-pop-red" data-testid="usage-window-error">{error}</div>
  }
  if (!usage) {
    return (
      <div className="flex h-full items-center gap-2 p-6 text-[11px] text-pop-dim">
        <Spinner className="size-3.5" /> 读取任务账本…
      </div>
    )
  }

  const { summary, breakdown } = usage
  const max = Math.max(1, ...breakdown.map((p) => p.totals.tokens))

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="usage-window">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9.5px] font-black tracking-[.08em] text-pop-dim">TASK LEDGER · 任务周期</span>
        <span className="rounded-full border border-pop-cyan/40 bg-pop-cyan-soft px-2 py-[3px] font-mono text-[10px] font-black text-pop-cyan">
          tok {formatTokenCount(summary.totals.tokens)} · {formatCost(summary.totals.cost.usd, summary.totals.cost.complete, currency)}
        </span>
        <span className="ml-auto font-mono text-[9.5px] text-pop-dim">
          {summary.totalCalls} 次请求 · cache {formatPercent(summary.totals.cacheHitRate, 1)}
        </span>
      </div>

      {breakdown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-pop-bd px-4 py-10 text-center text-[11.5px] text-pop-dim">
          任务还没有产生用量。
        </div>
      ) : (
        <div className="space-y-1">
          {breakdown.map((part) => {
            const key = `${part.kind}:${part.session_id ?? part.execution_id ?? part.label}`
            return (
              <div key={key} className="flex items-center gap-2 rounded-lg border border-pop-bd/60 bg-pop-paper/40 px-2.5 py-2">
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${part.kind === 'chat' ? 'bg-pop-purple' : 'bg-pop-cyan'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-bold text-pop-ink">
                    {part.label}
                    {part.workflow_ref ? <span className="ml-1 font-mono text-[9px] text-pop-dim">· {part.workflow_ref}</span> : null}
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className={part.kind === 'chat' ? 'h-full bg-pop-purple' : 'h-full bg-pop-cyan'}
                      style={{ width: `${Math.max(2, (part.totals.tokens / max) * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="w-24 text-right font-mono text-[10.5px] tabular-nums text-pop-ink">
                  {formatTokenCount(part.totals.tokens)}
                </div>
                <div className="w-20 text-right font-mono text-[9.5px] tabular-nums text-pop-dim">
                  {formatCost(part.totals.cost.usd, part.totals.cost.complete, currency)}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-pop-bd pt-2.5">
        <span className="text-[12px] font-black text-pop-ink">合计</span>
        <span className="font-mono text-[12px] font-black text-pop-ink">{formatTokenCount(summary.totals.tokens)} tok</span>
        <span className="ml-auto font-mono text-[10px] text-pop-dim">
          cache {formatPercent(summary.totals.cacheHitRate, 1)} · {formatCost(summary.totals.cost.usd, summary.totals.cost.complete, currency)}
        </span>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-pop-dim/80">
        口径：任务主对话（含作者/执行者身份）+ 该任务全部执行轮（含修复轮/子执行）；带 execution_id 的账只走执行趟，会话趟只认 execution_id 为空的行，防双计。
      </p>
    </div>
  )
}
