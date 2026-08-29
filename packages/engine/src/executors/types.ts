import type { LLMCallRecord } from "@octopus/providers"
import type { TokenUsage, ModelUsage } from "@octopus/shared"
import type { AgentEvent } from "./agent-types"

export interface ApprovalMetadata {
  prompt: string
  options: Array<{ label: string; value: string }>
  nodeId: string
  commentLabel?: string
  commentPlaceholder?: string
}

/** Override for inner loop nodes during resume. Either a pre-computed result or an approval choice. */
export type InnerNodeOverride =
  | { kind: "result"; result: NodeExecutionResult }
  | { kind: "approval"; userChoice: string; userComment?: string }

export interface InteractionMetadata {
  sessionId: string
  nodeId: string
  maxRounds?: number
  timeout?: number
  /** Resolved initial prompt (with variable substitution) — pre-computed by engine
   *  so the frontend doesn't need to re-read the workflow YAML. */
  initialPrompt?: string
}

/** Metadata returned when a task_dispatch node pauses to await a child schedule (G1).
 *  The server correlates the completion callback via scheduleHandle.schedule_id
 *  and resumes the parent by re-invoking the engine with a childOutput payload. */
export interface TaskDispatchMetadata {
  nodeId: string
  /** Opaque handle to the dispatched child schedule (shared type). */
  scheduleHandle: { schedule_id: string; workspace_id?: string }
  /** Name of the subunit that was dispatched (observability). */
  subunitName?: string
}

export interface NodeExecutionResult {
  lastOutput?: string
  exitCode?: number
  outputs: Record<string, any>
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "skipped_failed" | "cancelled" | "paused" | "rejected" | "pending_approval" | "pending_interaction" | "pending_task_dispatch"
  durationMs: number
  logLines: string[]
  error?: string
  matchedCase?: number
  decision?: string
  comment?: string
  iterations?: number
  jumpTo?: string
  timeout?: number
  sessionId?: string
  /** 规范用量（纯值口径，C1） */
  usage?: TokenUsage
  modelUsages?: ModelUsage[]
  events?: AgentEvent[]
  approvalMetadata?: ApprovalMetadata
  interactionMetadata?: InteractionMetadata
  taskDispatchMetadata?: TaskDispatchMetadata
  /** Completed inner node results from the iteration that hit pending_approval. Used for resume. */
  innerNodeResults?: Record<string, NodeExecutionResult>
  /** True when node was skipped because execute_when evaluated to false.
   *  Downstream nodes should NOT cascade-skip from this — it's an intentional skip. */
  skippedByCondition?: boolean
  /** True when harness block_node set continueSubsequent: true.
   *  Downstream nodes should NOT cascade-skip from this — the harness decided
   *  the failure is acceptable and subsequent nodes should continue. */
  harnessContinue?: boolean
  /** Number of retries before final result (0 = first attempt succeeded or no retry) */
  retryCount?: number
  /** Raw LLM call records for observability persistence */
  llmCalls?: LLMCallRecord[]
}

export interface NodeExecutor {
  execute(): Promise<NodeExecutionResult>
}