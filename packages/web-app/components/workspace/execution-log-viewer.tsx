"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatDuration } from "@/lib/format"
import { ChevronDown, ChevronRight, ChevronUp, ChevronsDown, Terminal, Brain, Wrench, FileText, Play, Check, X, Clock, Users, MessageSquare, Award, RotateCcw } from "lucide-react"
import { getServerUrl } from "@/lib/server-config"
import { formatTokenCount } from "@/lib/format"

const POLL_INTERVAL_MS = 2000
const RUNNING_STATUSES = new Set(["running", "paused"])

interface LogEvent {
  timestamp: string
  nodeId: string
  event: string
  type?: string
  line?: string
  status?: string
  durationMs?: number
  exitCode?: number
  __mergedCount?: number
  // Swarm event fields (flat, not nested in event_data)
  role?: string
  model?: string
  round?: number
  expertCount?: number
  content?: string
  output?: string
  tokens?: number
  synthesis?: string
  source?: string
  event_data?: {
    type: string
    content?: string
    toolCallId?: string
    toolName?: string
    input?: unknown
    isError?: boolean
    duration?: string
    status?: string
    code?: string
    message?: string
  }
}

interface LogViewerProps {
  workspaceId: string
  executionId: string
  executionStatus?: string
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

function EventIcon({ event, agentType }: { event: string; agentType?: string }) {
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
    case "bash_stderr": return <X className="h-3 w-3 text-red-400 shrink-0" />
    case "python_stderr": return <X className="h-3 w-3 text-red-400 shrink-0" />
    // Swarm events
    case "expert_spawn": return <Users className="h-3 w-3 text-cyan-400 shrink-0" />
    case "expert_complete": return <Check className="h-3 w-3 text-cyan-400 shrink-0" />
    case "expert_message": return <MessageSquare className="h-3 w-3 text-blue-400 shrink-0" />
    case "swarm_round_end": return <RotateCcw className="h-3 w-3 text-purple-400 shrink-0" />
    case "swarm_complete": return <Award className="h-3 w-3 text-yellow-400 shrink-0" />
    case "consensus_check": return <Award className="h-3 w-3 text-purple-400 shrink-0" />
    default: return <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
  }
}

function EventLabel({ entry }: { entry: LogEvent }) {
  if (entry.event === "agent_event" && entry.event_data) {
    const e = entry.event_data
    switch (e.type) {
      case "thinking_block": {
        const isDone = (entry as any).__done
        const tokenCount = entry.__mergedCount ?? 0
        const dur = entry.event_data?.duration
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
      return <span className={isStderr ? "text-red-400 font-mono" : "text-muted-foreground font-mono"}>{entry.line}</span>
    }
    case "python_log": {
      const isStderr = entry.line?.startsWith("[stderr]")
      return <span className={isStderr ? "text-red-400 font-mono" : "text-muted-foreground font-mono"}>{entry.line}</span>
    }
    case "bash_stderr": return <span className="text-red-400 font-mono">{entry.line}</span>
    case "python_stderr": return <span className="text-red-400 font-mono">{entry.line}</span>
    // Swarm events
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

function ExpandableRow({ entry }: { entry: LogEvent }) {
  const [expanded, setExpanded] = useState(false)

  const isBashLog = entry.event === "bash_log" || entry.event === "python_log" || entry.event === "bash_stderr" || entry.event === "python_stderr"
  const isAgentDetail = entry.event === "agent_event" &&
    ["tool_input", "tool_result", "thinking_block", "text_delta"].includes(entry.event_data?.type ?? "")
  const isSwarmDetail = ["expert_message", "expert_complete", "swarm_complete"].includes(entry.event)

  const bashLine = isBashLog ? (entry.line ?? "") : ""
  const isLongLine = bashLine.length > 80
  const hasDetail = isAgentDetail || (isBashLog && isLongLine) || isSwarmDetail

  const toggle = () => hasDetail && setExpanded(!expanded)

  return (
    <div>
      <div
        className={`flex items-center gap-1.5 py-0.5 text-xs ${hasDetail ? "cursor-pointer hover:bg-muted/50 rounded" : ""}`}
        onClick={toggle}
      >
        {hasDetail && (expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />)}
        <EventIcon event={entry.event} agentType={entry.event_data?.type} />
        {isBashLog && isLongLine && !expanded ? (
          <span className="text-muted-foreground font-mono truncate">{bashLine.slice(0, 80)}...</span>
        ) : (
          <EventLabel entry={entry} />
        )}
        <span className="text-muted-foreground/40 ml-auto text-[10px] shrink-0">{formatTime(entry.timestamp)}</span>
      </div>
      {expanded && isBashLog && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-muted/30 rounded text-xs font-mono whitespace-pre-wrap break-all">
          <code>{bashLine}</code>
        </div>
      )}
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

export function ExecutionLogViewer({ workspaceId, executionId, executionStatus }: LogViewerProps) {
  const [events, setEvents] = useState<LogEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const prevGroupKeysRef = useRef("")

  const fetchEvents = useCallback(() => {
    return fetch(`${getServerUrl()}/api/workspaces/${workspaceId}/executions/${executionId}/agent-events`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => {
        const arr = Array.isArray(data) ? data : (data.events ?? [])
        setEvents(arr)
      })
      .catch(err => { setError(err.message) })
  }, [workspaceId, executionId])

  // Initial fetch
  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchEvents().finally(() => setLoading(false))
  }, [fetchEvents])

  // Poll when execution is running
  useEffect(() => {
    const isRunning = RUNNING_STATUSES.has(executionStatus ?? "")
    if (!isRunning) return

    const interval = setInterval(() => {
      fetchEvents()
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [executionStatus, fetchEvents])

  // Final fetch when execution transitions to completed/failed/cancelled
  const prevStatusRef = useRef(executionStatus)
  useEffect(() => {
    const wasRunning = RUNNING_STATUSES.has(prevStatusRef.current ?? "")
    const isDone = !RUNNING_STATUSES.has(executionStatus ?? "")
    if (wasRunning && isDone) {
      fetchEvents()
    }
    prevStatusRef.current = executionStatus
  }, [executionStatus, fetchEvents])

  // Pin to bottom when new events arrive (chatbot style)
  useEffect(() => {
    if (events.length > prevCountRef.current && containerRef.current) {
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight
        }
      })
    }
    prevCountRef.current = events.length
  }, [events])

  // Merge agent streaming events into coherent blocks
  const mergedEvents = useMemo(() => {
    const result: LogEvent[] = []
    let thinkingBlock: LogEvent | null = null // accumulate thinking_start + thinking* + thinking_done

    const flushThinking = () => {
      if (!thinkingBlock) return
      result.push(thinkingBlock)
      thinkingBlock = null
    }

    for (const e of events) {
      const ed = e.event_data
      const isThinking = e.event === "agent_event" && ed && (
        ed.type === "thinking_start" || ed.type === "thinking" || ed.type === "thinking_done"
      )
      const isTextDelta = e.event === "agent_event" && ed?.type === "text_delta"

      // Flush thinking block if a non-thinking event arrives
      if (thinkingBlock && !isThinking) {
        flushThinking()
      }

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
          ;(thinkingBlock as any).__done = true
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
          result.push({ ...e })
        }
        continue
      }

      result.push({ ...e })
    }

    flushThinking()
    return result
  }, [events])

  // Group events by nodeId
  const groups = useMemo(() => {
    const g = new Map<string, LogEvent[]>()
    for (const e of mergedEvents) {
      const key = e.nodeId || "(未分类)"
      if (!g.has(key)) g.set(key, [])
      g.get(key)!.push(e)
    }
    return g
  }, [mergedEvents])

  // Auto-collapse: when new node groups appear, collapse old ones, expand newest.
  // Uses useMemo to cache groupKeys (prevents infinite loop from new array each render).
  const groupKeys = useMemo(() => Array.from(groups.keys()).join(","), [groups])

  useEffect(() => {
    if (groupKeys === prevGroupKeysRef.current) return
    prevGroupKeysRef.current = groupKeys

    const keys = groupKeys ? groupKeys.split(",") : []
    const toCollapse = new Set(keys)
    const lastKey = keys[keys.length - 1]
    if (lastKey) toCollapse.delete(lastKey)
    setCollapsedNodes(toCollapse)
  }, [groupKeys])

  const toggleNode = (nodeId: string) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  const collapseAll = () => {
    setCollapsedNodes(new Set(groups.keys()))
  }

  const expandAll = () => {
    setCollapsedNodes(new Set())
  }

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

  if (groups.size === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        暂无日志
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar — always visible at top */}
      {groups.size > 1 && (
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
        {Array.from(groups.entries()).map(([nodeId, nodeEvents]) => (
          <div key={nodeId} className="rounded border border-border/50 overflow-hidden">
            <div
              className="flex items-center gap-1.5 px-2 py-1 bg-muted/30 cursor-pointer hover:bg-muted/50 text-xs font-medium"
              onClick={() => toggleNode(nodeId)}
            >
              {collapsedNodes.has(nodeId) ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              <span className="text-muted-foreground">{nodeId}</span>
              <span className="text-muted-foreground/40 ml-auto">{nodeEvents.length} events</span>
            </div>
            {!collapsedNodes.has(nodeId) && (
              <div className="px-2 py-1 space-y-0.5">
                {nodeEvents.map((entry, i) => (
                  <ExpandableRow key={i} entry={entry} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
    </div>
  )
}