"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { ChevronDown, ChevronRight, ChevronUp, ChevronsDown, Terminal, Brain, Wrench, FileText, Play, Check, X, Clock, Users, MessageSquare, Award, RotateCcw, MessageCircle, HelpCircle, CheckCircle2, Activity, AlertTriangle, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatDuration, formatTokenCount } from "@/lib/format"
import { isMergedEvent, OCTOPUS_EVENT_TYPES, type AgentEvent, type LoopIterationSummary } from "@/lib/types"
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
  // Approval metadata fields
  prompt?: string
  options?: Array<{ label: string; value: string }>
  decision?: string
  comment?: string
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

/** Maximum events rendered per node group. Real count shown in header. */
const MAX_RENDERED_EVENTS = 100

// ============ EventIcon ============

export function EventIcon({ event, agentType }: { event: string; agentType?: string }) {
  // Merged event types (server-side pre-merged)
  switch (event) {
    case "thinking_block": return <Brain className="h-3 w-3 text-purple-400 shrink-0" />
    case "text_block": return <FileText className="h-3 w-3 text-blue-400 shrink-0" />
    case "tool_call": return <Wrench className="h-3 w-3 text-amber-400 shrink-0" />
    case "bash_output": return <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
    case "approval_metadata": return <MessageSquare className="h-3 w-3 text-cyan-400 shrink-0" />
    case "python_output": return <Terminal className="h-3 w-3 text-muted-foreground shrink-0" />
    case "bash_stderr": return <X className="h-3 w-3 text-red-400 shrink-0" />
    case "python_stderr": return <X className="h-3 w-3 text-red-400 shrink-0" />
    case "branch_start": return <Play className="h-3 w-3 text-emerald-400 shrink-0" />
    case "branch_end": return <Check className="h-3 w-3 text-emerald-400 shrink-0" />
    case "node_log": return <FileText className="h-3 w-3 text-indigo-400 shrink-0" />
  }

  // Legacy agent_event sub-types
  if (event === "agent_event" && agentType) {
    // Harness events stored as agent_event with harness_* type
    if (agentType.startsWith("harness_")) {
      return <ShieldCheck className="h-3 w-3 text-violet-400 shrink-0" />
    }
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
    // Interaction milestone events
    case "interaction_started": return <MessageCircle className="h-3 w-3 text-purple-400 shrink-0" />
    case "interaction_ask_user_question": return <HelpCircle className="h-3 w-3 text-amber-400 shrink-0" />
    case "interaction_completed": return <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
    case "heartbeat": return <Activity className="h-3 w-3 text-rose-500 shrink-0" />
    case "harness_directive": return <AlertTriangle className="h-3 w-3 text-red-500 shrink-0" />
    case "heartbeat_stall": return <AlertTriangle className="h-3 w-3 text-orange-500 shrink-0" />
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
    case "node_log": {
      const line = entry.line ?? entry.content ?? ""
      return <span className="text-indigo-400 font-mono text-[11px] truncate max-w-[300px]">{line}</span>
    }
    case "approval_metadata": {
      const decision = entry.decision ?? ""
      return decision
        ? <span className="text-emerald-400">用户选择: <span className="font-mono font-bold">{decision}</span></span>
        : <span className="text-cyan-400">等待审批...</span>
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
          <code className="text-xs bg-muted px-1 rounded">{e.toolName ?? "工具"}</code>
          {" "}结果 {e.duration && `(${e.duration})`}
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
      default: {
        // Harness events: harness_process_conflict, harness_stupid_retry, etc.
        if (e.type?.startsWith("harness_")) {
          const parsed = (() => { try { return JSON.parse(e.content || "{}") } catch { return {} as Record<string, string> } })()
          const detector = parsed.detector || e.type.replace("harness_", "")
          const severity = parsed.severity || ""
          const status = parsed.status || ""
          const evidence = parsed.evidence
          const evidenceText = Array.isArray(evidence)
            ? evidence.map((ev: any) => ev.errorMessage || ev.pattern || "").filter(Boolean).join("; ")
            : typeof evidence === "string" ? evidence : ""
          const isBlocked = status === "harness_blocked"
          const isModified = status === "harness_modified"
          const isExecuted = status === "harness_executed"
          const color = isBlocked ? "text-red-400" : isModified || isExecuted ? "text-violet-400" : severity === "critical" ? "text-red-400" : "text-amber-400"
          const label = isBlocked ? `🛡️ Harness 阻断: ${detector}` : isModified ? "🛡️ Harness 已修正" : isExecuted ? "🤖 Harness Agent 接管" : `🛡️ Harness 检测: ${detector}`
          const detail = isBlocked ? (evidenceText ? ` — ${evidenceText.slice(0, 80)}` : ` (${severity})`) : isModified || isExecuted ? `: ${detector}` : ` (${severity})`
          return <span className={color}>{label}{detail}</span>
        }
        return <span className="text-muted-foreground">{e.type}</span>
      }
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
    case "expert_message": {
      const meta: string[] = []
      if (entry.tokens != null) meta.push(formatTokenCount(entry.tokens))
      if (entry.round != null) meta.push(`第${entry.round}轮`)
      const metaStr = meta.length > 0 ? ` (${meta.join(", ")})` : ""
      return <span className={entry.status === "failed" ? "text-red-400" : "text-blue-400"}>
        专家 <code className="text-xs bg-muted px-1 rounded">{entry.role}</code>
        <span className="text-muted-foreground/60 ml-1">{metaStr}</span>
        {entry.status === "failed" && " — 失败"}
      </span>
    }
    case "swarm_round_end":
      return <span className="text-purple-400">轮次结束 第{entry.round}轮 ({entry.expertCount} 专家)</span>
    case "swarm_complete":
      return <span className={entry.status === "failed" ? "text-red-400" : "text-yellow-400"}>
        Swarm 完成 — {entry.status}
      </span>
    case "consensus_check":
      return <span className="text-purple-400">共识检测 第{entry.round}轮</span>
    // Interaction milestone events
    case "interaction_started":
      return <span className="text-purple-400">交互开始</span>
    case "interaction_ask_user_question":
      return <span className="text-amber-400">等待用户回答</span>
    case "interaction_completed":
      return <span className="text-emerald-400">交互完成</span>
    case "heartbeat": {
      const hb = entry.heartbeatPayload
      if (!hb) return <span className="text-rose-500">心跳</span>
      const tokens = hb.tokens_used?.toLocaleString() ?? "0"
      const activity = hb.current_activity ? ` · ${hb.current_activity}` : ""
      return <span className="text-rose-500">心跳: Step {hb.step} · {tokens} tokens{activity}</span>
    }
    case "harness_directive": {
      const dir = entry.directivePayload
      if (!dir) return <span className="text-red-500">指令</span>
      const isAbort = dir.type === "abort"
      const isInject = dir.type === "inject"
      return (
        <span className={isAbort ? "text-red-500" : isInject ? "text-violet-500" : "text-amber-500"}>
          {isInject ? "🛡️ 注入" : isAbort ? "🚫 终止" : "⏸️ 暂停"}: {dir.reason}
          {isInject && dir.message && (
            <span className="text-muted-foreground ml-1">→ {dir.message.slice(0, 40)}{dir.message.length > 40 ? "..." : ""}</span>
          )}
        </span>
      )
    }
    case "heartbeat_stall": {
      const stall = entry.stallPayload
      const timeout = stall?.timeout_seconds ?? "?"
      return <span className="text-orange-500">停滞检测: 超过 {timeout}s 无心跳</span>
    }
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
  const isApprovalMeta = entry.event === "approval_metadata"
  const isOctopusEvent = (OCTOPUS_EVENT_TYPES as readonly string[]).includes(entry.event)
  const hasDetail = isMergedOutput || isMergedToolCall || isMergedThinking || isMergedText ||
    isAgentDetail || (isBashLog && isLongLine) || isSwarmDetail || isApprovalMeta || isOctopusEvent

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

      {/* Approval metadata detail */}
      {expanded && entry.event === "approval_metadata" && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-cyan-950/20 rounded text-xs whitespace-pre-wrap">
          {entry.prompt && (
            <div className="mb-1">
              <span className="text-cyan-400">提示:</span>{" "}
              <span>{entry.prompt}</span>
            </div>
          )}
          {entry.options && Array.isArray(entry.options) && entry.options.length > 0 && (
            <div className="mb-1">
              <span className="text-cyan-400">选项:</span>{" "}
              <span>{entry.options.map((o: any) => o.label).join(", ")}</span>
            </div>
          )}
          {entry.decision && (
            <div className="mb-1">
              <span className="text-emerald-400">决定:</span>{" "}
              <span className="font-mono">{entry.decision}</span>
            </div>
          )}
          {entry.comment && (
            <div>
              <span className="text-muted-foreground">备注:</span>{" "}
              <span>{entry.comment}</span>
            </div>
          )}
        </div>
      )}

      {/* Octopus agent event detail: heartbeat */}
      {expanded && entry.event === "heartbeat" && entry.heartbeatPayload && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-rose-950/20 rounded text-xs whitespace-pre-wrap">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span className="text-muted-foreground">步骤:</span>
            <span>{entry.heartbeatPayload.step}{entry.heartbeatPayload.total_steps ? ` / ${entry.heartbeatPayload.total_steps}` : ""}</span>
            <span className="text-muted-foreground">Token:</span>
            <span className="tabular-nums">{entry.heartbeatPayload.tokens_used.toLocaleString()}{entry.heartbeatPayload.tokens_budget ? ` / ${entry.heartbeatPayload.tokens_budget.toLocaleString()}` : ""}</span>
            <span className="text-muted-foreground">置信度:</span>
            <span>{(entry.heartbeatPayload.confidence * 100).toFixed(0)}%</span>
            {entry.heartbeatPayload.current_activity && (
              <>
                <span className="text-muted-foreground">活动:</span>
                <span>{entry.heartbeatPayload.current_activity}</span>
              </>
            )}
            {entry.heartbeatPayload.artifacts.length > 0 && (
              <>
                <span className="text-muted-foreground">产出物:</span>
                <span>{entry.heartbeatPayload.artifacts.join(", ")}</span>
              </>
            )}
            {entry.heartbeatPayload.issues.length > 0 && (
              <>
                <span className="text-muted-foreground">问题:</span>
                <span className="text-amber-400">{entry.heartbeatPayload.issues.join(", ")}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Octopus agent event detail: harness_directive */}
      {expanded && entry.event === "harness_directive" && entry.directivePayload && (
        <div className={`ml-6 mt-0.5 mb-1 p-1.5 rounded text-xs whitespace-pre-wrap ${entry.directivePayload.type === "abort" ? "bg-red-950/20" : entry.directivePayload.type === "inject" ? "bg-violet-950/20" : "bg-amber-950/20"}`}>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span className="text-muted-foreground">类型:</span>
            <span className={entry.directivePayload.type === "abort" ? "text-red-400 font-semibold" : entry.directivePayload.type === "inject" ? "text-violet-400 font-semibold" : "text-amber-400 font-semibold"}>{entry.directivePayload.type}</span>
            <span className="text-muted-foreground">原因:</span>
            <span>{entry.directivePayload.reason}</span>
            <span className="text-muted-foreground">发起者:</span>
            <span>{entry.directivePayload.issued_by}</span>
            {entry.directivePayload.type === "inject" && entry.directivePayload.message && (
              <>
                <span className="text-muted-foreground">消息:</span>
                <span className="text-violet-300 font-mono">{entry.directivePayload.message}</span>
              </>
            )}
            {entry.directivePayload.type === "inject" && entry.directivePayload.nodeId && (
              <>
                <span className="text-muted-foreground">目标节点:</span>
                <span className="font-mono">{entry.directivePayload.nodeId}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Octopus agent event detail: heartbeat_stall */}
      {expanded && entry.event === "heartbeat_stall" && entry.stallPayload && (
        <div className="ml-6 mt-0.5 mb-1 p-1.5 bg-orange-950/20 rounded text-xs whitespace-pre-wrap">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span className="text-muted-foreground">超时阈值:</span>
            <span>{entry.stallPayload.timeout_seconds}s</span>
            {entry.stallPayload.last_heartbeat_at && (
              <>
                <span className="text-muted-foreground">最后心跳:</span>
                <span>{entry.stallPayload.last_heartbeat_at}</span>
              </>
            )}
          </div>
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
          {entry.event === "expert_message" && (entry.content || entry.output) && (
            <div>
              <div className="text-muted-foreground mb-1">
                角色: {entry.role} | 状态: {entry.status ?? "completed"} | Tokens: {entry.tokens ?? "?"}
              </div>
              <div className="font-mono"><code>{entry.content ?? entry.output}</code></div>
            </div>
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
  const [harnessOnly, setHarnessOnly] = useState(false)
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

    // Second pass: merge expert_complete + expert_message pairs
    // They carry identical content and arrive in chronological order (1:1 per expert per round).
    // Must work even when SQLite drops the content column (role/tokens missing from expert_complete).
    const completeQueue: LogEvent[] = []
    for (const e of result) {
      if (e.event === "expert_complete") completeQueue.push(e)
    }
    const consumedComplete = new Set<LogEvent>()
    const mergedResult: LogEvent[] = []
    let completeIdx = 0
    for (const e of result) {
      if (e.event === "expert_message") {
        // Pair with the next unconsumed expert_complete (FIFO — same chronological order)
        while (completeIdx < completeQueue.length && consumedComplete.has(completeQueue[completeIdx])) {
          completeIdx++
        }
        if (completeIdx < completeQueue.length) {
          const complete = completeQueue[completeIdx++]
          // Absorb metadata from both sides (either may have the data depending on storage)
          e.role = e.role ?? complete.role
          e.status = complete.status ?? e.status
          e.output = complete.output ?? e.output
          e.tokens = e.tokens ?? complete.tokens
          e.model = e.model ?? complete.model
          consumedComplete.add(complete)
        }
        mergedResult.push(e)
      } else if (e.event === "expert_complete" && consumedComplete.has(e)) {
        // Skip — already merged into expert_message
      } else {
        mergedResult.push(e)
      }
    }

    return mergedResult
  }, [rawEvents])

  // Filter events when "Harness Only" mode is active
  const HARNESS_EVENT_PREFIXES = ["harness_directive", "harness_diagnosis", "harness_intervention", "harness_blocked"]
  const filteredEvents = useMemo(() => {
    if (!harnessOnly) return processedEvents
    return processedEvents.filter((e) => {
      // Direct event match
      if (HARNESS_EVENT_PREFIXES.some((prefix) => e.event === prefix || e.event.startsWith("harness_"))) return true
      // agent_event with harness type in event_data
      if (e.event === "agent_event" && e.event_data?.type) {
        const t = e.event_data.type as string
        return t.startsWith("harness_") || HARNESS_EVENT_PREFIXES.includes(t)
      }
      return false
    })
  }, [processedEvents, harnessOnly])

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

    // Helper: extract child node ID from sub_workflow node_log line
    // Formats: "wf-name:node_start greet (bash)" or "wf-name:log [greet] ..."
    function extractSubWorkflowChild(line: string): string | null {
      // Match "{wf}:node_start {childId} ..." or "{wf}:node_end {childId} ..."
      const nodeMatch = line.match(/^[^:]+:(?:node_start|node_end)\s+(\S+)/)
      if (nodeMatch) return nodeMatch[1]
      // Match "{wf}:log [{childId}] ..."
      const logMatch = line.match(/^[^:]+:log\s+\[([^\]]+)\]/)
      if (logMatch) return logMatch[1]
      return null
    }

    // Detect sub_workflow parent nodes: nodes that have node_log events with child references
    const subWorkflowParents = new Set<string>()
    for (const e of filteredEvents) {
      if (e.event === "node_log") {
        const line = e.line ?? e.content ?? ""
        if (extractSubWorkflowChild(line)) {
          subWorkflowParents.add(e.nodeId || "")
        }
      }
    }

    // Container parents = loop parents + sub_workflow parents (both use start/end bookends)
    const containerParentNodes = new Set([...loopParentNodes, ...subWorkflowParents])

    const map = new Map<string, FlatGroup>()

    for (const e of filteredEvents) {
      // Skip branch markers — they're metadata, not display events
      if (e.event === "branch_start" || e.event === "branch_end") continue

      const nodeId = e.nodeId || "(未分类)"
      const hasIter = e.iteration != null && e.iteration > 0

      let key: string
      let label: string

      // Sub-workflow child events: group by parent:childNodeId (with iteration suffix when inside a loop)
      if (e.event === "node_log") {
        const line = e.line ?? e.content ?? ""
        const childNode = extractSubWorkflowChild(line)
        if (childNode) {
          const iterSuffix = e.iteration != null && e.iteration > 0 ? `-iter${e.iteration}` : ""
          key = `${nodeId}:${childNode}${iterSuffix}`
          label = `${nodeId}:${childNode}${iterSuffix}`
        } else {
          key = `${nodeId}:meta`
          label = `${nodeId} (meta)`
        }
      } else if (containerParentNodes.has(nodeId) && !hasIter) {
        // Container parent node (loop or sub_workflow): split into start/end bookends
        if (e.event === "start") {
          key = `${nodeId}-start`
          label = `${nodeId} start`
        } else if (e.event === "end") {
          key = `${nodeId}-end`
          label = `${nodeId} end`
        } else {
          // Skip other container parent events
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
  }, [filteredEvents, loopIterations])

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

  if (nodeGroups.size === 0 && !harnessOnly) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        暂无日志
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {(nodeGroups.size > 1 || harnessOnly) && (
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
          <span className="text-muted-foreground/30">|</span>
          <button
            onClick={() => setHarnessOnly(!harnessOnly)}
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors",
              harnessOnly
                ? "bg-violet-600/20 text-violet-400 border border-violet-500/30"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            title={harnessOnly ? "显示所有事件" : "仅显示 Harness 事件"}
          >
            🛡️ {harnessOnly ? "Harness Only" : "All Events"}
          </button>
        </div>
      )}
      {harnessOnly && nodeGroups.size === 0 && (
        <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
          暂无 Harness 事件，点击 🛡️ 切回全部日志
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
                    {group.events.length > MAX_RENDERED_EVENTS && (
                      <div className="text-[10px] text-muted-foreground/60 text-center py-0.5">
                        显示最新 {MAX_RENDERED_EVENTS} 条（共 {group.events.length} 条）
                      </div>
                    )}
                    {group.events
                      .slice(-MAX_RENDERED_EVENTS)
                      .map((entry, i) => (
                        <ExpandableRow key={`${key}-${i}`} entry={entry} />
                      ))
                    }
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
