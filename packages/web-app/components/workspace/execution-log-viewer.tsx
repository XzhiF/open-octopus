"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { ChevronDown, ChevronRight, ChevronUp, ChevronsDown, Terminal, Brain, Wrench, FileText, Play, Check, X, Clock, Users, MessageSquare, Award, RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration, formatTokenCount } from "@/lib/format"
import { isMergedEvent, type AgentEvent, type LoopIterationSummary } from "@/lib/types"
import { useExecutionEvents } from "@/hooks/use-execution-events"
// IterationGroup used in loop-overview panel

// ============ LogEvent (extends AgentEvent for legacy compat) ============

export interface LogEvent extends AgentEvent {
  __mergedCount?: number
  // Swarm event fields
  role?: string
  model?: string
  round?: number
  expertCount?: number
  output?: string
  tokens?: number
  synthesis?: string
  source?: string
  __done?: boolean
}

interface LogViewerProps {
  workspaceId: string
  executionId: string
  executionStatus?: string
}

function formatTime(iso?: string) {
  if (!iso) return ""
  try { return new Date(iso).toLocaleTimeString() } catch { return iso }
}

// ============ EventIcon ============

export function EventIcon({ event, agentType }: { event: string; agentType?: string }) {
  // Merged event types (server-side pre-merged)
  switch (event) {
    case "thinking_block": return <Brain className="h-3 w-3 text-purple-400 shrink-0" />
    case "text_block": return <FileText className="h-3 w-3 text-blue-400 shrink-0" />
    case "tool_call": return <Wrench className="h-3 w-3 text-amber-400 shrink-0" />
    case "bash_output": return <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
    case "python_output": return <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
    case "bash_stderr": return <X className="h-3 w-3 text-red-400 shrink-0" />
    case "python_stderr": return <X className="h-3 w-3 text-red-400 shrink-0" />
    case "branch_start": return <Play className="h-3 w-3 text-emerald-400 shrink-0" />
    case "branch_end": return <Check className="h-3 w-3 text-emerald-400 shrink-0" />
  }

  // Legacy agent_event sub-types
  if (event === "agent_event" && agentType) {
    switch (agentType) {
      case "thinking_block": return <Brain className="h-3 w-3 text-purple-400 shrink-0" />
      case "tool_start": return <Wrench className="h-3 w-3 text-amber-400 shrink-0" />
      case "tool_input": return <Wrench className="h-3 w-3 text-amber-400 shrink-0" />
      case "tool_result": return <Wrench className="h-3 w-3 text-amber-400 shrink-0" />
      case "text_delta": return <FileText className="h-3 w-3 text-blue-400 shrink-0" />
      case "error": return <X className="h-3 w-3 text-red-400 shrink-0" />
      default: return <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
    }
  }

  switch (event) {
    case "start": return <Play className="h-3 w-3 text-emerald-400 shrink-0" />
    case "end": return <Check className="h-3 w-3 text-emerald-400 shrink-0" />
    case "bash_log": return <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
    case "python_log": return <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
    case "expert_spawn": return <Users className="h-3 w-3 text-cyan-400 shrink-0" />
    case "expert_complete": return <Check className="h-3 w-3 text-cyan-400 shrink-0" />
    case "expert_message": return <MessageSquare className="h-3 w-3 text-blue-400 shrink-0" />
    case "swarm_round_end": return <RotateCcw className="h-3 w-3 text-purple-400 shrink-0" />
    case "swarm_complete": return <Award className="h-3 w-3 text-yellow-400 shrink-0" />
    case "consensus_check": return <Award className="h-3 w-3 text-purple-400 shrink-0" />
    default: return <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
  }
}

// ============ EventLabel ============

export function EventLabel({ entry }: { entry: LogEvent }) {
  // Merged event types (server-side pre-merged) — render directly
  switch (entry.event) {
    case "thinking_block": {
      const dur = entry.startedAt && entry.completedAt
        ? formatDuration((new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000)
        : undefined
      return <span className="text-purple-400">思考完成{dur ? ` (${dur})` : ""}</span>
    }
    case "text_block": {
      const text = entry.content ?? ""
      return (
        <span className="text-blue-300 font-mono truncate max-w-[300px]">
          {text.length > 80 ? `${text.slice(0, 80)}...` : text}
        </span>
      )
    }
    case "tool_call": {
      const name = entry.toolName ?? "unknown"
      const dur = entry.startedAt && entry.completedAt
        ? formatDuration((new Date(entry.completedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000)
        : undefined
      return (
        <span className={entry.isError ? "text-red-400" : "text-amber-400"}>
          <code className="text-xs bg-muted px-1 rounded">{name}</code>
          {" "}{entry.isError ? "失败" : "完成"}{dur ? ` (${dur})` : ""}
        </span>
      )
    }
    case "bash_output": {
      const lineCount = entry.lines?.length ?? 0
      return <span className="text-muted-foreground">终端输出 ({lineCount} 行)</span>
    }
    case "python_output": {
      const lineCount = entry.lines?.length ?? 0
      return <span className="text-muted-foreground">Python 输出 ({lineCount} 行)</span>
    }
    case "bash_stderr": {
      const text = entry.content ?? entry.lines?.join("\n") ?? ""
      return <span className="text-red-400 font-mono">终端错误{text ? `: ${text.slice(0, 60)}` : ""}</span>
    }
    case "python_stderr": {
      const text = entry.content ?? entry.lines?.join("\n") ?? ""
      return <span className="text-red-400 font-mono">Python 错误{text ? `: ${text.slice(0, 60)}` : ""}</span>
    }
    case "branch_start":
      return <span className="text-emerald-400">迭代开始{entry.iteration ? ` #${entry.iteration}` : ""}</span>
    case "branch_end":
      return <span className="text-emerald-400">迭代结束{entry.iteration ? ` #${entry.iteration}` : ""}</span>
  }

  // Legacy agent_event sub-types (client-side merged)
  if (entry.event === "agent_event" && entry.event_data) {
    const e = entry.event_data
    switch (e.type) {
      case "thinking_block": {
        const isDone = entry.__done
        const tokenCount = entry.__mergedCount ?? 0
        const dur = e.duration
        return (
          <span className={isDone ? "text-purple-400" : "text-purple-300"}>
            {isDone
              ? `思考完成${dur ? ` (${dur})` : ""}`
              : `思考中${tokenCount > 0 ? ` (${tokenCount} tokens)` : ""}...`
            }
          </span>
        )
      }
      case "tool_start": return <span className="text-amber-400">调用工具 <code className="text-xs bg-muted px-1 rounded">{e.toolName}</code></span>
      case "tool_input": return <span className="text-amber-300">工具参数</span>
      case "tool_result": return (
        <span className={e.isError ? "text-red-400" : "text-amber-300"}>
          工具结果 {e.duration && `(${e.duration})`}
        </span>
      )
      case "text_delta": {
        const text = e.content ?? ""
        const count = entry.__mergedCount ?? 1
        return (
          <span className="text-blue-300 font-mono truncate max-w-[300px]">
            {text.length > 60 ? `${text.slice(0, 60)}...` : text}
            {count > 1 && <span className="text-muted-foreground ml-1">({count} chunks)</span>}
          </span>
        )
      }
      case "status": return <span className="text-muted-foreground">状态: {e.status}</span>
      case "error": return <span className="text-red-400">错误: {e.message}</span>
      default: return <span className="text-muted-foreground">{e.type}</span>
    }
  }

  switch (entry.event) {
    case "start": return <span className="text-emerald-400">开始执行</span>
    case "end": return (
      <span className={entry.status === "failed" || entry.exitCode ? "text-red-400" : "text-emerald-400"}>
        完成 {entry.durationMs != null && `(${formatDuration(entry.durationMs / 1000)})`}
        {entry.exitCode != null && entry.exitCode !== 0 && ` exit=${entry.exitCode}`}
        {entry.status === "failed" && " — 失败"}
      </span>
    )
    case "bash_log": {
      const isStderr = entry.line?.startsWith("[stderr]")
      return <span className={cn(isStderr ? "text-red-400" : "text-muted-foreground", "font-mono")}>{entry.line}</span>
    }
    case "python_log": {
      const isStderr = entry.line?.startsWith("[stderr]")
      return <span className={cn(isStderr ? "text-red-400" : "text-muted-foreground", "font-mono")}>{entry.line}</span>
    }
    case "expert_spawn":
      return <span className="text-cyan-400">专家启动 <code className="text-xs bg-muted px-1 rounded">{entry.role}</code> <span className="text-muted-foreground/60">({entry.model ?? "default"})</span></span>
    case "expert_complete":
      return <span className={entry.status === "failed" ? "text-red-400" : "text-cyan-400"}>
        专家完成 <code className="text-xs bg-muted px-1 rounded">{entry.role}</code>
        {entry.tokens != null && <span className="text-muted-foreground/60 ml-1">({formatTokenCount(entry.tokens)})</span>}
        {entry.status === "failed" && " — 失败"}
      </span>
    case "expert_message":
      return <span className="text-blue-400">
        专家消息 <code className="text-xs bg-muted px-1 rounded">{entry.role}</code>
        <span className="text-muted-foreground/60 ml-1">第{entry.round ?? "?"}轮</span>
      </span>
    case "swarm_round_end":
      return <span className="text-purple-400">轮次结束 第{entry.round}轮 ({entry.expertCount} 专家)</span>
    case "swarm_complete":
      return <span className={entry.status === "failed" ? "text-red-400" : "text-yellow-400"}>
        Swarm 完成 — {entry.status}
      </span>
    case "consensus_check":
      return <span className="text-purple-400">共识检测 第{entry.round}轮</span>
    default: return <span className="text-muted-foreground">{entry.event}</span>
  }
}

// ============ ExpandableRow ============

export function ExpandableRow({ entry }: { entry: LogEvent }) {
  const [expanded, setExpanded] = useState(false)

  // Merged event expandable content
  const isMergedOutput = ["bash_output", "python_output", "bash_stderr", "python_stderr"].includes(entry.event)
  const isMergedToolCall = entry.event === "tool_call"
  const isMergedThinking = entry.event === "thinking_block"
  const isMergedText = entry.event === "text_block"

  // Legacy expandable content
  const isBashLog = entry.event === "bash_log" || entry.event === "python_log"
  const isAgentDetail = entry.event === "agent_event" &&
    ["tool_input", "tool_result", "thinking_block", "text_delta"].includes(entry.event_data?.type ?? "")
  const isSwarmDetail = ["expert_message", "expert_complete", "swarm_complete"].includes(entry.event)

  const bashLine = isBashLog ? (entry.line ?? "") : ""
  const isLongLine = bashLine.length > 80
  const hasDetail = isMergedOutput || isMergedToolCall || isMergedThinking || isMergedText ||
    isAgentDetail || (isBashLog && isLongLine) || isSwarmDetail

  const toggle = () => hasDetail && setExpanded(!expanded)

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 py-0.5 text-xs",
          hasDetail && "cursor-pointer hover:bg-muted/50 rounded",
        )}
        onClick={toggle}
      >
        {hasDetail && (expanded
          ? <ChevronDown className="h-3 w-3 shrink-0" />
          : <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <EventIcon event={entry.event} agentType={entry.event_data?.type} />
        {isBashLog && isLongLine && !expanded ? (
          <span className="text-muted-foreground font-mono truncate">{bashLine.slice(0, 80)}...</span>
        ) : (
          <EventLabel entry={entry} />
        )}
        <span className="text-muted-foreground/40 ml-auto text-[10px] shrink-0">{formatTime(entry.timestamp)}</span>
      </div>

      {/* Merged bash/python output */}
      {expanded && isMergedOutput && entry.lines && entry.lines.length > 0 && (
        <div className={cn(
          "ml-6 mt-0.5 mb-1 p-1.5 rounded text-xs font-mono whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto",
          entry.event.includes("stderr") ? "bg-red-950/20" : "bg-muted/30",
        )}>
          <code>{entry.lines.join("\n")}</code>
        </div>
      )}
      {expanded && isMergedOutput && entry.content && (!entry.lines || entry.lines.length === 0) && (
        <div className={cn(
          "ml-6 mt-0.5 mb-1 p-1.5 rounded text-xs font-mono whitespace-pre-wrap break-all",
          entry.event.includes("stderr") ? "bg-red-950/20" : "bg-muted/30",
        )}>
          <code>{entry.content}</code>
        </div>
      )}

      {/* Merged tool_call detail */}
      {expanded && isMergedToolCall && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-muted/30 rounded text-xs font-mono whitespace-pre-wrap break-all">
          {entry.input != null && (
            <div className="mb-1">
              <span className="text-muted-foreground">输入:</span>{" "}
              <code>{typeof entry.input === "string" ? entry.input : JSON.stringify(entry.input, null, 2)}</code>
            </div>
          )}
          {entry.result != null && (
            <div>
              <span className="text-muted-foreground">结果:</span>{" "}
              <code>{entry.result}</code>
            </div>
          )}
        </div>
      )}

      {/* Merged thinking_block detail */}
      {expanded && isMergedThinking && entry.content && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-muted/30 rounded text-xs font-mono whitespace-pre-wrap break-all">
          <code>{entry.content}</code>
        </div>
      )}

      {/* Merged text_block detail */}
      {expanded && isMergedText && entry.content && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-muted/30 rounded text-xs font-mono whitespace-pre-wrap break-all">
          <code>{entry.content}</code>
        </div>
      )}

      {/* Legacy bash_log expanded */}
      {expanded && isBashLog && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-muted/30 rounded text-xs font-mono whitespace-pre-wrap break-all">
          <code>{bashLine}</code>
        </div>
      )}

      {/* Legacy agent_event detail */}
      {expanded && entry.event_data && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-muted/30 rounded text-xs font-mono whitespace-pre-wrap break-all">
          {entry.event_data.type === "tool_input" && entry.event_data.input != null && (
            <code>{typeof entry.event_data.input === "string" ? entry.event_data.input : JSON.stringify(entry.event_data.input, null, 2)}</code>
          )}
          {entry.event_data.type === "tool_result" && (
            <code>{entry.event_data.content}</code>
          )}
          {entry.event_data.type === "thinking_block" && entry.event_data.content && (
            <code>{entry.event_data.content}</code>
          )}
          {entry.event_data.type === "text_delta" && entry.event_data.content && (
            <code>{entry.event_data.content}</code>
          )}
        </div>
      )}

      {/* Legacy swarm detail */}
      {expanded && isSwarmDetail && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-muted/30 rounded text-xs whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto">
          {entry.event === "expert_message" && entry.content && (
            <div className="font-mono"><code>{entry.content}</code></div>
          )}
          {entry.event === "expert_complete" && entry.output && (
            <div>
              <div className="text-muted-foreground mb-1">角色: {entry.role} | 状态: {entry.status} | Tokens: {entry.tokens}</div>
              <div className="font-mono"><code>{entry.output}</code></div>
            </div>
          )}
          {entry.event === "swarm_complete" && entry.synthesis && (
            <div>
              <div className="text-muted-foreground mb-1">状态: {entry.status}</div>
              <div className="font-mono"><code>{typeof entry.synthesis === "string" && entry.synthesis.startsWith("{") ? (() => { try { return JSON.parse(entry.synthesis).synthesis ?? entry.synthesis } catch { return entry.synthesis } })() : entry.synthesis}</code></div>
            </div>
          )}
          {entry.event === "swarm_complete" && !entry.synthesis && (
            <div className="text-muted-foreground">状态: {entry.status} (无 synthesis)</div>
          )}
        </div>
      )}
    </div>
  )
}

// ============ Main Component ============

export function ExecutionLogViewer({ workspaceId, executionId, executionStatus }: LogViewerProps) {
  const { events: rawEvents, loopIterations, loading, error } = useExecutionEvents(
    workspaceId, executionId, executionStatus,
  )
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const prevGroupKeysRef = useRef("")

  // Legacy client-side merging for old agent_event format
  const processedEvents = useMemo(() => {
    const result: LogEvent[] = []
    let thinkingBlock: LogEvent | null = null

    const flushThinking = () => {
      if (!thinkingBlock) return
      result.push(thinkingBlock)
      thinkingBlock = null
    }

    for (const e of rawEvents) {
      // New merged format — skip client-side merging
      if (isMergedEvent(e)) {
        flushThinking()
        result.push(e as LogEvent)
        continue
      }

      const ed = e.event_data
      const isThinking = e.event === "agent_event" && ed && (
        ed.type === "thinking_start" || ed.type === "thinking" || ed.type === "thinking_done"
      )
      const isTextDelta = e.event === "agent_event" && ed?.type === "text_delta"

      if (thinkingBlock && !isThinking) flushThinking()

      if (isThinking) {
        if (!thinkingBlock) {
          thinkingBlock = {
            ...e,
            event_data: { type: "thinking_block", content: "" },
            __mergedCount: 0,
          }
        }
        if (ed!.type === "thinking") {
          thinkingBlock.event_data!.content = (thinkingBlock.event_data!.content ?? "") + (ed!.content ?? "")
          thinkingBlock.__mergedCount = (thinkingBlock.__mergedCount ?? 0) + 1
        } else if (ed!.type === "thinking_done") {
          thinkingBlock.event_data!.duration = ed!.duration
          thinkingBlock.__done = true
        }
        thinkingBlock.timestamp = e.timestamp
        continue
      }

      if (isTextDelta) {
        const prev = result[result.length - 1]
        if (prev && prev.event === "agent_event" && prev.event_data?.type === "text_delta" && prev.nodeId === e.nodeId) {
          prev.event_data = { ...prev.event_data, content: (prev.event_data.content ?? "") + (ed!.content ?? "") }
          prev.__mergedCount = (prev.__mergedCount ?? 1) + 1
          prev.timestamp = e.timestamp
        } else {
          result.push({ ...e } as LogEvent)
        }
        continue
      }

      flushThinking()
      result.push({ ...e } as LogEvent)
    }

    flushThinking()
    return result
  }, [rawEvents])

  // Flat grouping with loop-aware rendering:
  // - Iteration events: key = "{nodeId}-{iteration}"
  // - Loop node start/end: key = "{nodeId}-start" / "{nodeId}-end" (bookends)
  // - Other events: key = "{nodeId}"
  // - branch_start/branch_end: excluded (metadata for LoopOverview only)
  // Groups ordered by first event timestamp
  interface FlatGroup {
    key: string
    label: string
    events: LogEvent[]
    firstTimestamp: string
  }

  const nodeGroups = useMemo(() => {
    // Detect loop parent nodes from loopIterations (server-provided)
    const loopParentNodes = new Set<string>()
    if (loopIterations) {
      for (const nodeId of Object.keys(loopIterations)) {
        loopParentNodes.add(nodeId)
      }
    }

    const map = new Map<string, FlatGroup>()

    for (const e of processedEvents) {
      // Skip branch markers — they're metadata, not display events
      if (e.event === "branch_start" || e.event === "branch_end") continue

      const nodeId = e.nodeId || "(未分类)"
      const hasIter = e.iteration != null && e.iteration > 0

      let key: string
      let label: string

      if (loopParentNodes.has(nodeId) && !hasIter) {
        // Loop parent node: split into start/end bookends
        if (e.event === "start") {
          key = `${nodeId}-start`
          label = `${nodeId} start`
        } else if (e.event === "end") {
          key = `${nodeId}-end`
          label = `${nodeId} end`
        } else {
          // Skip other loop parent events (agent_event wrappers)
          continue
        }
      } else if (hasIter) {
        key = `${nodeId}-${e.iteration}`
        label = `${nodeId}-${e.iteration}`
      } else {
        key = nodeId
        label = nodeId
      }

      if (!map.has(key)) {
        map.set(key, { key, label, events: [], firstTimestamp: e.timestamp || e.startedAt || "" })
      }
      map.get(key)!.events.push(e)
    }

    // Sort groups by first event timestamp (chronological)
    const sorted = new Map(
      Array.from(map.entries()).sort((a, b) =>
        (a[1].firstTimestamp).localeCompare(b[1].firstTimestamp)
      )
    )
    return sorted
  }, [processedEvents, loopIterations])

  // Auto-collapse: collapse old groups, expand newest
  const groupKeys = useMemo(() => Array.from(nodeGroups.keys()).join(","), [nodeGroups])

  useEffect(() => {
    if (groupKeys === prevGroupKeysRef.current) return
    prevGroupKeysRef.current = groupKeys

    const keys = groupKeys ? groupKeys.split(",") : []
    const toCollapse = new Set(keys)
    const lastKey = keys[keys.length - 1]
    if (lastKey) toCollapse.delete(lastKey)
    setCollapsedNodes(toCollapse)
  }, [groupKeys])

  // Pin to bottom on new events
  useEffect(() => {
    if (processedEvents.length > prevCountRef.current && containerRef.current) {
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight
        }
      })
    }
    prevCountRef.current = processedEvents.length
  }, [processedEvents])

  const toggleNode = (nodeId: string) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const collapseAll = () => setCollapsedNodes(new Set(nodeGroups.keys()))
  const expandAll = () => setCollapsedNodes(new Set())

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        加载日志...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-1">
        <span className="text-xs text-red-400">日志加载失败</span>
        <span className="text-[10px] text-muted-foreground">{error}</span>
      </div>
    )
  }

  if (nodeGroups.size === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        暂无日志
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {nodeGroups.size > 1 && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border/30 shrink-0">
          <button
            onClick={expandAll}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            title="全部展开"
          >
            <ChevronsDown className="h-3 w-3" />
            展开
          </button>
          <button
            onClick={collapseAll}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
            title="全部折叠"
          >
            <ChevronUp className="h-3 w-3" />
            折叠
          </button>
        </div>
      )}
      <div ref={containerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="p-2 space-y-2">
          {Array.from(nodeGroups.entries()).map(([key, group]) => {
            return (
              <div key={key} className="rounded border border-border/50 overflow-hidden">
                <div
                  className="flex items-center gap-1.5 px-2 py-1 bg-muted/30 cursor-pointer hover:bg-muted/50 text-xs font-medium"
                  onClick={() => toggleNode(key)}
                >
                  {collapsedNodes.has(key)
                    ? <ChevronRight className="h-3 w-3" />
                    : <ChevronDown className="h-3 w-3" />
                  }
                  <span className="text-muted-foreground">{group.label}</span>
                  <span className="text-muted-foreground/40 ml-auto">
                    {group.events.length} events
                  </span>
                </div>
                {!collapsedNodes.has(key) && (
                  <div className="px-2 py-1 space-y-1">
                    {group.events.map((entry, i) => (
                      <ExpandableRow key={`${key}-${i}`} entry={entry} />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
