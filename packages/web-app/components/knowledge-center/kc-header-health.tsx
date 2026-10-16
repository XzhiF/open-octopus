"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { kcListFindings, type KcFindingView, type KcHealth } from "@/lib/knowledge/knowledge-center-api"

/**
 * 页头健康件 — 知识中心改版 ADR-0033：原整行文字统计瘦身为三槽（健康分 / 开放
 * findings / 队列深度），点开出弹层收**全量指标**（页数按类/raw 源数/本周 ingest/
 * 平均置信/最近编译/git HEAD——一个不砍，只换收纳）+ ranked findings 分组
 * （P4 票08·故事 14 动线不变：复用既有 GET /findings 通道，本层只列不裁，
 * 裁决出口=对话 finding 卡三钮，红线2 零新审批形态）。
 * **没有「待审核」计数**——概念已废除（spec 故事 10）。失败显形不伪造零值
 * （CODING_STANDARDS #2）。
 */

const SEVERITY_GROUPS: Array<{ key: KcFindingView["severity"]; label: string }> = [
  { key: "critical", label: "紧急" },
  { key: "major", label: "重要" },
  { key: "minor", label: "一般" },
]

/** 开放 findings 按 severity 分组清单（原 RankedFindingsPanel 同律，进弹层）。 */
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
  if (err) {
    return <div data-testid="kc-ranked-error" className="px-3 py-2 text-xs font-bold text-pop-red">明细加载失败：{err}</div>
  }
  if (!rows) {
    return <div className="px-3 py-2 text-xs text-pop-dim">明细加载中…</div>
  }
  const groups = SEVERITY_GROUPS
    .map(g => ({ ...g, items: rows.filter(r => r.severity === g.key) }))
    .filter(g => g.items.length > 0)
  return (
    <div data-testid="kc-ranked-findings" className="px-3 py-2 text-xs text-pop-dim">
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

export function KcHeaderHealth({ health, error }: { health: KcHealth | null; error: string | null }) {
  const [open, setOpen] = useState(false)
  if (error) {
    return (
      <button
        type="button"
        data-testid="kc-health-error"
        onClick={() => setOpen(v => !v)}
        className="rounded-md border-[1.5px] border-pop-red px-2 py-1 text-[11px] font-bold text-pop-red"
      >
        健康条加载失败：{error}
      </button>
    )
  }
  if (!health) {
    return <span className="text-[11px] text-pop-dim">健康件加载中…</span>
  }
  const score = health.score
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="kc-health-bar"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex items-center gap-3 rounded-lg border-[1.5px] border-pop-bd bg-pop-paper px-2.5 py-1 text-[11px] font-bold text-pop-dim hover:text-pop-ink"
        title="点开全量指标与 findings 明细"
      >
        <span className={cn(score != null && score < 60 && "text-pop-red", score != null && score >= 60 && score < 90 && "text-pop-amber")}>
          ⚡ {score == null ? "—" : score}
        </span>
        <span className={cn(health.openFindings > 0 && "text-pop-amber")}>▲ {health.openFindings}</span>
        <span>⧗ {health.queueDepth}</span>
      </button>
      {open && (
        <div
          data-testid="kc-health-popover"
          className="absolute right-0 top-full z-40 mt-1 w-[min(520px,88vw)] rounded-xl border-[1.5px] border-pop-bd bg-pop-paper shadow-[var(--pop-shadow-lg)]"
        >
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b-[1.5px] border-pop-bd px-3 py-2 text-[11px] font-bold text-pop-dim">
            <span>
              页 <b className="text-pop-ink">{health.pages.total}</b>
              <span className="text-pop-dim">（实体 {health.pages.entity} · 概念 {health.pages.concept} · 主题 {health.pages.topic} · 来源 {health.pages.source} · 判例 {health.pages.case}）</span>
            </span>
            <span>raw 源 <b className="text-pop-ink">{health.rawSources}</b></span>
            <span>本周 ingest <b className="text-pop-ink">{health.ingestedThisWeek}</b></span>
            <span data-testid="kc-health-confidence">平均置信 <b className="text-pop-ink">{health.avgConfidence == null ? "—" : health.avgConfidence}</b></span>
            <span>最近编译 <b className="text-pop-ink">{health.lastCompiled || "—"}</b></span>
            <span className="font-mono text-[10px]">HEAD {health.gitHead ? health.gitHead.slice(0, 7) : "—"}</span>
          </div>
          <RankedFindingsPanel />
        </div>
      )}
    </div>
  )
}
