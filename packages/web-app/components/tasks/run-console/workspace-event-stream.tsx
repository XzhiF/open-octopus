// packages/web-app/components/tasks/run-console/workspace-event-stream.tsx
//
// 票 11 ⑩回补 — 「▶ 控制台 / ▶ 日志」页签的工作区事件流（原型 consoleHtml）。
// 数据 = 绑定执行的 agent_events（壳层 5s 轮询单源 —— live 轮新事件 ≤10s 可见，
// AC2 由既有 fetchAgentEvents 通道兑现，不新开 SSE）。行映射走 log-model
// （nodes-model 分类词表 + 时间正序），⚑ 人工干预 = pink 高亮行。

"use client"

import { useEffect, useRef } from "react"
import type { AgentEvent } from "@/lib/types"
import { buildLogLines, type LogLine } from "./log-model"

const LINE_TONE: Record<LogLine["tone"], string> = {
  ink: "text-pop-ink", dim: "text-pop-dim", green: "text-pop-green",
  red: "text-pop-red", pink: "text-pop-pink", amber: "text-pop-amber",
}

function clockOf(iso: string | null): string {
  if (!iso) return "--:--:--"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "--:--:--"
  return d.toLocaleTimeString("zh-CN", { hour12: false })
}

export function WorkspaceEventStream({ events, live }: { events: AgentEvent[]; live: boolean }) {
  const lines = buildLogLines(events)
  const boxRef = useRef<HTMLDivElement | null>(null)
  // 直播跟随：底部钉住新行（用户上翻时不强拉 —— scrollTop 闸）。
  useEffect(() => {
    const el = boxRef.current
    if (!el || !live) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [lines.length, live])

  return (
    <div
      ref={boxRef}
      data-testid="workspace-event-stream"
      data-stream-live={live ? "true" : undefined}
      className="max-h-[42vh] min-h-0 overflow-y-auto rounded-lg border-[1.5px] border-pop-bd bg-pop-idle px-2.5 py-2 font-mono"
    >
      <div className="mb-1 flex items-center gap-2 px-0.5 font-mono text-[9.5px] font-black tracking-[.1em] text-pop-dim">
        工作区事件流 / AGENT_EVENTS
        <span className="ml-auto font-normal">{live ? "● 5s 追加" : "○ 已停轮询"}</span>
      </div>
      {lines.length === 0 ? (
        <div className="px-0.5 py-1 text-[11px] text-pop-dim" data-testid="workspace-log-empty">
          {live ? "等待节点事件…" : "本轮没有可读的工作流事件（未绑定执行或暂无落库）。"}
        </div>
      ) : (
        lines.map((l, i) => (
          <div
            key={`${l.at ?? "t"}-${i}`}
            data-testid="workspace-log-line"
            {...(l.intervention ? { "data-log-intervention": "true" } : {})}
            title={l.detail ? `${l.text} — ${l.detail}` : l.text}
            className={`flex items-baseline gap-1.5 truncate px-0.5 py-px text-[11px] ${LINE_TONE[l.tone] ?? "text-pop-ink"} ${l.intervention ? "rounded bg-pop-pink-soft font-black" : ""}`}
          >
            <span aria-hidden className="shrink-0 text-[9.5px] text-pop-dim">{clockOf(l.at)}</span>
            <span aria-hidden className="shrink-0 font-black">{l.glyph}</span>
            <span className="truncate">{l.text}</span>
          </div>
        ))
      )}
    </div>
  )
}
