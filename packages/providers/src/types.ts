import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

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

export interface SendQueryOptions {
  model?: string
  systemPrompt?: SystemPromptInput
  abortSignal?: AbortSignal
  maxBudgetUsd?: number
  env?: Record<string, string>
  agent?: string
  skills?: string[]
  agents?: Record<string, AgentDefinition>
  /** 额外指定的 plugins（与自动检测的白名单 plugins 合并） */
  plugins?: Array<{ type: 'local'; path: string }>
  /** 禁用的 plugin 名称列表（从自动检测结果中排除） */
  disablePlugins?: string[]
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
  | { type: 'status'; status: 'compacting' | 'requesting' | null }
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