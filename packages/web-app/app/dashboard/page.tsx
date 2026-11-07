"use client"

import { useCallback, useEffect, useState } from "react"
import { TodayBurn } from "@/components/dashboard/today/today-burn"
import { TodayStats } from "@/components/dashboard/today/today-stats"
import { TodayTimeline } from "@/components/dashboard/today/today-timeline"
import { TodayChanges } from "@/components/dashboard/today/today-changes"
import { fetchTodayDigest, type TodayDigest } from "@/lib/today"

/**
 * 今日 —— 一天的工作状态（不是报表）。
 *
 * 三块：① 总消耗（账本当天窗口）② 统计小结 + 精选时间线 ③ 精选变动。
 * 小结只做统计、不用 LLM；时间线与变动都由服务端精选后下发，前端不再二次筛选。
 * 30s 轮询保持「现在」节点和运行指示新鲜（页面本身是一次 GET）。
 */

const REFRESH_INTERVAL_MS = 30_000

function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "--:--"
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export default function TodayPage() {
  const [digest, setDigest] = useState<TodayDigest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const next = await fetchTodayDigest()
      setDigest(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取今日数据失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  if (loading && !digest) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-pop-dim">加载今日…</div>
    )
  }

  if (error && !digest) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-[11px]">
        <p className="text-pop-red">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="h-7 rounded-lg border-[1.5px] border-pop-bd px-3 font-bold text-pop-dim hover:bg-pop-idle hover:text-pop-ink"
        >
          重试
        </button>
      </div>
    )
  }

  if (!digest) return null

  const runningTasks = digest.stats.tasks.breakdown.find((row) => row.key === "running")?.count ?? 0
  const runningChats = digest.stats.chats.running

  return (
    <div className="px-7 pb-2.5 pt-5">
      <div className="flex items-baseline gap-3">
        <h1 className="m-0 text-[22px] font-black tracking-[-0.02em]">今日</h1>
        <span className="text-[10.5px] tracking-[0.04em] text-pop-dim">
          {digest.date} {digest.weekday} · {clock(digest.generated_at)}
        </span>
        <div className="ml-auto flex items-center gap-3.5 text-[10px] text-pop-dim">
          <span className="flex items-center gap-1.5">
            <i className={`inline-block h-1.5 w-1.5 rounded-full ${runningChats > 0 ? "animate-pulse bg-pop-cyan" : "bg-pop-bd"}`} />
            {runningChats} 段对话在跑
          </span>
          <span className="flex items-center gap-1.5">
            <i className={`inline-block h-1.5 w-1.5 rounded-full ${runningTasks > 0 ? "animate-pulse bg-pop-amber" : "bg-pop-bd"}`} />
            {runningTasks} 个任务轮次
          </span>
        </div>
      </div>

      <TodayBurn consumption={digest.consumption} />
      <TodayStats stats={digest.stats} />

      <div className="mt-3 grid grid-cols-[1.3fr_1fr] items-start gap-[30px]">
        <TodayTimeline
          nodes={digest.timeline.nodes}
          rule={digest.timeline.rule}
          candidates={digest.timeline.candidates}
        />
        <TodayChanges items={digest.changes.items} />
      </div>

      {error && <p className="mt-2 text-[9px] text-pop-red">刷新失败：{error}</p>}
    </div>
  )
}