"use client"

import { cn } from "@/lib/utils"
import type { KcHealth } from "@/lib/knowledge/knowledge-center-api"

/**
 * 健康条 — 票11，口径逐字对票面/spec 故事 10/原型 Tab④ kbar：
 *   页数（按类）/ raw 源数 / 本周 ingest / 开放 findings / 编译队列深度 / 最近编译 / git HEAD。
 * **没有「待审核」计数**——那个概念已废除（spec D6；原型行 592 交互纪律）。
 * 失败显形（CODING_STANDARDS #2：取数失败不得伪造零值）。
 */
export function HealthBar({ health, error }: { health: KcHealth | null; error: string | null }) {
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
  return (
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
      <span className={cn(health.openFindings > 0 && "text-pop-amber")}>
        findings <b>{health.openFindings}</b>
      </span>
      <span>队列 <b className="text-pop-ink">{health.queueDepth}</b></span>
      <span>最近编译 <b className="text-pop-ink">{health.lastCompiled || "—"}</b></span>
      <span className="font-mono text-[10px]">HEAD {health.gitHead ? health.gitHead.slice(0, 7) : "—"}</span>
      <span className="ml-auto text-[10px]">只读浏览 · 写入仅策展通道</span>
    </div>
  )
}
