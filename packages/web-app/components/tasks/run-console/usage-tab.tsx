// packages/web-app/components/tasks/run-console/usage-tab.tsx
//
// 票 11 ⑩回补 — ▤ 消耗页签：既有 TaskAiUsageCard（总计瓷砖 / 按模型 / 分轮账本，
// K/M 记数 —— 票02/10 定版的三段）升格挂载，并补「按会话/节点」明细表
// （逐轮逐节点行 + task-doer 对话单独一行，两账不混，ADR-0025）。
//
// doer 账本现拉：GET /api/sessions/:id/llm-calls（会话口径单源），仅在
// task.doer_session_id 存在时发起；无对话历史 = 整行不出现（usage-model 判据）。

"use client"

import { useEffect, useState } from "react"
import type { LLMCallAggregates } from "@/lib/types"
import { fetchSessionLLMCalls } from "@/lib/observability-api"
import { AggInline, TaskAiUsageCard } from "../execution-summary"
import { buildUsageDetail } from "./usage-model"

export function UsageTab({
  agg, loading, runCount, rounds, doerSessionId,
}: {
  agg: LLMCallAggregates | null
  loading: boolean
  runCount: number
  /** 分轮行 = 壳层 runs/aggMap 单源（与卡内分轮账本同一份，不各拉各的）。 */
  rounds: Array<{ key: string; label: string; agg: LLMCallAggregates | null }>
  doerSessionId?: string | null
}) {
  const [doerAgg, setDoerAgg] = useState<LLMCallAggregates | null>(null)
  useEffect(() => {
    if (!doerSessionId) { setDoerAgg(null); return }
    let cancelled = false
    fetchSessionLLMCalls(doerSessionId)
      .then((r) => {
        if (cancelled) return
        setDoerAgg({ ...r.aggregates, toolCalls: 0 })
      })
      .catch(() => { if (!cancelled) setDoerAgg(null) })
    return () => { cancelled = true }
  }, [doerSessionId])

  const detail = buildUsageDetail({ rounds, doerSessionId, doerAgg })

  return (
    <div className="space-y-3" data-testid="usage-tab">
      <TaskAiUsageCard agg={agg} loading={loading} runCount={runCount} rounds={rounds} />
      <section className="rounded-lg border border-border p-3.5" data-testid="usage-detail">
        <header className="mb-1.5 flex items-baseline gap-2">
          <h3 className="text-sm font-semibold">按会话 / 节点</h3>
          <span className="text-[10.5px] text-muted-foreground">
            数据源 agent_events / llm_calls 汇总 — 工作流节点与 task-doer 对话分列（UI 一面 · 账务两会话不混记，ADR-0025）
          </span>
        </header>
        {detail.nodeRows.length === 0 && !detail.doerRow ? (
          <p className="py-1 text-xs text-muted-foreground" data-testid="usage-detail-empty">
            {loading ? "明细读取中…" : "暂无逐节点落库账本（llm_calls 在节点结束时写入；半途中止的运行可能缺数）。"}
          </p>
        ) : (
          <table className="w-full border-collapse font-mono text-[11px]" data-testid="usage-node-table">
            <thead>
              <tr className="text-left text-pop-dim">
                <th className="py-1 pr-2 font-black">会话 / 节点</th>
                <th className="py-1 font-black">账目（∑↑↓⚡🗡️·请求·成本）</th>
              </tr>
            </thead>
            <tbody>
              {detail.nodeRows.map((r) => (
                <tr key={r.key} data-testid="usage-node-row" className="border-t border-border/50">
                  <td className="max-w-[220px] truncate py-1 pr-2 font-bold" title={r.label}>{r.label}</td>
                  <td className="py-1">{r.agg ? <AggInline agg={r.agg} /> : <span className="text-pop-dim">缺数</span>}</td>
                </tr>
              ))}
              {detail.doerRow && (
                <tr key={detail.doerRow.key} data-testid="usage-doer-row" className="border-t border-pop-cyan/40 bg-pop-cyan-soft/40">
                  <td className="max-w-[220px] truncate py-1 pr-2 font-black text-pop-cyan" title={detail.doerRow.label}>
                    {detail.doerRow.label}
                  </td>
                  <td className="py-1"><AggInline agg={detail.doerRow.agg} /></td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
