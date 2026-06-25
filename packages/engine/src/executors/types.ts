import type { TokenUsage, ModelUsageEntry, LLMCallRecord } from "@octopus/providers"
import type { AgentEvent } from "./agent-types"

export interface ApprovalMetadata {
  prompt: string
  options: Array<{ label: string; value: string }>
  nodeId: string
}

export interface NodeExecutionResult {
  lastOutput?: string
  exitCode?: number
  outputs: Record<string, any>
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "skipped_failed" | "cancelled" | "paused" | "rejected" | "pending_approval"
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
  tokens?: TokenUsage
  modelUsages?: ModelUsageEntry[]
  events?: AgentEvent[]
  approvalMetadata?: ApprovalMetadata
  /** True when node was skipped because execute_when evaluated to false.
   *  Downstream nodes should NOT cascade-skip from this — it's an intentional skip. */
  skippedByCondition?: boolean
  /** Number of retries before final result (0 = first attempt succeeded or no retry) */
  retryCount?: number
  /** Raw LLM call records for observability persistence */
  llmCalls?: LLMCallRecord[]
}

export interface NodeExecutor {
  execute(): Promise<NodeExecutionResult>
}