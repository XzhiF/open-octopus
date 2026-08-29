"use client"

import { useState, useRef, useCallback, useEffect, useMemo } from "react"
import { emptyTokenUsage, addTokenUsage, totalTokens } from "@octopus/shared"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Minus, GripHorizontal, Maximize2, Minimize2, MessageCircle, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { useHarnessEvents, type ParsedHarnessEvent } from "@/hooks/use-harness-events"
import { useExecutionMetrics, type ExecutionMetrics } from "@/hooks/use-execution-metrics"
import { HarnessChatbot } from "./harness-chatbot"
import { ObservabilityTab } from "./observability-panel"
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
  isBudgetExceeded,
  hasActivity,
  metrics,
  harnessInputTokens,
  harnessOutputTokens,
  harnessCacheTokens,
  harnessCacheCreationTokens,
  onExpand,
  onDragStart,
}: {
  interventionCount: number
  isIntervening: boolean
  isRunning: boolean
  isBudgetExceeded: boolean
  hasActivity: boolean
  metrics: ExecutionMetrics
  harnessInputTokens: number
  harnessOutputTokens: number
  harnessCacheTokens: number
  harnessCacheCreationTokens: number
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

  const harnessTotal = harnessInputTokens + harnessOutputTokens + harnessCacheTokens + harnessCacheCreationTokens

  return (
    <div
      className={cn(
        "w-fit min-w-[170px] rounded-lg border border-border bg-card shadow-lg cursor-grab active:cursor-grabbing flex flex-col items-start justify-center gap-0.5 px-1.5 py-1.5 opacity-70 hover:opacity-100 transition-opacity select-none overflow-hidden",
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
      {/* Line 1: status */}
      <div className="flex items-center gap-1 text-[11px] font-medium pointer-events-none whitespace-nowrap">
        <span>🛡️</span>
        <span>{interventionCount}</span>
        <span className="text-muted-foreground">|</span>
        <span
          className={
            isBudgetExceeded
              ? "text-red-500 font-bold"
              : !isRunning
                ? "text-muted-foreground"
                : isIntervening
                  ? "text-amber-500"
                  : "text-emerald-500"
          }
        >
          {isBudgetExceeded ? "预算超限" : !isRunning ? "已完成" : isIntervening ? "干预中" : "监控中"}
        </span>
      </div>
      {/* Line 2: workflow total tokens */}
      {metrics.totalTokens > 0 && (
        <span className="text-[10px] text-muted-foreground pointer-events-none flex items-center gap-0.5 whitespace-nowrap">
          <span>📊</span>
          <span>↑{formatTokenCount(metrics.totalInputTokens)}</span>
          <span>↓{formatTokenCount(metrics.totalOutputTokens)}</span>
          <span>⚡{formatTokenCount(metrics.totalCacheReadTokens)}</span>
          <span>🗡️{formatTokenCount(metrics.totalCacheCreationTokens)}</span>
        </span>
      )}
      {/* Line 3: harness tokens (input = non-cached, unified) */}
      {harnessTotal > 0 && (
        <span className="text-[10px] text-muted-foreground pointer-events-none flex items-center gap-0.5 whitespace-nowrap">
          <span>🛡️</span>
          <span>↑{formatTokenCount(harnessInputTokens)}</span>
          <span>↓{formatTokenCount(harnessOutputTokens)}</span>
          <span>⚡{formatTokenCount(harnessCacheTokens)}</span>
          <span>🗡️{formatTokenCount(harnessCacheCreationTokens)}</span>
        </span>
      )}
    </div>
  )
}

// ============ Helpers ============

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-sonnet-4-20250514": "Sonnet 4",
  "claude-sonnet-4-5-20250827": "Sonnet 4.5",
  "claude-opus-4-20250514": "Opus 4",
  "claude-opus-4-5-20250827": "Opus 4.5",
  "claude-haiku-3-5-20241022": "Haiku 3.5",
  "claude-3-5-haiku-20241022": "Haiku 3.5",
}

function formatModelName(modelId: string): string {
  if (MODEL_DISPLAY_NAMES[modelId]) return MODEL_DISPLAY_NAMES[modelId]
  // Fallback: extract readable parts from model ID
  const m = modelId.match(/^claude-(\w+)-([\d.]+)-(\d{8})$/)
  if (m) {
    const [, tier, version] = m
    const v = version.includes("-") ? version.replace(/-/g, ".") : version
    return `${tier.charAt(0).toUpperCase() + tier.slice(1)} ${v}`
  }
  return modelId
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ============ Harness Tab (merged: timeline + accordion + inline chat) ============

function HarnessTab({
  events,
  workspaceId,
  executionId,
  isRunning,
  currentNodeId,
}: {
  events: ParsedHarnessEvent[]
  workspaceId: string
  executionId: string
  isRunning: boolean
  currentNodeId?: string
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [chatOpen, setChatOpen] = useState(false)

  const stats = useMemo(() => {
    const interventions = events.filter(
      (e) => e.type === "harness_intervention" || e.type === "harness_delegation",
    ).length
    const diagnoses = events.filter((e) => e.type === "harness_diagnosis").length
    const blocks = events.filter((e) => e.type === "harness_blocked").length
    const models = new Set<string>()
    let usage = emptyTokenUsage()
    for (const e of events) {
      if (e.tokenUsage) {
        usage = addTokenUsage(usage, {
          inputTokens: e.tokenUsage.inputTokens ?? 0,
          outputTokens: e.tokenUsage.outputTokens ?? 0,
          cacheReadTokens: e.tokenUsage.cacheReadTokens ?? 0,
          cacheCreationTokens: e.tokenUsage.cacheCreationTokens ?? 0,
        })
        if (e.tokenUsage.model) models.add(e.tokenUsage.model)
      }
    }
    // C3: 公式单源（旧第三份手加随此删除）
    const totalInput = usage.inputTokens
    const totalOutput = usage.outputTokens
    const totalCache = usage.cacheReadTokens
    const totalCacheCreation = usage.cacheCreationTokens
    const totalAll = totalTokens(usage)
    return { interventions, diagnoses, blocks, totalInput, totalOutput, totalCache, totalCacheCreation, totalAll, models: Array.from(models) }
  }, [events])

  const toggleEvent = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    setExpandedIds(new Set(events.map((e) => e.id)))
  }, [events])

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set())
  }, [])

  return (
    <div className="flex flex-col h-full">
      {/* Header: stats + chat toggle */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border/50 flex-wrap">
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>干预 {stats.interventions}次</span>
          <span>诊断 {stats.diagnoses}次</span>
          {stats.blocks > 0 && <span className="text-red-400">阻断 {stats.blocks}次</span>}
        </div>
        <div className="flex-1" />
        <button
          className={cn(
            "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded",
            chatOpen
              ? "bg-violet-500/20 text-violet-400"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
          onClick={() => setChatOpen((v) => !v)}
        >
          <MessageCircle className="h-3 w-3" />
          <span>干预对话</span>
          {chatOpen ? <ChevronDown className="h-3 w-3" /> : null}
        </button>
      </div>

      {/* Event list (merged Monitor timeline + Detail accordion) */}
      {events.length === 0 ? (
        <div className="flex-1 text-xs text-muted-foreground text-center py-6">
          暂无 Harness 事件
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-border/30">
            <span className="text-[10px] text-muted-foreground">{events.length} 个事件</span>
            <div className="flex-1" />
            <button className="text-[10px] text-primary hover:underline" onClick={expandAll}>
              全部展开
            </button>
            <span className="text-muted-foreground/40">|</span>
            <button className="text-[10px] text-primary hover:underline" onClick={collapseAll}>
              全部收起
            </button>
          </div>

          {/* Accordion timeline */}
          <div className={cn(
            "overflow-y-auto min-h-0",
            chatOpen ? "flex-1" : "flex-1",
          )}>
            {events.map((event) => (
              <EventAccordionItem
                key={event.id}
                event={event}
                isExpanded={expandedIds.has(event.id)}
                onToggle={() => toggleEvent(event.id)}
              />
            ))}
          </div>

          {/* Token stats footer */}
          {(stats.totalInput > 0 || stats.totalOutput > 0 || stats.totalCache > 0 || stats.totalCacheCreation > 0) && (
            <div className="shrink-0 border-t border-border/50 px-2 py-1">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground flex-wrap">
                <span>🤖 {stats.models.length > 0 ? stats.models.map(m => m.length > 16 ? m.slice(0, 16) + "…" : m).join(", ") : "unknown"}</span>
                <span className="text-muted-foreground/60">|</span>
                <span>↑{formatTokenCount(stats.totalInput)}</span>
                <span>↓{formatTokenCount(stats.totalOutput)}</span>
                <span>⚡{formatTokenCount(stats.totalCache)}</span>
                <span>🗡️{formatTokenCount(stats.totalCacheCreation)}</span>
                <span className="text-muted-foreground/60">=</span>
                <span className="font-medium">{formatTokenCount(stats.totalAll)}</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* Inline chat panel — collapsible */}
      {chatOpen && (
        <div className="shrink-0 border-t border-border flex flex-col" style={{ height: "45%", minHeight: 180, maxHeight: 350 }}>
          <HarnessChatbot
            workspaceId={workspaceId}
            executionId={executionId}
            isRunning={isRunning}
            currentNodeId={currentNodeId}
          />
        </div>
      )}
    </div>
  )
}

// ============ Event Accordion Item ============

function EventAccordionItem({
  event,
  isExpanded,
  onToggle,
}: {
  event: ParsedHarnessEvent
  isExpanded: boolean
  onToggle: () => void
}) {
  const time = formatTimestamp(event.timestamp)

  const iter = event.iteration ?? (event.report as any)?.iteration
  const nodeName = iter != null ? `${event.nodeId ?? "system"} (iter ${iter})` : (event.nodeId ?? "system")

  let icon: string
  let colorClass: string
  switch (event.type) {
    case "harness_diagnosis": {
      const severity = event.report?.severity
      icon = severity === "critical" ? "🚨" : "⚠️"
      colorClass = severity === "critical" ? "text-red-400" : "text-amber-400"
      break
    }
    case "harness_intervention":
      icon = "🔄"
      colorClass = "text-blue-400"
      break
    case "harness_delegation":
      icon = event.delegationResult?.success ? "🤖" : "🤖❌"
      colorClass = event.delegationResult?.success
        ? event.delegationResult?.decision === "block_node" ? "text-red-400" : "text-violet-400"
        : "text-muted-foreground"
      break
    case "harness_blocked":
      icon = "🚨"
      colorClass = "text-red-500"
      break
    default:
      icon = "•"
      colorClass = "text-muted-foreground"
  }

  return (
    <div className="border-b border-border/30 last:border-b-0">
      {/* Header — clickable */}
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs px-2 py-1.5 cursor-pointer select-none",
          isExpanded ? "bg-primary/5" : "hover:bg-muted/50",
        )}
        onClick={onToggle}
      >
        {/* Expand indicator */}
        <span className={cn(
          "shrink-0 text-[10px] text-muted-foreground/60 transition-transform duration-150",
          isExpanded && "rotate-90",
        )}>▶</span>
        {/* Timestamp */}
        <span className="shrink-0 tabular-nums text-muted-foreground/70 font-mono text-[10px]">{time}</span>
        {/* Icon */}
        <span className="shrink-0">{icon}</span>
        {/* Label */}
        <span className={cn("truncate", colorClass)}>
          {event.type.replace("harness_", "")} — {nodeName}
        </span>
      </div>

      {/* Body — collapsible */}
      {isExpanded && (
        <div className="px-2 py-2 text-xs space-y-2 bg-muted/10">
          <DetailRow label="类型" value={event.type} />
          <DetailRow label="节点" value={(() => {
            const iter = event.iteration ?? (event.report as any)?.iteration
            return iter != null ? `${event.nodeId ?? "-"} (iter ${iter})` : (event.nodeId ?? "-")
          })()} />
          <DetailRow label="时间" value={formatTimestamp(event.timestamp)} />

          {event.report && (
            <>
              <DetailRow label="检测器" value={event.report.detector} />
              <DetailRow label="严重度" value={event.report.severity} />
              <DetailRow label="模式" value={event.report.pattern} />
              {event.report.evidence.length > 0 && (
                <DetailSection label="证据">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
                    {JSON.stringify(event.report.evidence, null, 2)}
                  </pre>
                </DetailSection>
              )}
            </>
          )}

          {event.action && (
            <DetailSection label="干预动作">
              <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(event.action, null, 2)}
              </pre>
            </DetailSection>
          )}

          {event.delegationResult && (
            <>
              <DetailRow label="决策" value={event.delegationResult.decision ?? "-"} />
              <DetailRow label="成功" value={event.delegationResult.success ? "✅ 是" : "❌ 否"} />
              {event.delegationResult.reasoning && (
                <DetailSection label="推理">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
                    {event.delegationResult.reasoning}
                  </pre>
                </DetailSection>
              )}
              {event.delegationResult.blockReason && (
                <DetailSection label="阻断原因">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-red-400">
                    {event.delegationResult.blockReason}
                  </pre>
                </DetailSection>
              )}
              {event.delegationResult.harnessHint && (
                <DetailSection label="提示注入">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
                    {event.delegationResult.harnessHint}
                  </pre>
                </DetailSection>
              )}
              {event.delegationResult.modelOverride && (
                <DetailRow label="模型覆盖" value={event.delegationResult.modelOverride} />
              )}
              {event.delegationResult.varPoolPatches && Object.keys(event.delegationResult.varPoolPatches).length > 0 && (
                <DetailSection label="变量修补">
                  <pre className="text-[10px] font-mono whitespace-pre-wrap text-muted-foreground">
                    {JSON.stringify(event.delegationResult.varPoolPatches, null, 2)}
                  </pre>
                </DetailSection>
              )}
              {event.delegationResult.chunks && event.delegationResult.chunks.length > 0 && (() => {
                const merged: Array<{ type: string; content: string; toolName?: string; toolInput?: unknown; isError?: boolean }> = []
                for (const chunk of event.delegationResult.chunks) {
                  const last = merged[merged.length - 1]
                  if (chunk.type === "thinking" || chunk.type === "thinking_start" || chunk.type === "thinking_done") {
                    const text = String(chunk.content ?? "")
                    if (last && last.type === "thinking") {
                      last.content += text
                    } else if (text) {
                      merged.push({ type: "thinking", content: text })
                    }
                  } else if (chunk.type === "tool_call_start" || chunk.type === "tool_call") {
                    merged.push({
                      type: "tool_call",
                      content: "",
                      toolName: String(chunk.toolName ?? ""),
                      toolInput: chunk.toolInput,
                    })
                  } else if (chunk.type === "tool_result") {
                    merged.push({
                      type: "tool_result",
                      content: String(chunk.content ?? ""),
                      isError: chunk.isError as boolean | undefined,
                    })
                  }
                }
                return (
                  <DetailSection label="Agent 交互">
                    <div className="space-y-1.5">
                      {merged.map((item, i) => {
                        if (item.type === "thinking") {
                          return (
                            <div key={i} className="text-[10px] text-purple-400/80">
                              <span className="text-purple-400 font-medium">💭 </span>
                              {item.content.slice(0, 500)}
                            </div>
                          )
                        }
                        if (item.type === "tool_call") {
                          return (
                            <div key={i} className="text-[10px] text-amber-400/80">
                              <span className="text-amber-400 font-medium">🔧 {item.toolName}</span>
                              {item.toolInput != null && (
                                <pre className="text-muted-foreground ml-3 whitespace-pre-wrap">
                                  {typeof item.toolInput === "string" ? item.toolInput.slice(0, 300) : JSON.stringify(item.toolInput, null, 2).slice(0, 300)}
                                </pre>
                              )}
                            </div>
                          )
                        }
                        if (item.type === "tool_result") {
                          return (
                            <div key={i} className={cn("text-[10px] ml-3", item.isError ? "text-red-400/80" : "text-green-400/80")}>
                              <span className="font-medium">{item.isError ? "❌" : "✅"} </span>
                              {item.content.slice(0, 300)}
                            </div>
                          )
                        }
                        return null
                      })}
                    </div>
                  </DetailSection>
                )
              })()}
            </>
          )}

          {event.tokenUsage && (
            <DetailSection label="Token 用量">
              <div className="text-[10px] font-mono text-muted-foreground space-y-0.5">
                <div>模型: {formatModelName(event.tokenUsage.model ?? "-")}</div>
                <div>输入: {formatTokenCount(event.tokenUsage.inputTokens ?? 0)}</div>
                <div>输出: {formatTokenCount(event.tokenUsage.outputTokens ?? 0)}</div>
                {(event.tokenUsage.cacheReadTokens ?? 0) > 0 && (
                  <div>缓存读取: {formatTokenCount(event.tokenUsage.cacheReadTokens!)}</div>
                )}
                {(event.tokenUsage.cacheCreationTokens ?? 0) > 0 && (
                  <div>缓存创建: {formatTokenCount(event.tokenUsage.cacheCreationTokens!)}</div>
                )}
              </div>
            </DetailSection>
          )}

          {event.result && !event.delegationResult && (
            <DetailRow label="结果" value={typeof event.result === "object" ? JSON.stringify(event.result) : event.result} />
          )}

          {event.reason && (
            <DetailRow label="原因" value={typeof event.reason === "object" ? JSON.stringify(event.reason) : event.reason} />
          )}
        </div>
      )}
    </div>
  )
}

// DetailRow and DetailSection are used by EventAccordionItem

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
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 800, height: 625 })
  const [maximized, setMaximized] = useState(false)
  const prevGeometry = useRef<{ pos: { left: number; top: number }; size: { width: number; height: number } } | null>(null)
  const [activeTab, setActiveTab] = useState("observability")
  const [obsKey, setObsKey] = useState(0) // force remount ObservabilityTab on each activation
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

  const { events, loading, interventionCount, totalExtraTokens, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens } = useHarnessEvents(
    workspaceId,
    executionId,
    executionStatus,
  )

  // KD-10: Independent execution metrics hook for observability summary
  const metrics = useExecutionMetrics(workspaceId, executionId)

  const isBudgetExceeded = executionStatus === "budget_exceeded"

  const isRunning = executionStatus === "running" || executionStatus === "paused"
  const isIntervening = events.some(
    (e) => e.type === "harness_intervention" && Date.now() - e.timestamp < 10000,
  )

  // Compute default position on first mount — overlay the chat column (right 30%)
  useEffect(() => {
    if (pos === null) {
      // Chat column occupies rightmost 30% of viewport
      const chatColLeft = window.innerWidth * 0.70
      const chatColWidth = window.innerWidth * 0.30
      const panelWidth = Math.max(chatColWidth - 8, 320)
      const panelHeight = Math.max(window.innerHeight - 52, 400)
      setSize({ width: panelWidth, height: panelHeight })
      setPos({ left: chatColLeft + 4, top: 48 })
    }
  }, [pos])

  // Clamp position when expanding to keep panel fully visible
  useEffect(() => {
    if (expanded && pos) {
      const maxLeft = Math.max(window.innerWidth - size.width - 10, 10)
      const maxTop = Math.max(window.innerHeight - size.height - 10, 10)
      const clampedLeft = Math.max(10, Math.min(pos.left, maxLeft))
      const clampedTop = Math.max(10, Math.min(pos.top, maxTop))
      if (clampedLeft !== pos.left || clampedTop !== pos.top) {
        setPos({ left: clampedLeft, top: clampedTop })
      }
    }
  }, [expanded, size.width, size.height])

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

  // Resize handler — supports all 4 corners + 4 edges
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, dir: string) => {
      e.preventDefault()
      e.stopPropagation()
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origWidth: size.width,
        origHeight: size.height,
      }
      const origPos = pos!

      const handleResizeMove = (me: MouseEvent) => {
        if (!resizeRef.current) return
        const dx = me.clientX - resizeRef.current.startX
        const dy = me.clientY - resizeRef.current.startY
        let newWidth = size.width
        let newHeight = size.height
        let newLeft = origPos.left
        let newTop = origPos.top

        if (dir.includes("e")) newWidth = Math.max(280, resizeRef.current.origWidth + dx)
        if (dir.includes("w")) {
          newWidth = Math.max(280, resizeRef.current.origWidth - dx)
          newLeft = origPos.left + (resizeRef.current.origWidth - newWidth)
        }
        if (dir.includes("s")) newHeight = Math.max(300, resizeRef.current.origHeight + dy)
        if (dir.includes("n")) {
          newHeight = Math.max(300, resizeRef.current.origHeight - dy)
          newTop = origPos.top + (resizeRef.current.origHeight - newHeight)
        }

        setSize({ width: newWidth, height: newHeight })
        setPos({ left: Math.max(0, newLeft), top: Math.max(0, newTop) })
      }

      const handleResizeEnd = () => {
        resizeRef.current = null
        window.removeEventListener("mousemove", handleResizeMove)
        window.removeEventListener("mouseup", handleResizeEnd)
      }

      window.addEventListener("mousemove", handleResizeMove)
      window.addEventListener("mouseup", handleResizeEnd)
    },
    [size, pos],
  )

  const toggleMaximize = useCallback(() => {
    if (!maximized) {
      // Save current geometry before maximizing
      if (pos) {
        prevGeometry.current = { pos: { ...pos }, size: { ...size } }
      }
      setPos({ left: 0, top: 0 })
      setSize({ width: window.innerWidth, height: window.innerHeight })
      setMaximized(true)
    } else {
      // Restore previous geometry
      if (prevGeometry.current) {
        setPos(prevGeometry.current.pos)
        setSize(prevGeometry.current.size)
      }
      setMaximized(false)
    }
    // Always refresh observability when toggling layout mode
    setObsKey(k => k + 1)
  }, [maximized, pos, size])

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
          isBudgetExceeded={isBudgetExceeded}
          hasActivity={isRunning && events.length > 0}
          metrics={metrics}
          harnessInputTokens={totalInputTokens}
          harnessOutputTokens={totalOutputTokens}
          harnessCacheTokens={totalCacheReadTokens}
          harnessCacheCreationTokens={totalCacheCreationTokens}
          onExpand={() => setExpanded(true)}
          onDragStart={handleDragStart}
        />
      </div>
    )
  }

  return (
    <div
      ref={panelRef}
      className={cn(
        "fixed z-50 flex flex-col bg-card",
        maximized ? "border-0" : "rounded-lg border border-border shadow-xl",
      )}
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
        <span className="text-xs font-medium flex-1 select-none">🛡️ 监控面板</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={toggleMaximize}
          title={maximized ? "还原" : "全屏"}
        >
          {maximized ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
        </Button>
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

      {/* Content: side-by-side when maximized, tabs when normal */}
      {maximized ? (
        <div className="flex-1 flex min-h-0">
          {/* Left: Workflow */}
          <div className="w-1/2 border-r border-border min-h-0 overflow-hidden flex flex-col">
            <div className="shrink-0 px-3 py-1.5 border-b border-border/50 bg-muted/20">
              <span className="text-[11px] font-medium text-muted-foreground">📊 Workflow</span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <ObservabilityTab key={`obs-max-${obsKey}`} workspaceId={workspaceId} executionId={executionId} isRunning={isRunning} />
            </div>
          </div>
          {/* Right: Harness */}
          <div className="w-1/2 min-h-0 overflow-hidden flex flex-col">
            <div className="shrink-0 px-3 py-1.5 border-b border-border/50 bg-muted/20">
              <span className="text-[11px] font-medium text-muted-foreground">🛡️ Harness</span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <HarnessTab
                events={events}
                workspaceId={workspaceId}
                executionId={executionId}
                isRunning={isRunning}
                currentNodeId={currentNodeId}
              />
            </div>
          </div>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={(tab) => {
          setActiveTab(tab)
          if (tab === "observability") setObsKey(k => k + 1)
        }} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-2 mt-1 h-8 shrink-0">
            <TabsTrigger value="observability" className="text-xs h-6 px-2">
              Workflow
            </TabsTrigger>
            <TabsTrigger value="harness" className="text-xs h-6 px-2">
              Harness
            </TabsTrigger>
          </TabsList>

          <TabsContent value="observability" className="flex-1 mt-0 min-h-0 overflow-hidden">
            <ObservabilityTab key={obsKey} workspaceId={workspaceId} executionId={executionId} isRunning={isRunning} />
          </TabsContent>

          <TabsContent value="harness" className="flex-1 mt-0 min-h-0 overflow-hidden">
            <HarnessTab
              events={events}
              workspaceId={workspaceId}
              executionId={executionId}
              isRunning={isRunning}
              currentNodeId={currentNodeId}
            />
          </TabsContent>
        </Tabs>
      )}

      {/* Resize handles — all 4 corners + 4 edges */}
      {/* Corners */}
      <div className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize" onMouseDown={(e) => handleResizeStart(e, "nw")} />
      <div className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize" onMouseDown={(e) => handleResizeStart(e, "ne")} />
      <div className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize" onMouseDown={(e) => handleResizeStart(e, "sw")} />
      <div className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize" onMouseDown={(e) => handleResizeStart(e, "se")}>
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted-foreground/40 absolute bottom-0.5 right-0.5">
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="9" y1="5" x2="5" y2="9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
      {/* Edges */}
      <div className="absolute top-0 left-3 right-3 h-1.5 cursor-n-resize" onMouseDown={(e) => handleResizeStart(e, "n")} />
      <div className="absolute bottom-0 left-3 right-3 h-1.5 cursor-s-resize" onMouseDown={(e) => handleResizeStart(e, "s")} />
      <div className="absolute top-3 bottom-3 left-0 w-1.5 cursor-w-resize" onMouseDown={(e) => handleResizeStart(e, "w")} />
      <div className="absolute top-3 bottom-3 right-0 w-1.5 cursor-e-resize" onMouseDown={(e) => handleResizeStart(e, "e")} />
    </div>
  )
}
