import type { LLMCallRecord } from './llm-call-tracker'

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
  maxBudgetUsd?: number
  env?: Record<string, string>
  agent?: string
  skills?: string[]
  agents?: Record<string, OctopusAgentDef>
  plugins?: Array<{ type: 'local'; path: string }>
  disablePlugins?: string[]
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

export type MessageChunk =
  | { type: 'message_start'; messageId: string; inputTokens?: number }
  | { type: 'message_delta'; stopReason: string; outputTokens?: number; messageId: string }
  | { type: 'message_stop'; messageId: string }
  | { type: 'text_delta'; content: string; messageId: string }
  | { type: 'text_done'; messageId: string }
  | { type: 'thinking_start'; messageId: string }
  | { type: 'thinking'; content: string; messageId: string }
  | { type: 'thinking_done'; messageId: string; thinkingDuration?: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; messageId: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; toolInput: unknown; messageId: string }
  | { type: 'tool_progress'; toolCallId: string; elapsedSeconds: number }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean; toolDuration?: string }
  | { type: 'tool_summary'; summary: string; toolCallIds: string[] }
  | { type: 'ask_user_question'; toolCallId: string; questions: unknown }
  | { type: 'local_command_output'; content: string }
  | { type: 'status'; status: 'compacting' | 'requesting' | null; varsUpdate?: Record<string, unknown> }
  | { type: 'result'; content?: string; sessionId?: string; tokens?: TokenUsage; costUsd?: number; modelUsages?: ModelUsageEntry[] }
  | { type: 'error'; code: string; message: string }

export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk>
  getType(): string
  getLLMCalls?(): LLMCallRecord[]
}