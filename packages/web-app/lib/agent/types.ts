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

export interface AgentMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_calls?: ToolCallRecord[]
  thinking?: string
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
export interface CloneWorkspaceRef {
  workspace_name: string
  workspace_path: string
  branch: string
  projects: string[]
}

export interface CloneInfo {
  name: string
  status: CloneStatus
  workspace_ref: CloneWorkspaceRef
  persona_summary: string
  last_active_at: string
  created_at: string
  workspace_exists: boolean
}

export interface CreateCloneRequest {
  name: string
  persona: string
  skills: string[]
  workspace_config: {
    name?: string
    projects: string[]
    branch?: string
  }
  memory_scope: string[]
}

// ===== Skills =====
export interface SkillInfo {
  name: string
  source: SkillSource
  token_count: number
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
    provider: string
    target: string
    timezone: string
  }
  memory: {
    session_retention_days: number
    archive_cron_hour: number
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

// ===== SSE Events =====
export type AgentSSEEvent =
  | { event: 'text_delta'; data: { content: string } }
  | { event: 'tool_call'; data: { id: string; name: string; input: unknown; status: 'pending' | 'success' | 'fail'; result?: unknown } }
  | { event: 'status'; data: { phase: string; message: string } }
  | { event: 'confirm'; data: { event_id: string; type: 'dangerous_command' | 'evolution_major'; operation: string; detail: string } }
  | { event: 'done'; data: { session_id: string; message_id: string; session_title?: string; token_usage?: { input: number; output: number } } }
  | { event: 'error'; data: { code: string; message: string } }

// ===== Error =====
export interface AgentErrorResponse {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
