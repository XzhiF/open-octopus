"use client"

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Minus, GripHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"
import { useHarnessEvents, type ParsedHarnessEvent } from "@/hooks/use-harness-events"
import { HarnessChatbot } from "./harness-chatbot"
import { formatTokenCount } from "@/lib/analytics-format"

// ============ Types ============

interface HarnessFloatingPanelProps {
  workspaceId: string
  executionId: string
  executionStatus?: string
  currentNodeId?: string
}

// Default positions (absolute left/top)
const COLLAPSED_DEFAULT = { left: -1, top: 56 } // -1 = computed on mount
const EXPANDED_DEFAULT = { left: -1, top: 56 }
const DRAG_THRESHOLD = 4 // px — below this, treat as click

// ============ Collapsed Panel ============

function CollapsedPanel({
  interventionCount,
  isIntervening,
  isRunning,
  extraTokens,
  onExpand,
  onDragStart,
}: {
  interventionCount: number
  isIntervening: boolean
  isRunning: boolean
  extraTokens: number
  onExpand: () => void
  onDragStart: (e: React.MouseEvent) => void
}) {
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY }
    onDragStart(e)
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return
    const dx = Math.abs(e.clientX - mouseDownPos.current.x)
    const dy = Math.abs(e.clientY - mouseDownPos.current.y)
    mouseDownPos.current = null
    if (dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) {
      onExpand()
    }
  }

  const hasActivity = isRunning && interventionCount > 0

  return (
    <div
      className={cn(
        "w-[120px] h-[48px] rounded-lg border border-border bg-card shadow-lg cursor-grab active:cursor-grabbing flex flex-col items-center justify-center gap-0.5 opacity-70 hover:opacity-100 transition-opacity select-none",
        hasActivity && "border-violet-400/60",
      )}
      style={hasActivity ? { animation: "harness-pulse 3s ease-in-out infinite" } : undefined}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      data-testid="harness-panel-collapsed"
    >
      <style>{`
        @keyframes harness-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0); }
          50% { box-shadow: 0 0 12px 2px rgba(139, 92, 246, 0.3); }
        }
      `}</style>
      <div className="flex items-center gap-1 text-xs font-medium pointer-events-none">
        <span>🛡️</span>
        <span>{interventionCount}</span>
        <span className="text-muted-foreground">|</span>
        <span
          className={
            !isRunning
              ? "text-muted-foreground"
              : isIntervening
                ? "text-amber-500"
                : "text-emerald-500"
          }
        >
          {!isRunning ? "已完成" : isIntervening ? "干预中" : "监控中"}
        </span>
      </div>
      {extraTokens > 0 && (
        <span className="text-[10px] text-muted-foreground pointer-events-none">+{formatTokenCount(extraTokens)}</span>
      )}
    </div>
  )
}

// ============ Timeline Item ============

function TimelineItem({ event }: { event: ParsedHarnessEvent }) {
  const time = new Date(event.timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })

  let icon: string
  let label: string
  let colorClass: string

  switch (event.type) {
    case "harness_diagnosis": {
      const severity = event.report?.severity
      icon = severity === "critical" ? "🚨" : "⚠️"
      label = `${event.report?.detector ?? "检测"} ${event.nodeId ?? ""}`
      colorClass = severity === "critical" ? "text-red-400" : "text-amber-400"
      break
    }
    case "harness_intervention":
      icon = "🔄"
      label = event.action
        ? `${event.action.type} ${event.nodeId ?? ""}`
        : `干预 ${event.nodeId ?? ""}`
      colorClass = "text-blue-400"
      break
    case "harness_delegation": {
      const dr = event.delegationResult
      const decisionLabel: Record<string, string> = {
        block_node: "阻断",
        fix_and_retry: "修复重试",
        guide_and_retry: "指导重试",
        reconfigure_and_retry: "换配置重试",
        agent_takeover: "Agent 接管",
      }
      icon = dr?.success ? "🤖" : "🤖❌"
      const decision = dr?.decision ? (decisionLabel[dr.decision] ?? dr.decision) : "委托"
      const reason = dr?.blockReason ?? dr?.reasoning ?? ""
      label = reason
        ? `${decision} ${event.nodeId ?? ""}`
        : `${decision} ${event.nodeId ?? ""}`
      colorClass = dr?.success
        ? dr.decision === "block_node"
          ? "text-red-400"
          : "text-violet-400"
        : "text-muted-foreground"
      // Delegation gets a two-line layout: title + reasoning
      return (
        <div className="flex items-start gap-1.5 text-xs py-0.5">
          <span className="text-muted-foreground/60 shrink-0 tabular-nums">{time}</span>
          <span className="shrink-0">{icon}</span>
          <div className="min-w-0 flex-1">
            <div className={cn(colorClass)}>{label}</div>
            {reason && (
              <div className="text-muted-foreground whitespace-pre-wrap break-words mt-0.5 text-[11px]">
                {reason}
              </div>
            )}
          </div>
        </div>
      )
    }
    case "harness_blocked":
      icon = "🚨"
      label = `阻断 ${event.nodeId ?? ""}: ${event.reason ?? ""}`
      colorClass = "text-red-500"
      break
    default:
      icon = "•"
      label = event.type
      colorClass = "text-muted-foreground"
  }

  return (
    <div className="flex items-start gap-1.5 text-xs py-0.5">
      <span className="text-muted-foreground/60 shrink-0 tabular-nums">{time}</span>
      <span className="shrink-0">{icon}</span>
      <span className={cn("truncate", colorClass)}>{label}</span>
    </div>
  )
}

// ============ Monitor Tab ============

function MonitorTab({ events }: { events: ParsedHarnessEvent[] }) {
  const stats = useMemo(() => {
    const interventions = events.filter((e) => e.type === "harness_intervention").length
    const diagnoses = events.filter((e) => e.type === "harness_diagnosis").length
    const blocks = events.filter((e) => e.type === "harness_blocked").length
    // Aggregate token usage across all events
    let totalInput = 0
    let totalOutput = 0
    const models = new Set<string>()
    for (const e of events) {
      if (e.tokenUsage) {
        totalInput += e.tokenUsage.inputTokens ?? 0
        totalOutput += e.tokenUsage.outputTokens ?? 0
        if (e.tokenUsage.model) models.add(e.tokenUsage.model)
      }
      // Also check delegation result's token usage from nested result
      if (e.type === "harness_delegation" && e.delegationResult) {
        // delegationResult doesn't have tokenUsage directly, but event.tokenUsage captures it
      }
    }
    return { interventions, diagnoses, blocks, totalInput, totalOutput, models: Array.from(models) }
  }, [events])

  if (events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center py-6">
        暂无 Harness 事件
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Timeline */}
      <div className="flex-1 overflow-y-auto min-h-0 space-y-0.5 px-2 py-1">
        {events.map((event) => (
          <TimelineItem key={event.id} event={event} />
        ))}
      </div>

      {/* Stats footer */}
      <div className="shrink-0 border-t border-border/50 px-2 py-1.5 space-y-1">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>干预 {stats.interventions}次</span>
          <span>诊断 {stats.diagnoses}次</span>
          {stats.blocks > 0 && <span className="text-red-400">阻断 {stats.blocks}次</span>}
        </div>
        {(stats.totalInput > 0 || stats.totalOutput > 0) && (
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>🤖 {stats.models.length > 0 ? stats.models.map(m => m.length > 20 ? m.slice(0, 20) + "…" : m).join(", ") : "unknown"}</span>
            <span className="text-muted-foreground/60">|</span>
            <span>📥 {formatTokenCount(stats.totalInput)}</span>
            <span>📤 {formatTokenCount(stats.totalOutput)}</span>
            <span className="text-muted-foreground/60">=</span>
            <span className="font-medium">{formatTokenCount(stats.totalInput + stats.totalOutput)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ============ Detail Tab ============

function DetailTab({ events }: { events: ParsedHarnessEvent[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = events.find((e) => e.id === selectedId)

  if (events.length === 0) {
    return (
      <div className="text-xs text-muted-foreground text-center py-6">
        暂无事件详情
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Event selector */}
      <div className="shrink-0 border-b border-border/50 px-2 py-1 max-h-[120px] overflow-y-auto space-y-0.5">
        {events.map((event) => (
          <div
            key={event.id}
            className={cn(
              "text-xs px-2 py-0.5 rounded cursor-pointer truncate",
              selectedId === event.id
                ? "bg-primary/10 text-primary"
                : "hover:bg-muted/50 text-muted-foreground",
            )}
            onClick={() => setSelectedId(event.id)}
          >
            {event.type} — {event.nodeId ?? "system"}
          </div>
        ))}
      </div>

      {/* Selected event detail */}
      {selected && (
        <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2 text-xs space-y-2">
          <DetailRow label="类型" value={selected.type} />
          <DetailRow label="节点" value={selected.nodeId ?? "-"} />
          <DetailRow label="时间" value={new Date(selected.timestamp).toLocaleString()} />

          {selected.report && (
            <>
              <DetailRow label="检测器" value={selected.report.detector} />
              <DetailRow label="严重度" value={selected.report.severity} />
              <DetailRow label="模式" value={selected.report.pattern} />
              {selected.report.evidence.length > 0 && (
                <DetailSection label="证据">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
                    {JSON.stringify(selected.report.evidence, null, 2)}
                  </pre>
                </DetailSection>
              )}
            </>
          )}

          {selected.action && (
            <DetailSection label="干预动作">
              <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(selected.action, null, 2)}
              </pre>
            </DetailSection>
          )}

          {selected.result && (
            <DetailRow label="结果" value={selected.result} />
          )}

          {selected.reason && (
            <DetailRow label="原因" value={selected.reason} />
          )}
        </div>
      )}

      {!selected && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          点击选择事件查看详情
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono truncate">{value}</span>
    </div>
  )
}

function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-0.5 rounded bg-muted/30 p-1.5">{children}</div>
    </div>
  )
}

// ============ Main Floating Panel ============

export function HarnessFloatingPanel({
  workspaceId,
  executionId,
  executionStatus,
  currentNodeId,
}: HarnessFloatingPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 400, height: 500 })
  const [activeTab, setActiveTab] = useState("monitor")
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    startX: number
    startY: number
    origLeft: number
    origTop: number
  } | null>(null)
  const resizeRef = useRef<{
    startX: number
    startY: number
    origWidth: number
    origHeight: number
  } | null>(null)

  const { events, loading, interventionCount, totalExtraTokens } = useHarnessEvents(
    workspaceId,
    executionId,
    executionStatus,
  )

  const isRunning = executionStatus === "running" || executionStatus === "paused"
  const isIntervening = events.some(
    (e) => e.type === "harness_intervention" && Date.now() - e.timestamp < 10000,
  )

  // Compute default position on first mount (right side of viewport)
  useEffect(() => {
    if (pos === null) {
      const defaultLeft = Math.max(window.innerWidth - 400, 200)
      setPos({ left: defaultLeft, top: 56 })
    }
  }, [pos])

  // Shared drag handler — works for both collapsed and expanded
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (!pos) return
      e.preventDefault()
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origLeft: pos.left,
        origTop: pos.top,
      }

      const handleDragMove = (me: MouseEvent) => {
        if (!dragRef.current) return
        const newLeft = dragRef.current.origLeft + (me.clientX - dragRef.current.startX)
        const newTop = dragRef.current.origTop + (me.clientY - dragRef.current.startY)
        const clampedLeft = Math.max(0, Math.min(window.innerWidth - 120, newLeft))
        const clampedTop = Math.max(0, Math.min(window.innerHeight - 48, newTop))
        setPos({ left: clampedLeft, top: clampedTop })
      }

      const handleDragEnd = () => {
        dragRef.current = null
        window.removeEventListener("mousemove", handleDragMove)
        window.removeEventListener("mouseup", handleDragEnd)
      }

      window.addEventListener("mousemove", handleDragMove)
      window.addEventListener("mouseup", handleDragEnd)
    },
    [pos],
  )

  // Resize handler — drag from bottom-right corner
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origWidth: size.width,
        origHeight: size.height,
      }

      const handleResizeMove = (me: MouseEvent) => {
        if (!resizeRef.current) return
        const newWidth = Math.max(280, resizeRef.current.origWidth + (me.clientX - resizeRef.current.startX))
        const newHeight = Math.max(300, resizeRef.current.origHeight + (me.clientY - resizeRef.current.startY))
        setSize({ width: newWidth, height: newHeight })
      }

      const handleResizeEnd = () => {
        resizeRef.current = null
        window.removeEventListener("mousemove", handleResizeMove)
        window.removeEventListener("mouseup", handleResizeEnd)
      }

      window.addEventListener("mousemove", handleResizeMove)
      window.addEventListener("mouseup", handleResizeEnd)
    },
    [size],
  )

  // Don't render until position is computed
  if (!pos) return null

  if (!expanded) {
    return (
      <div
        className="fixed z-50"
        style={{ left: pos.left, top: pos.top }}
        data-testid="harness-floating-panel"
      >
        <CollapsedPanel
          interventionCount={interventionCount}
          isIntervening={isIntervening}
          isRunning={isRunning}
          extraTokens={totalExtraTokens}
          onExpand={() => setExpanded(true)}
          onDragStart={handleDragStart}
        />
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className="fixed z-50 flex flex-col rounded-lg border border-border bg-card shadow-xl"
      style={{
        left: pos.left,
        top: pos.top,
        width: size.width,
        height: size.height,
        minWidth: 280,
        minHeight: 300,
        overflow: "hidden",
      }}
      data-testid="harness-floating-panel"
    >
      {/* Title bar with drag handle */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-border cursor-grab active:cursor-grabbing shrink-0 bg-muted/30"
        onMouseDown={handleDragStart}
      >
        <GripHorizontal className="h-3.5 w-3.5 text-muted-foreground/60" />
        <span className="text-xs font-medium flex-1 select-none">🛡️ Harness 监控</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setExpanded(false)}
          title="收起"
        >
          <Minus className="h-3 w-3" />
        </Button>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="mx-2 mt-1 h-8 shrink-0">
          <TabsTrigger value="monitor" className="text-xs h-6 px-2">
            监控
          </TabsTrigger>
          <TabsTrigger value="detail" className="text-xs h-6 px-2">
            明细
          </TabsTrigger>
          <TabsTrigger value="chatbot" className="text-xs h-6 px-2">
            Chatbot
          </TabsTrigger>
        </TabsList>

        <TabsContent value="monitor" className="flex-1 mt-0 min-h-0 overflow-hidden">
          <MonitorTab events={events} />
        </TabsContent>

        <TabsContent value="detail" className="flex-1 mt-0 min-h-0 overflow-hidden">
          <DetailTab events={events} />
        </TabsContent>

        <TabsContent value="chatbot" className="flex-1 mt-0 min-h-0 overflow-hidden">
          <HarnessChatbot
            workspaceId={workspaceId}
            executionId={executionId}
            isRunning={isRunning}
            currentNodeId={currentNodeId}
          />
        </TabsContent>
      </Tabs>

      {/* Resize handle — bottom-right corner */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-end justify-end"
        onMouseDown={handleResizeStart}
        title="调整大小"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted-foreground/40">
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="9" y1="5" x2="5" y2="9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  )
}
