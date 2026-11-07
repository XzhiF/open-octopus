"use client"

import { TIMELINE_KIND_LABEL, type TodayTimelineKind, type TodayTimelineNode } from "@/lib/today"

/**
 * 时间线 —— 精选节点，不是全量流水。
 *
 * 入选规则由服务端执行（任务状态跃迁 / 分身资产变更 / 知识入库 / 你做出的决定），
 * 前端只负责呈现与排序；「现在」节点永远在最后。
 */

const KIND_STYLE: Record<TodayTimelineKind, { dot: string; tag: string; bg: string; border: string }> = {
  chat: { dot: "var(--pop-cyan)", tag: "var(--pop-cyan)", bg: "var(--pop-cyan-soft)", border: "color-mix(in srgb, var(--pop-cyan) 35%, var(--pop-bd))" },
  task: { dot: "var(--pop-amber)", tag: "var(--pop-amber)", bg: "var(--pop-amber-soft)", border: "color-mix(in srgb, var(--pop-amber) 35%, var(--pop-bd))" },
  agent: { dot: "var(--pop-violet)", tag: "var(--pop-violet)", bg: "var(--pop-violet-soft)", border: "color-mix(in srgb, var(--pop-violet) 35%, var(--pop-bd))" },
  clone: { dot: "var(--pop-purple)", tag: "var(--pop-purple)", bg: "var(--pop-purple-soft)", border: "color-mix(in srgb, var(--pop-purple) 35%, var(--pop-bd))" },
  know: { dot: "var(--pop-green)", tag: "var(--pop-green)", bg: "var(--pop-green-soft)", border: "color-mix(in srgb, var(--pop-green) 35%, var(--pop-bd))" },
  now: { dot: "var(--pop-pink)", tag: "var(--pop-pink)", bg: "var(--pop-pink-soft)", border: "color-mix(in srgb, var(--pop-pink) 35%, var(--pop-bd))" },
}

const TONE_DOT: Record<NonNullable<TodayTimelineNode["tone"]>, string> = {
  ok: "var(--pop-green)",
  warn: "var(--pop-yellow)",
  bad: "var(--pop-red)",
  info: "var(--pop-pink)",
}

function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "--:--"
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function TodayTimeline({ nodes, rule, candidates }: {
  nodes: TodayTimelineNode[]
  rule: string
  candidates: number
}) {
  const first = nodes[0]
  const meta = nodes.length > 0 && first ? `精选 ${nodes.length} 个节点 · ${clock(first.ts)} → 现在` : `0 个节点`

  return (
    <section aria-label="今日时间线">
      <div className="mb-2.5 flex items-baseline gap-2.5 border-b-[1.5px] border-pop-bd pb-2">
        <h2 className="text-[11px] font-black uppercase tracking-[0.1em]">时间线</h2>
        <span className="ml-auto text-[9.5px] text-pop-dim">
          {meta}
          {candidates > nodes.length ? ` · 候选 ${candidates}` : ""}
        </span>
      </div>

      <p className="mb-3.5 border-l-2 border-pop-bd pl-[9px] text-[9px] leading-relaxed text-pop-dim opacity-80">
        {rule}
      </p>

      {nodes.length === 0 ? (
        <p className="py-6 text-center text-[11px] text-pop-dim">今天还没有值得记录的节点。</p>
      ) : (
        <div className="relative">
          <div className="absolute bottom-[14px] left-[71px] top-[9px] w-px bg-gradient-to-b from-pop-bd from-85% to-transparent" />
          {nodes.map((node, i) => {
            const style = KIND_STYLE[node.kind]
            const dotColor = node.tone ? TONE_DOT[node.tone] : style.dot
            const isNow = node.kind === "now"
            return (
              <div
                key={`${node.ts}-${i}`}
                className="relative grid grid-cols-[52px_16px_minmax(0,1fr)] gap-3 pb-[11px]"
              >
                <time className="pt-[3px] text-right text-[10px] text-pop-dim">{clock(node.ts)}</time>
                <span
                  className={`z-[1] mt-1 h-[9px] w-[9px] justify-self-center rounded-full ${isNow ? "animate-pulse" : ""}`}
                  style={{
                    background: dotColor,
                    boxShadow: isNow
                      ? "0 0 0 3px var(--pop-bg), 0 0 0 6px rgba(255,133,92,.14)"
                      : "0 0 0 3px var(--pop-bg)",
                  }}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-[7px] text-[12px] font-extrabold tracking-[-0.01em]">
                    <span className="min-w-0">{node.title}</span>
                    <span
                      className="inline-flex h-[15px] flex-none items-center rounded-full border px-1.5 text-[8px] font-extrabold tracking-[0.06em]"
                      style={{ color: style.tag, background: style.bg, borderColor: style.border }}
                    >
                      {TIMELINE_KIND_LABEL[node.kind]}
                    </span>
                  </div>
                  {node.detail && <div className="mt-0.5 text-[11px] leading-normal text-pop-dim">{node.detail}</div>}
                  {node.meta && <div className="mt-[3px] text-[9px] text-pop-dim opacity-80">{node.meta}</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}