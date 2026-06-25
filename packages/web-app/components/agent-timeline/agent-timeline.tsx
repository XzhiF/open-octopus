"use client"

import { useRef, useEffect, useState, useCallback } from "react"
import type { TurnGroup, LLMCallAggregates } from "@/lib/types"
import { cn } from "@/lib/utils"
import { AlertTriangle } from "lucide-react"
import { SummaryBar } from "./summary-bar"
import { TurnSection } from "./turn-section"
import { NewEventsIndicator } from "./new-events-indicator"
import { TimelineSkeleton } from "./timeline-skeleton"

interface AgentTimelineProps {
  executionId: string
  nodeId: string
  turns: TurnGroup[]
  isRunning: boolean
  loading: boolean
  error: Error | null
  isDegraded: boolean
  liveTurns?: TurnGroup[]
  llmAggregates?: LLMCallAggregates
}

function mergeTurns(base: TurnGroup[], live: TurnGroup[]): TurnGroup[] {
  if (live.length === 0) return base
  const merged = new Map<number, TurnGroup>()
  for (const turn of base) {
    merged.set(turn.turn_index, { ...turn })
  }
  for (const turn of live) {
    const existing = merged.get(turn.turn_index)
    if (existing) {
      const existingIds = new Set(existing.events.map(e => e.event_order))
      const newEvents = turn.events.filter(e => !existingIds.has(e.event_order))
      if (newEvents.length > 0) {
        merged.set(turn.turn_index, {
          ...existing,
          events: [...existing.events, ...newEvents],
          eventCount: existing.eventCount + newEvents.length,
        })
      }
    } else {
      merged.set(turn.turn_index, turn)
    }
  }
  return Array.from(merged.values()).sort((a, b) => a.turn_index - b.turn_index)
}

function computeAggregates(turns: TurnGroup[]) {
  let totalDurationMs = 0
  const turnDurations: { turnIndex: number; durationMs: number }[] = []

  for (const turn of turns) {
    if (turn.events.length === 0) continue
    const first = turn.events[0].timestamp
    const last = turn.events[turn.events.length - 1].timestamp
    const dur = last - first
    totalDurationMs += dur
    turnDurations.push({ turnIndex: turn.turn_index, durationMs: dur })
  }

  return { totalDurationMs, turnDurations }
}

export function AgentTimeline({
  executionId,
  nodeId,
  turns,
  isRunning,
  loading,
  error,
  isDegraded,
  liveTurns = [],
  llmAggregates,
}: AgentTimelineProps) {
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set())
  const [missedCount, setMissedCount] = useState(0)
  const [isNearBottom, setIsNearBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const allTurns = mergeTurns(turns, liveTurns)
  const { totalDurationMs, turnDurations } = computeAggregates(allTurns)

  const turnCount = allTurns.length
  const totalInputTokens = llmAggregates?.totalInputTokens ?? 0
  const totalOutputTokens = llmAggregates?.totalOutputTokens ?? 0
  const totalCostUsd = llmAggregates?.totalCost ?? 0

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
      setMissedCount(0)
      setIsNearBottom(true)
    }
  }, [])

  // Auto-scroll when new live events arrive and user is near bottom
  useEffect(() => {
    if (liveTurns.length > 0 && isNearBottom && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [liveTurns, isNearBottom])

  // Detect if user scrolled away from bottom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const handleScroll = () => {
      const threshold = 100
      const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
      setIsNearBottom(isAtBottom)
      if (!isAtBottom && isRunning) {
        // Count missed events would need a ref to live event count
      }
    }

    el.addEventListener("scroll", handleScroll, { passive: true })
    return () => el.removeEventListener("scroll", handleScroll)
  }, [isRunning])

  const toggleTurn = (turnIndex: number) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (next.has(turnIndex)) next.delete(turnIndex)
      else next.add(turnIndex)
      return next
    })
  }

  const liveTurnIndex = isRunning && allTurns.length > 0 ? allTurns[allTurns.length - 1].turn_index : -1

  if (loading) return <TimelineSkeleton />

  if (error) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-muted-foreground">
        加载追踪数据失败
      </div>
    )
  }

  if (allTurns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-sm text-muted-foreground">
        <p>暂无追踪数据 — 此执行在可观测性功能启用以前完成</p>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      {isDegraded && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>追踪数据暂时不可用。可观测性服务正在降级模式运行。</span>
        </div>
      )}

      <div className="p-3 border-b">
        <SummaryBar
          turnCount={turnCount}
          totalDurationMs={totalDurationMs}
          totalInputTokens={totalInputTokens}
          totalOutputTokens={totalOutputTokens}
          totalCostUsd={totalCostUsd}
          turnDurations={turnDurations}
        />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2">
        {allTurns.map((turn, i) => (
          <TurnSection
            key={i}
            turn={turn}
            isExpanded={expandedTurns.has(turn.turn_index)}
            isLive={isRunning && turn.turn_index === liveTurnIndex}
            onToggle={() => toggleTurn(turn.turn_index)}
          />
        ))}
      </div>

      <NewEventsIndicator
        count={missedCount}
        onScrollToBottom={scrollToBottom}
      />
    </div>
  )
}
