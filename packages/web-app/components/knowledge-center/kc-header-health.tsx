"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import type { KcHealth } from "@/lib/knowledge/knowledge-center-api"

/**
 * 页头健康件 — 只读知识库（2026-11-03）。
 *
 * 三槽 = 健康分 / 页数 / raw 源数，点开出弹层收全量只读指标。
 * **不列 findings、不显示编译队列、不做裁决入口**：wiki 冲突与维护已回到主对话，
 * 这里只回答「这个库现在有多少内容、状态如何」。
 */

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
        title="点开全量只读指标"
      >
        <span className={cn(score != null && score < 60 && "text-pop-red", score != null && score >= 60 && score < 90 && "text-pop-amber")}>
          ⚡ {score == null ? "—" : score}
        </span>
        <span>▤ {health.pages.total}</span>
        <span>⌁ {health.rawSources}</span>
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
          <div className="px-3 py-2 text-[10px] leading-relaxed text-pop-dim">
            只读知识库。写入与冲突裁决在主对话里完成：归档收口时由归档 Agent 逐条确认，普通会话里说「把这条写进 wiki」。
          </div>
        </div>
      )}
    </div>
  )
}
