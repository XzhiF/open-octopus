// Runtime supervision contract — the stable interface a running workflow exposes
// to any supervisor (the main chat agent, a human, an external HTTP agent…).
//
// The engine does not know about agents. It only awaits four callbacks. The
// RuntimeSupervisor turns detector signals into Incidents, hands them to an
// owner, and applies the owner's Decision through a single ActionExecutor.

/** Where in the node lifecycle the signal was produced. */
export type IncidentPhase =
  | "before_node"
  | "before_retry"
  | "failure_exhausted"
  | "node_end"

export type IncidentSeverity = "info" | "warning" | "critical"

/**
 * Incident lifecycle:
 *
 *   open ──► dispatched ──► waiting_human ──► resolved
 *     │            │                │
 *     ├────────────┴────────────────┴──► expired
 *     └──► unowned            (no owner; held for the manual queue)
 */
export type IncidentStatus =
  | "open"
  | "dispatched"
  | "waiting_human"
  | "resolved"
  | "expired"
  | "unowned"

/** Every action a supervisor may take. The runtime narrows this per incident. */
export type DecisionType =
  | "proceed"
  | "inject"
  | "retry"
  | "pause"
  | "abort"
  | "block"
  | "reload"
  | "escalate"

export interface Incident {
  id: string
  executionId: string
  workspaceId: string
  nodeId: string
  /** The actual failing inner node for loop containers. */
  displayNodeId?: string
  phase: IncidentPhase
  severity: IncidentSeverity
  /** Signal kind, e.g. `stupid_retry`, `process_conflict`, `timeout_cascade`. */
  kind: string
  /** One sentence a human can read. */
  summary: string
  /** Structured facts: error text, attempts, matched pattern… */
  evidence: Array<Record<string, unknown>>
  /** Read-only context handle — keep large blobs out of prompts. */
  contextRef: string
  /** Actions the runtime allows. A supervisor cannot exceed this list. */
  allowedActions: DecisionType[]
  createdAt: number
  deadlineAt?: number
}

/** A persisted incident with lifecycle + owner state. */
export interface IncidentRecord extends Incident {
  status: IncidentStatus
  ownerKind: SupervisorKind | null
  ownerRef: string | null
  decision: Decision | null
  resolutionSource: "agent" | "user" | "policy" | null
  dispatchedAt: number | null
  resolvedAt: number | null
}

export type Decision =
  | { type: "proceed" }
  | { type: "inject"; message: string }
  | {
      type: "retry"
      hint?: string
      varPoolPatches?: Record<string, string>
      model?: string
    }
  | { type: "pause"; reason: string }
  | { type: "abort"; reason: string }
  | { type: "block"; reason: string; continueSubsequent?: boolean }
  | { type: "reload"; yaml: string }
  | { type: "escalate"; reason: string; options?: string[] }

export type SupervisorKind = "chat" | "human" | "http" | "system"

/**
 * Generic supervisor adapter. `notify` is fire-and-forget; a chat agent reads
 * the incident later and resolves it through a tool. `requestDecision` is the
 * synchronous variant for a human card — never used on the engine's awaited
 * hooks (the runtime must not block an engine on a human).
 */
export interface Supervisor {
  readonly id: string
  readonly kind: SupervisorKind
  /**
   * `wake: false` means "record it, don't start an agent turn" — the runtime
   * uses that for info-level incidents so routine retries stay quiet.
   */
  notify(incident: Incident, opts?: { wake?: boolean }): Promise<void>
  requestDecision?(
    incident: Incident,
    opts: { timeoutMs: number },
  ): Promise<Decision | null>
}

/** Actions a chat owner can take on an incident. Hard guards narrow this. */
export const DEFAULT_ALLOWED_ACTIONS: DecisionType[] = [
  "proceed",
  "inject",
  "retry",
  "pause",
  "abort",
  "block",
  "reload",
  "escalate",
]

export const INCIDENT_STATUS_TERMINAL: ReadonlySet<IncidentStatus> = new Set([
  "resolved",
  "expired",
])

/** Human-readable one-liner for a detector report. */
export function summarizeSignal(input: {
  detector: string
  pattern?: string
  nodeId: string
  error?: string
  attempts?: number
}): string {
  const node = input.nodeId || "未知节点"
  switch (input.detector) {
    case "process_conflict":
      return `节点 ${node} 命中危险进程/端口操作，已由硬护栏阻断。`
    case "stupid_retry":
      return `节点 ${node} 因同一错误重复失败${input.attempts ? `（${input.attempts} 次）` : ""}。`
    case "deterministic_error":
      return `节点 ${node} 出现确定性错误（语法/路径/依赖），重试无意义。`
    case "model_mismatch":
      return `节点 ${node} 的模型能力与任务不匹配。`
    case "timeout_cascade":
      return `节点 ${node} 连续超时。`
    case "tool_interceptor":
      return `Agent 尝试执行危险命令，已被拦截。`
    default: {
      const detail = input.error ? `：${input.error.slice(0, 160)}` : ""
      return `节点 ${node} 触发 ${input.detector}${detail}`
    }
  }
}
