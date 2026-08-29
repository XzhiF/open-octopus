import type { LLMCallRecord } from './llm-call-tracker'
import type { EffortLevel } from '@octopus/shared'

export interface TokenUsage {
  input: number
  output: number
  total?: number
}

export interface ModelUsageEntry {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  costUsd?: number
}

export interface SystemPromptPreset {
  type: 'preset'
  preset: 'claude_code'
  append?: string
}

export type SystemPromptInput = string | SystemPromptPreset

export interface OctopusAgentDef {
  description: string
  prompt: string
  tools?: string[]
  model?: string
  skills?: string[]
  maxTurns?: number
  background?: boolean
  effort?: EffortLevel
}

export interface ProviderPolicy {
  allowedEngines?: string[]
  maxConcurrentSessions?: number
  budgetLimitUsd?: number
}

export interface SendQueryOptions {
  model?: string
  systemPrompt?: SystemPromptInput
  abortSignal?: AbortSignal
  /** USD budget cap — SDK enforces it via `error_max_budget_usd` terminal result. */
  maxBudgetUsd?: number
  /** Hard cap on assistant API round-trips — SDK enforces it via `error_max_turns`. */
  maxTurns?: number
  env?: Record<string, string>
  agent?: string
  skills?: string[]
  tools?: string[]
  agents?: Record<string, OctopusAgentDef>
  plugins?: Array<{ type: 'local'; path: string }>
  disablePlugins?: string[]
  disallowedTools?: string[]
  effort?: EffortLevel
  /**
   * When true, AskUserQuestion tool calls are intercepted via canUseTool callback.
   * The deny message tells the model the question was forwarded to the web UI,
   * preventing the SDK's hardcoded "Error: Answer questions?" tool result.
   */
  interactionSession?: boolean

  /**
   * Optional callback invoked before each tool call executes.
   * Used by the Tool Interceptor (harness) to block dangerous bash commands.
   *
   * Return `{ allow: false, reason: string }` to block the tool call.
   * Return `{ allow: true }` or `undefined` to allow it.
   */
  onBeforeToolCall?: (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>
  varsUpdate?: boolean
  customProviders?: Record<string, {
    base_url: string
    api?: string
    env_key?: string
    models: Array<{
      id: string
      name?: string
      context_window?: number
      max_tokens?: number
      reasoning?: boolean
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    }>
  }>
}

/**
 * SDK hard-fuse terminal reasons, derived from the result subtype:
 * `error_max_turns` → 'max_turns', `error_max_budget_usd` → 'max_budget_usd'.
 * (The SDK's raw `terminal_reason` uses 'budget_exhausted' for the budget case —
 * we normalize to the feature vocabulary consumed by the engine runner.)
 */
export type GoalTerminalReason = 'max_turns' | 'max_budget_usd'

/**
 * Convergence evidence from the SDK's `/goal` Stop hook (SDKActiveGoalMessage,
 * a TOP-LEVEL StdoutMessage type). `condition` is null when the goal was
 * cleared (evaluator reported met); otherwise carries the condition text,
 * per-iteration count and the evaluator's last reason.
 */
export interface ActiveGoalChunk {
  type: 'active_goal'
  condition: string | null
  iterations: number
  last_reason?: string
  set_at?: number
}

/** Per-turn token usage carried by message_delta (end of each assistant message).
 *  实测（SDK 0.3.235 + 代理端点）：Σ per-turn message_delta.usage == result.usage，
 *  output_tokens 在直连 Anthropic 时必然存在；input/cache 字段按端点可能缺失。 */
export interface MessageDeltaUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export type MessageChunk =
  | { type: 'message_start'; messageId: string; inputTokens?: number }
  | { type: 'message_delta'; stopReason: string; outputTokens?: number; usage?: MessageDeltaUsage; messageId: string }
  | { type: 'message_stop'; messageId: string }
  | { type: 'text_delta'; content: string; messageId: string }
  | { type: 'text_done'; messageId: string }
  | { type: 'thinking_start'; messageId: string }
  | { type: 'thinking'; content: string; messageId: string }
  | { type: 'thinking_done'; messageId: string; thinkingDuration?: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; messageId: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; toolInput: unknown; messageId: string }
  | { type: 'tool_progress'; toolCallId: string; elapsedSeconds: number }
  | { type: 'tool_result'; toolCallId: string; toolName: string; content: string; isError?: boolean; toolDuration?: string }
  | { type: 'tool_summary'; summary: string; toolCallIds: string[] }
  | { type: 'ask_user_question'; toolCallId: string; questions: unknown }
  | { type: 'complete_interaction'; toolCallId: string; summary: string; vars_update?: Record<string, any> }
  | { type: 'local_command_output'; content: string }
  | { type: 'status'; status: 'compacting' | 'requesting' | null; varsUpdate?: Record<string, unknown> }
  | { type: 'context_usage'; data: ContextUsageData }
  | { type: 'result'; content?: string; sessionId?: string; tokens?: TokenUsage; costUsd?: number; numTurns?: number; modelUsages?: ModelUsageEntry[] }
  | { type: 'error'; code: string; message: string; numTurns?: number; costUsd?: number; sessionId?: string; terminalReason?: GoalTerminalReason }
  | ActiveGoalChunk

/** Context window usage breakdown — sourced from Claude Agent SDK's
 *  `Query.getContextUsage()`. Mirrors `SDKControlGetContextUsageResponse`.
 *  Emitted as a `context_usage` MessageChunk after `message_start`. */
export interface ContextUsageData {
  categories: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
  memoryFiles?: { path: string; type: string; tokens: number }[]
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
  systemPromptSections?: { name: string; tokens: number }[]
  systemTools?: { name: string; tokens: number }[]
  agents?: { agentType: string; source: string; tokens: number }[]
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
}

export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk>
  getType(): string
  getLLMCalls?(): LLMCallRecord[]
  testConnectivity?(model?: string): Promise<{ success: boolean; latency?: number; error?: string }>
}