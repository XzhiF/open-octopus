import type { TokenUsage, ModelUsageEntry, LLMCallRecord, GoalTerminalReason } from "@octopus/providers"
import type { AgentHeartbeat, HarnessDirective } from "@octopus/shared"

export type AgentEvent =
  | { type: "thinking_start"; timestamp: number }
  | { type: "thinking"; content: string; timestamp: number }
  | { type: "thinking_done"; duration?: string; timestamp: number }
  | { type: "tool_start"; toolCallId: string; toolName: string; timestamp: number }
  | { type: "tool_input"; toolCallId: string; toolName: string; input: unknown; timestamp: number }
  | { type: "tool_result"; toolCallId: string; toolName: string; content: string; isError?: boolean; duration?: string; timestamp: number }
  | { type: "text_delta"; content: string; timestamp: number }
  | { type: "status"; status: "compacting" | "requesting" | "resuming_after_crash" | null; timestamp: number }
  | { type: "error"; code: string; message: string; timestamp: number }
  /** Convergence evidence from the SDK /goal evaluator (passthrough of the
   *  provider's active_goal chunk). condition: null means the goal was
   *  cleared/met — do not fabricate an empty string. */
  | { type: "active_goal"; condition: string | null; iterations: number; last_reason?: string; set_at?: number; timestamp: number }
  | { type: "heartbeat"; data: AgentHeartbeat }
  | { type: "harness_directive"; data: HarnessDirective }
  | { type: "heartbeat_stall"; data: { nodeId: string } }

export interface AgentRunResult {
  finalText: string
  sessionId?: string
  tokens?: TokenUsage
  modelUsages?: ModelUsageEntry[]
  costUsd?: number
  events: AgentEvent[]
  durationMs: number
  llmCalls?: LLMCallRecord[]
  /** Set when the run ended on an SDK hard-fuse terminal (error_max_turns /
   *  error_max_budget_usd) — NOT an exception: the stream is authoritative. */
  terminalReason?: GoalTerminalReason
  terminalMeta?: { numTurns?: number; costUsd?: number }
}