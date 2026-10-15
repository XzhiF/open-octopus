"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { kcListFindings, type KcFindingView, type KcHealth } from "@/lib/knowledge/knowledge-center-api"

/**
 * 健康条 — 票11，口径逐字对票面/spec 故事 10/原型 Tab④ kbar：
 *   页数（按类）/ raw 源数 / 本周 ingest / 开放 findings / 编译队列深度 / 最近编译 / git HEAD。
 * **没有「待审核」计数**——那个概念已废除（spec D6；原型行 592 交互纪律）。
 * 失败显形（CODING_STANDARDS #2：取数失败不得伪造零值）。
 * P4 票08：健康分 0-100 槽（null=空库/未装配诚实不可评，不伪造满分——avgConfidence 同律）；
 * 点开出 ranked findings（按 severity 分组，故事 14 裁决动线）——**复用既有
 * GET /findings 列表通道**（数据面=票08 severity 派生键），零新端点零新页面；
 * 处方出口仍在对话 finding 卡（红线2：这里只列不改，无按钮无审批形态）。
 */
export function HealthBar({ health, error }: { health: KcHealth | null; error: string | null }) {
  const [rankedOpen, setRankedOpen] = useState(false)
  if (error) {
    return (
      <div data-testid="kc-health-error" className="border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-2 text-xs font-bold text-pop-red">
        健康条加载失败：{error}
      </div>
    )
  }
  if (!health) {
    return (
      <div className="border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-2 text-xs text-pop-dim">健康条加载中…</div>
    )
  }
  const p = health.pages
  const score = health.score
  return (
    <>
      <div
        data-testid="kc-health-bar"
        className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-2 text-xs font-bold text-pop-dim"
      >
        <span className="text-pop-ink">⚡ 知识中心 · 全局 wiki</span>
        <span>
          页 <b className="text-pop-ink">{p.total}</b>
          <span className="text-pop-dim">
            （实体 {p.entity} · 概念 {p.concept} · 主题 {p.topic} · 来源 {p.source} · 判例 {p.case}）
          </span>
        </span>
        <span>raw 源 <b className="text-pop-ink">{health.rawSources}</b></span>
        <span>本周 ingest <b className="text-pop-ink">{health.ingestedThisWeek}</b></span>
        {/* P4 票07：全库平均 confidence（已测行口径；null=全未测/未装配 ⇒ 诚实 —，不伪造 0.5 初值均值） */}
        <span data-testid="kc-health-confidence">平均置信 <b className="text-pop-ink">{health.avgConfidence == null ? "—" : health.avgConfidence}</b></span>
        {/* P4 票08：健康分（公式单源服务端；null ⇒ 诚实 —，不伪造满分）。明细=页内弹层非新页面 */}
        <span data-testid="kc-health-score" className={cn(
          score != null && score < 60 && "text-pop-red",
          score != null && score >= 60 && score < 90 && "text-pop-amber",
        )}>
          健康分 <b className={cn(score == null || score >= 90 ? "text-pop-ink" : undefined)}>{score == null ? "—" : score}</b>
          <button
            type="button"
            data-testid="kc-health-score-toggle"
            onClick={() => setRankedOpen(v => !v)}
            aria-expanded={rankedOpen}
            className="ml-2 border border-pop-bd px-1.5 py-0.5 text-[10px] font-bold text-pop-dim hover:text-pop-ink"
          >
            {rankedOpen ? "收起明细" : "点开明细"}
          </button>
        </span>
        <span className={cn(health.openFindings > 0 && "text-pop-amber")}>
          findings <b>{health.openFindings}</b>
        </span>
        <span>队列 <b className="text-pop-ink">{health.queueDepth}</b></span>
        <span>最近编译 <b className="text-pop-ink">{health.lastCompiled || "—"}</b></span>
        <span className="font-mono text-[10px]">HEAD {health.gitHead ? health.gitHead.slice(0, 7) : "—"}</span>
        <span className="ml-auto text-[10px]">只读浏览 · 写入仅策展通道</span>
      </div>
      {rankedOpen && <RankedFindingsPanel />}
    </>
  )
}

/** ranked 分组组序=severity 降档（紧急→重要→一般；空组不显）。 */
const SEVERITY_GROUPS: Array<{ key: KcFindingView["severity"]; label: string }> = [
  { key: "critical", label: "紧急" },
  { key: "major", label: "重要" },
  { key: "minor", label: "一般" },
]

/**
 * 点开健康分 → 开放 findings 按 severity 分组清单（P4 票08·故事 14）。
 * 数据通道=既有 kcListFindings("open")（GET /findings，票08 severity 派生键）——
 * 本层只列不裁：裁决动线保持对话 finding 卡三钮（红线2 零新审批形态、零按钮副作用）。
 * 取数失败显形不伪造空态（CODING_STANDARDS #2，健康条本体同律）。
 */
function RankedFindingsPanel() {
  const [rows, setRows] = useState<KcFindingView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    kcListFindings("open")
      .then(r => { if (alive) setRows(r) })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [])
  const cls = "border-b-[1.5px] border-pop-bd bg-pop-paper px-4 py-2 text-xs text-pop-dim"
  if (err) {
    return <div data-testid="kc-ranked-error" className={cn(cls, "font-bold text-pop-red")}>明细加载失败：{err}</div>
  }
  if (!rows) {
    return <div className={cls}>明细加载中…</div>
  }
  const groups = SEVERITY_GROUPS
    .map(g => ({ ...g, items: rows.filter(r => r.severity === g.key) }))
    .filter(g => g.items.length > 0)
  return (
    <div data-testid="kc-ranked-findings" className={cls}>
      {groups.length === 0 ? (
        <span className="font-bold text-pop-ink">无开放 finding · 健康态</span>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map(g => (
            <div key={g.key} data-testid={`kc-ranked-group-${g.key}`}>
              <b className={cn("mr-2", g.key === "critical" && "text-pop-red", g.key === "major" && "text-pop-amber")}>
                {g.label}（{g.items.length}）
              </b>
              <ul className="ml-4 list-disc">
                {g.items.map(f => (
                  <li key={f.id}>
                    <span className="text-pop-ink">[{f.kind}]</span> {f.title}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <span className="text-[10px]">处方出口=对话 finding 卡裁决（采纳/忽略/讨论）——本层只列不改</span>
        </div>
      )}
    </div>
  )
}
