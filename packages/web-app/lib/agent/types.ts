// ===== Enums =====
export type SessionType = 'main' | 'delegate' | 'clone_direct'
export type CloneStatus = 'active' | 'idle' | 'executing'
export type MemoryLayer = 'long-term' | 'daily' | 'session'
export type EvolutionChangeType = 'minor' | 'major' | 'rollback' | 'revert_builtin'
export type SafetyEventType = 'dangerous_command' | 'boundary_violation' | 'safe_mode_toggle'
export type SafetyDecision = 'intercept' | 'confirm_accept' | 'confirm_reject'
export type ReportStatus = 'ok' | 'missing' | 'rebuilt'
export type SkillSource = 'local_evolved' | 'builtin' | 'prod'

// ===== Pagination =====
export interface PaginatedResponse<T> {
  items: T[]
  next_cursor?: string | null
  total: number
}

// ===== Health =====
export interface HealthStatus {
  status: 'ok' | 'degraded'
  db: boolean
  skills_loaded: number
  subsystems: Record<string, boolean>
  safe_mode: boolean
  version: string
}

// ===== Sessions =====
export interface AgentSession {
  id: string
  title: string
  org: string
  clone_name: string | null
  perspective_clone_name: string | null
  session_type: SessionType
  created_at: string
  updated_at: string
  last_message_at: string | null
  is_active: boolean
}

export interface ToolCallRecord {
  id: string
  name: string
  input: unknown
  status: 'pending' | 'success' | 'fail' | 'start' | 'running' | 'result' | string
  result?: unknown
  started_at?: number
  ended_at?: number
}

/** One entry of a turn's arrival-ordered process timeline (2026-08-19):
 *  thinking segment / agent text fragment / tool call, interleaved as they
 *  happened. Persisted by the clone chat route in the message metadata JSON
 *  (`timeline`) so the completed-message collapsible meta can render
 *  chronologically instead of grouping "all thinking" + "all tools". */
export interface MessageTimelineEntry {
  kind: 'thinking' | 'text' | 'tool'
  /** thinking / text content */
  text?: string
  /** tool call id — resolves against message.tool_calls */
  id?: string
}

export interface AgentMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_calls?: ToolCallRecord[]
  thinking?: string
  timeline?: MessageTimelineEntry[]
  created_at: string
  is_summary: boolean
  is_compressed: boolean
  is_edited: boolean
}

// ===== Memory =====
export interface MemoryContent {
  layer: MemoryLayer
  content: string
  clone_name?: string
  date?: string
  token_count: number
  last_modified?: string
}

export interface MemorySearchResult {
  session_id: string
  summary: string
  score: number
  session_title: string
  created_at: string
}

// ===== Clones =====
export interface CloneInfo {
  name: string
  display_name: string
  type: 'built-in' | 'user'
  persona: string
  skills: string[]
  memory_scope: 'shared' | 'isolated'
  status: 'active' | 'idle' | 'executing'
  created_at?: string
  last_active?: string
}

export interface CreateCloneRequest {
  name: string
  display_name: string
  memory_scope?: 'shared' | 'isolated'
}

export interface FileInfo {
  path: string
  name: string
  type: 'file' | 'directory'
  size: number
  modified: string
  readonly: boolean
}

// ===== Skills =====
export interface SkillInfo {
  name: string
  source: SkillSource
  token_count: number
  file_size: number
  last_modified: string | null
  has_local_backup: boolean
}

export interface EvolutionLogEntry {
  id: number
  skill_name: string
  change_type: EvolutionChangeType
  level: string
  summary: string
  diff_path: string | null
  timestamp: string
  rolled_back: boolean
}

export interface Experience {
  id: number
  skill_name: string
  content: string
  source_session_id: string | null
  created_at: string
}

// ===== Safety =====
export interface SafetyEvent {
  id: number
  type: SafetyEventType
  operation: string
  decision: SafetyDecision
  actor: string
  timestamp: string
  context: unknown
}

// ===== Config =====
export interface AgentConfig {
  model: string
  timeout: number
  max_clones: number
  notification: {
    platform: string
    target: string
    timezone: string
  }
  memory: {
    session_retention_days: number
    long_term_refine_trigger_days: number
    session_compress_threshold_messages: number
  }
  safe_mode: {
    enabled: boolean
    inactive_days_threshold: number
  }
  debug: {
    enabled: boolean
  }
  onboarding_completed: boolean
  default_org: string
}

export interface SafeModeStatus {
  enabled: boolean
  reason?: string
  triggered_at?: string
  inactive_days?: number
}

// ===== Tasks =====
export interface TaskInfo {
  id: string
  type: 'workflow' | 'scheduled'
  name: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  current_node?: string
  progress?: number
  elapsed_ms: number
  started_at: string
  workflow_name?: string
}

export interface ScheduledJob {
  id: string
  cron: string
  workflow_name: string
  notification_target: string
  status: 'active' | 'circuit_broken' | 'paused'
  last_run_at: string | null
  next_run_at: string | null
  consecutive_failures: number
}

export interface ReportInfo {
  id: string
  task_name: string
  date: string
  file_path: string
  status: ReportStatus
  created_at: string
}

// ===== Debug =====
export interface DebugSegment {
  index: number
  name: string
  token_count: number
  budget: number
  degraded: boolean
  content_preview: string
  content: string
}

export interface DebugLogEntry {
  id: string
  session_id: string
  chat_id: string
  timestamp: string
  system_prompt: string
  segments: DebugSegment[]
  skill_sources: Record<string, SkillSource>
  decisions: string[]
}

// ===== Context Usage (from Claude Agent SDK getContextUsage) =====
/** Context window usage breakdown — mirrored from @octopus/providers ContextUsageData. */
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

// ===== SSE Events =====
export type AgentSSEEvent =
  | { event: 'text_delta'; data: { content: string } }
  | { event: 'tool_call'; data: { id: string; name: string; input: unknown; status: 'pending' | 'success' | 'fail'; result?: unknown } }
  | { event: 'status'; data: { phase: string; message: string } }
  | { event: 'confirm'; data: { event_id: string; type: 'dangerous_command' | 'evolution_major'; operation: string; detail: string } }
  | { event: 'context_usage'; data: ContextUsageData }
  | { event: 'done'; data: { session_id: string; message_id: string; session_title?: string; token_usage?: { input: number; output: number }; model?: string } }
  | { event: 'error'; data: { code: string; message: string } }

// ===== Agent Versions =====
export type VersionStage = 'alpha' | 'beta' | 'rc' | 'stable'
export type AgentVersionStatus = 'draft' | 'published' | 'archived'

export interface AgentSnapshot {
  persona: string
  config: Record<string, unknown>
  skills: string[]
}

export interface AgentVersionInfo {
  id: string
  agent_name: string
  version: string
  major: number
  minor: number
  patch: number
  stage: VersionStage
  status: AgentVersionStatus
  snapshot: string  // JSON string of AgentSnapshot
  changelog?: string
  published_at?: string
  published_by?: string
  created_at: string
}

export interface VersionListResponse {
  versions: AgentVersionInfo[]
  total: number
}

export interface VersionDiffResponse {
  persona_diff: string
  config_diff: string
  skills_diff: string
}

export interface RollbackResponse {
  success: boolean
  previous_version: string
}

// ===== Error =====
export interface AgentErrorResponse {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
