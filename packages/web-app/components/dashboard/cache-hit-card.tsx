"use client"

import { Zap } from "lucide-react"
import type { CacheSourceStat } from "@/lib/api-client"
import { cn } from "@/lib/utils"

const SOURCE_LABEL: Record<string, string> = {
  global_chat: "主对话",
  clone_chat: "任务对话",
  workflow: "工作流节点",
  session_compress: "会话压缩",
  unknown: "其他",
}

interface CacheHitCardProps {
  sources: CacheSourceStat[]
  windowDays: number
}

/**
 * Prompt-cache hit rate by source. System-prompt drift invalidates the whole
 * cached transcript, so this card is the early-warning surface for that
 * regression (see schema v56 session_prompt_snapshots).
 */
export function CacheHitCard({ sources, windowDays }: CacheHitCardProps) {
  const totals = sources.reduce(
    (acc, s) => ({
      read: acc.read + s.cacheReadTokens,
      creation: acc.creation + s.cacheCreationTokens,
      input: acc.input + s.inputTokens,
      calls: acc.calls + s.calls,
    }),
    { read: 0, creation: 0, input: 0, calls: 0 },
  )
  const overall =
    totals.read + totals.creation + totals.input > 0
      ? totals.read / (totals.read + totals.creation + totals.input)
      : null

  return (
    <div className="rounded-xl border border-pop-bd/40 bg-pop-paper p-5 shadow-pop-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-black text-pop-ink">
            <Zap className="size-4 text-pop-amber" strokeWidth={1.8} />
            提示缓存命中
          </h2>
          <p className="mt-1 text-[11px] text-pop-dim">
            近 {windowDays} 天 · 命中 = 复用已缓存前缀，未命中 = 重新计算 system + 历史
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-black tabular-nums text-pop-ink">
            {overall == null ? "—" : `${Math.round(overall * 100)}%`}
          </div>
          <div className="text-[10px] text-pop-dim">{totals.calls} 次调用</div>
        </div>
      </div>

      {sources.length === 0 ? (
        <p className="mt-5 text-[11.5px] text-pop-dim">窗口内还没有 LLM 调用记录。</p>
      ) : (
        <div className="mt-4 space-y-3">
          {sources.map((source) => {
            const rate = source.hitRate
            const pct = rate == null ? 0 : Math.round(rate * 100)
            return (
              <div key={source.sourcePath}>
                <div className="flex items-baseline justify-between gap-3 text-[11px]">
                  <span className="font-medium text-pop-ink">
                    {SOURCE_LABEL[source.sourcePath] ?? source.sourcePath}
                  </span>
                  <span className="font-mono tabular-nums text-pop-dim">
                    {rate == null ? "—" : `${pct}%`} · {source.calls} 次
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      pct >= 70
                        ? "bg-pop-green"
                        : pct >= 35
                          ? "bg-pop-amber"
                          : "bg-pop-red/80",
                    )}
                    style={{ width: `${Math.max(2, pct)}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
