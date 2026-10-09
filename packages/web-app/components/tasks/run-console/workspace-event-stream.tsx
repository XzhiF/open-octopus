// packages/web-app/components/tasks/run-console/workspace-event-stream.tsx
//
// 票 11 ⑩回补 — 「▶ 控制台 / ▶ 日志」页签的工作区事件流（原型 consoleHtml 纯流形态）。
// 数据 = 绑定执行的 agent_events：优先既有 SSE 通道
// （GET /api/workspaces/:ws/executions/events，EngineCallbacks 以 "agent_event" emit，
// 壳层经 log-model.agentEventFromWire 实时追加）；5s 轮询（fetchAgentEvents）退位为
// 兜底/首屏 —— 票11 双轴 review 收口①。行映射走 log-model（nodes-model 分类词表 +
// 时间正序），⚑ 人工干预 = pink 高亮行。
//
// 票11 收口②：壳层原下叠的 InterventionStream digest 块撤场（一事实一现），票06 的
// testid 契约转钉到**流内 ⚑ 行**：含 ⚑ 行时行容器挂 intervention-log、每条 ⚑ 行挂
// intervention-line（无干预 = 两块 testid 都不存在，票06 缺席断言语义不变）。
// ⑪真机复点：盒 = 原型 .console 满高形态（flex-1 铺到底 + inset 底 + 盒内滚动），
// 贴底跟随闸抽为 log-model.nearStreamBottom 纯函数（可单测）。

"use client"

import { useEffect, useRef } from "react"
import type { AgentEvent } from "@/lib/types"
import { buildLogLines, nearStreamBottom, type LogLine } from "./log-model"

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
  // 直播跟随（⑪铺到底版）：闸 = log-model.nearStreamBottom 纯函数 —— 贴底才把
  // 新行滚进来（80px 缓冲），用户手动上翻回看不被抢滚动；空盒/初始态视为贴底。
  useEffect(() => {
    const el = boxRef.current
    if (!el || !live) return
    if (nearStreamBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) el.scrollTop = el.scrollHeight
  }, [lines.length, live])

  // 票06 testid 契约（收口②转钉版）：有 ⚑ 行时行容器 = intervention-log，
  // ⚑ 行 = intervention-line；无干预两块都不挂 —— 「留痕在场」与「日志区在场」同义。
  const hasIntervention = lines.some((l) => l.intervention)

  return (
    <div
      ref={boxRef}
      data-testid="workspace-event-stream"
      data-stream-live={live ? "true" : undefined}
      // ⑪真机复点 · 日志铺到底 = 原型 .console{height:100%;background:var(--inset)}：
      // flex-1 + min-h-0 撑满内容区到底（旧 max-h-[42vh] 半屏浮块撤），滚动权在盒内；
      // bg-pop-idle = inset 内框衬底（页签底 = 壳净黑同底，此层是原型规定的内框而非亮卡）。
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border-[1.5px] border-pop-bd bg-pop-idle px-2.5 py-2 font-mono"
    >
      <div className="mb-1 flex items-center gap-2 px-0.5 font-mono text-[9.5px] font-black tracking-[.1em] text-pop-dim">
        工作区事件流 / AGENT_EVENTS
        <span className="ml-auto font-normal">{live ? "● 实时追加（SSE·轮询兜底）" : "○ 已停轮询"}</span>
      </div>
      {lines.length === 0 ? (
        <div className="px-0.5 py-1 text-[11px] text-pop-dim" data-testid="workspace-log-empty">
          {live ? "等待节点事件…" : "本轮没有可读的工作流事件（未绑定执行或暂无落库）。"}
        </div>
      ) : (
        <div {...(hasIntervention ? { "data-testid": "intervention-log" } : undefined)}>
          {lines.map((l, i) => (
            <div
              key={`${l.at ?? "t"}-${i}`}
              {...(l.intervention
                ? { "data-testid": "intervention-line", "data-log-intervention": "true" }
                : { "data-testid": "workspace-log-line" })}
              title={l.detail ? `${l.text} — ${l.detail}` : l.text}
              className={`flex items-baseline gap-1.5 truncate px-0.5 py-px text-[11px] ${LINE_TONE[l.tone] ?? "text-pop-ink"} ${l.intervention ? "rounded bg-pop-pink-soft font-black" : ""}`}
            >
              <span aria-hidden className="shrink-0 text-[9.5px] text-pop-dim">{clockOf(l.at)}</span>
              <span aria-hidden className="shrink-0 font-black">{`${l.glyph} `}</span>
              <span className="truncate">{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
