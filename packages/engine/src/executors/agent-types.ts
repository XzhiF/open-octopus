import type { TokenUsage, ModelUsageEntry, LLMCallRecord } from "@octopus/providers"

export type AgentEvent =
  | { type: "thinking_start"; timestamp: number }
  | { type: "thinking"; content: string; timestamp: number }
  | { type: "thinking_done"; duration?: string; timestamp: number }
  | { type: "tool_start"; toolCallId: string; toolName: string; timestamp: number }
  | { type: "tool_input"; toolCallId: string; toolName: string; input: unknown; timestamp: number }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean; duration?: string; timestamp: number }
  | { type: "text_delta"; content: string; timestamp: number }
  | { type: "status"; status: "compacting" | "requesting" | "resuming_after_crash" | null; timestamp: number }
  | { type: "error"; code: string; message: string; timestamp: number }

export interface AgentRunResult {
  finalText: string
  sessionId?: string
  tokens?: TokenUsage
  modelUsages?: ModelUsageEntry[]
  costUsd?: number
  events: AgentEvent[]
  durationMs: number
  llmCalls?: LLMCallRecord[]
}