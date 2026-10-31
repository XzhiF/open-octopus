// Wire types for the dock 「调试」 inspector. Mirrors
// packages/server/src/routes/agent/debug-routes.ts — keep the JSON contract in sync.

export type TurnDebugStatus = 'running' | 'ok' | 'interrupted' | 'error'

export interface TurnDebugIdentity {
  id: string | null
  kind: 'base' | 'clone' | 'expert'
  name: string
  revision: number
  skills?: string[]
  memoryScope?: string
}

export interface TurnDebugEvent {
  off: number
  type: 'init' | 'llm' | 'tool' | 'res' | 'err' | 'sys'
  label: string
  det?: string
  sub?: string
}

export interface TurnDebugUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd?: number | null
  /** false when at least one matched ledger row has no price (show ≈). */
  costComplete?: boolean
  models?: Array<{
    model: string | null
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }>
}

export interface TurnDebugSummary {
  id: string
  turn_index: number
  status: TurnDebugStatus
  model: string | null
  effort: string | null
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  ttft_ms: number | null
  identity: TurnDebugIdentity
  role_revision: number
  has_switch: boolean
  usage: TurnDebugUsage | null
  error: string | null
  user_message_id: string | null
  assistant_message_id: string | null
}

export interface TurnDebugLlmCall {
  model: string | null
  stop_reason: string | null
  duration_ms: number
  ttft_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number | null
  timestamp: number
}

export interface TurnDebugContextUsage {
  categories?: { name: string; tokens: number; color: string; isDeferred?: boolean }[]
  totalTokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  percentage?: number
  model?: string
  memoryFiles?: { path: string; type: string; tokens: number }[]
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[]
  systemPromptSections?: { name: string; tokens: number }[]
  systemTools?: { name: string; tokens: number }[]
  agents?: { agentType: string; source: string; tokens: number }[]
  slashCommands?: { totalCommands: number; includedCommands: number; tokens: number }
}

export interface TurnDebugSystemInit {
  claudeCodeVersion?: string
  model?: string
  cwd?: string
  permissionMode?: string
  outputStyle?: string
  apiKeySource?: string
  effort?: string | null
  tools: string[]
  mcpServers: { name: string; status: string }[]
  agents: string[]
  skills: string[]
  plugins: { name: string; path: string; version?: string }[]
  slashCommands: string[]
  capabilities?: string[]
  betas?: string[]
}

export interface TurnDebugPrevious {
  turn_index: number
  identity: TurnDebugIdentity | null
  cwd: string | null
  model: string | null
  effort: string | null
  system_prompt_hash: string | null
  sdk_options: Record<string, unknown>
}

export interface TurnDebugDetail extends TurnDebugSummary {
  user_message: string | null
  provider_message: string | null
  system_prompt: string | null
  system_prompt_hash: string | null
  system_prompt_frozen: boolean
  role_card: string | null
  cwd: string | null
  sdk_options: Record<string, unknown>
  context_usage: TurnDebugContextUsage | null
  system_init: TurnDebugSystemInit | null
  events: TurnDebugEvent[]
  ledger_calls: TurnDebugLlmCall[]
  previous: TurnDebugPrevious | null
}

export interface TurnDebugListResponse {
  session_id: string
  total: number
  turns: TurnDebugSummary[]
}