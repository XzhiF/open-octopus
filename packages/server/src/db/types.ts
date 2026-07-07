// packages/server/src/db/types.ts
// Row type interfaces used by DAOs — mirrors schema.sql column definitions.

// ── Core Tables ─────────────────────────────────────────────────────

export interface WorkspaceRow {
  id: string
  name: string
  org: string
  description: string | null
  status: string
  path: string
  created_at: string
  updated_at: string
  source: string
  source_schedule_id: string | null
}

export interface ExecutionRow {
  id: string
  workspace_id: string
  parent_id: string
  child_index: number
  workflow_ref: string
  workflow_name: string
  status: string
  gate_status: string
  rollback: string
  rollback_on_error: number
  input_values: string
  var_pool: string
  progress: number
  triggered_by: string
  node_type: string
  branch: string | null
  start_commit_id: string | null
  end_commit_id: string | null
  name: string | null
  instance_id: string | null
  global_session_id: string | null
  retry_count: number
  pending_hooks: string
  approval_metadata: string | null
  resume_attempts: number
  pipeline_config: string
  chain_retry_count: number
  preset_inputs: string | null
  started_at: string | null
  completed_at: string | null
  duration: number | null
  org: string
  created_at: string
  updated_at: string
}

export interface NodeExecutionRow {
  id: string
  execution_id: string
  node_id: string
  node_type: string
  status: string
  started_at: string | null
  completed_at: string | null
  duration: number | null
  exit_code: number | null
  error: string | null
  vars_snapshot: string | null
  outputs: string | null
  session_id: string | null
  retry_count: number
  last_retry_at: string | null
}

export interface NodeEdgeRow {
  id: string
  execution_id: string
  from_node_id: string
  to_node_id: string
  edge_type: string
  label: string | null
}

export interface BranchExecutionRow {
  id: string
  node_execution_id: string
  iteration: number | null
  branch_label: string | null
  status: string
  started_at: string | null
  completed_at: string | null
  duration: number | null
  output: string | null
}

export interface AgentEventRow {
  node_execution_id: string
  event_order: number
  turn_index: number
  event_type: string
  timestamp: number
  content: string | null
  content_length: number
  tool_call_id: string | null
  tool_name: string | null
  tool_input: string | null
  tool_result: string | null
  tool_is_error: number
  tool_duration_ms: number | null
  status_value: string | null
  error_code: string | null
  error_message: string | null
}

export interface NodeTokenUsageRow {
  id: string
  node_execution_id: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd: number | null
  cache_read_tokens: number
  cache_creation_tokens: number
  created_at: string
}

export interface LlmCallRow {
  id: string
  node_execution_id: string
  execution_id: string
  turn_index: number
  call_index: number
  message_id: string | null
  model: string | null
  stop_reason: string | null
  timestamp: number
  duration_ms: number
  ttft_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number | null
  org: string | null
  workspace_id: string | null
  workflow_ref: string | null
  node_id: string | null
  session_id: string | null
  instance_id: string | null
}

export interface OptimizationSuggestionRow {
  id: string
  workspace_id: string
  workflow_ref: string
  rule_name: string
  node_id: string | null
  severity: string
  title: string
  detection: string
  diagnosis: string
  prescription: string
  impact_estimate: string | null
  status: string
  applied_at: string | null
  applied_changes: string | null
  created_at: string
}

export interface ExecutionSummaryRow {
  id: string
  execution_id: string
  workflow_ref: string
  workspace_id: string
  summary: string
  status: string
  duration_ms: number
  failed_nodes: string | null
  created_at: string
}

export interface PipelineStateRow {
  id: number
  workspace_id: string
  chain_status: string
  config_hash: string | null
  config_change_strategy: string
  last_execution_id: string | null
  started_at: string | null
  updated_at: string
}

// ── Chat Tables ─────────────────────────────────────────────────────

export interface ChatSessionRow {
  id: string
  workspace_id: string
  title: string | null
  is_active: number
  created_at: string
  updated_at: string
  provider: string
  provider_session_id: string | null
}

export interface ChatMessageRow {
  id: string
  session_id: string
  role: string
  type: string
  content: string
  metadata: string | null
  created_at: string
}

// ── Org Table ───────────────────────────────────────────────────────

export interface OrgRow {
  id: number
  name: string
  path: string
  created_at: string
}

// ── Schedule Tables ─────────────────────────────────────────────────

export interface ScheduleRow {
  id: string
  org: string
  name: string
  cron_expression: string
  timezone: string
  workspace_id: string | null
  workflow_ref: string | null
  input_values: string
  enabled: number
  timeout_seconds: number
  notify_on_failure: number
  notify_channel: string | null
  notify_target: string | null
  container_execution_id: string | null
  missed_alert_dismissed_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  next_trigger_at: string | null
  job_type: string
  config: string
  parallel_policy: string
  description: string | null
  version: number
  consecutive_failures: number
  max_retain: number
}

export interface ScheduleExecutionRow {
  id: string
  schedule_id: string
  execution_id: string | null
  status: string
  trigger_type: string
  triggered_at: string
  timezone_offset: string
  timezone_iana: string
  duration_ms: number | null
  skip_reason: string | null
  missed_reason: string | null
  retry_of: string | null
  error_summary: string | null
  exit_code: number | null
  agent_output: string | null
  model_used: string | null
  token_usage: string
  metadata: string
  triggered_by: string | null
  workspace_id: string | null
  created_at: string
  completed_at: string | null
}

export interface ScheduleAuditLogRow {
  id: string
  action: string
  actor_id: string | null
  actor_name: string
  schedule_id: string | null
  schedule_name: string | null
  workspace_id: string
  changes: string | null
  created_at: string
}

export interface SchedulerStateRow {
  id: number
  last_heartbeat: string | null
  schema_version: number
  missed_alert_pending: number
}

export interface SchedulerAuditLogRow {
  id: string
  schedule_id: string | null
  action: string
  actor: string
  changes: string | null
  ip_address: string | null
  workspace_id: string | null
  created_at: string
}

export interface ScheduleWorkspaceRow {
  id: string
  schedule_id: string
  workspace_id: string
  execution_id: string | null
  status: string
  branch_suffix: string
  started_at: string
  completed_at: string | null
  error: string | null
}

// ── Agent Tables ────────────────────────────────────────────────────

export interface SessionRow {
  id: string
  org: string
  title: string
  clone_name: string | null
  perspective_clone_name: string | null
  session_type: string
  is_active: number
  is_deleted: number
  last_message_at: string | null
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  tool_calls: string | null
  is_summary: number
  is_compressed: number
  is_edited: number
  created_at: string
}

export interface CloneRow {
  name: string
  org: string
  status: string
  persona: string
  skills: string
  workspace_ref: string
  memory_scope: string
  last_active_at: string | null
  created_at: string
  updated_at: string
}

export interface EvolutionLogRow {
  id: number
  skill_name: string
  change_type: string
  level: string
  summary: string
  diff_path: string | null
  rolled_back: number
  org: string
  timestamp: string
}

export interface ExperienceRow {
  id: number
  skill_name: string
  content: string
  source_session_id: string | null
  org: string
  created_at: string
}

export interface SafetyEventRow {
  id: number
  type: string
  operation: string
  decision: string
  actor: string
  context: string | null
  org: string
  timestamp: string
}

export interface ReportRow {
  id: string
  task_name: string
  date: string
  file_path: string
  status: string
  org: string
  created_at: string
}

export interface ScheduledJobExecutionRow {
  id: string
  job_name: string
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  report_path: string | null
  report_summary: string | null
  error_message: string | null
  trigger_type: string
  org: string
  metadata: string | null
}

// ── Pagination ──────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

// ── Archive Tables ──────────────────────────────────────────────────

export interface ExecutionArchiveRow {
  execution_id: string
  workspace_id: string
  org: string
  workflow_name: string | null
  total_cost: number
  total_duration_ms: number
  node_count: number
  success_rate: number
  token_breakdown: string | null
  model_breakdown: string | null
  node_summary: string | null
  chain_info: string | null
  status: string
  archived_at: string
  metadata: string | null
}

export interface WorkspaceArchiveRow {
  workspace_id: string
  org: string
  name: string
  description: string | null
  source: string | null
  execution_count: number
  total_cost: number
  total_duration_ms: number
  created_at: string | null
  archived_at: string
  metadata: string | null
}

export interface ArchiveStats {
  total_executions: number
  total_cost: number
  avg_duration_ms: number
  avg_cost_per_execution: number
  success_rate: number
  archived_workspaces: number
  archived_workspace_cost: number
}

export interface CostTrend {
  date: string
  cost: number
  execution_count: number
}

export interface WorkflowStat {
  workflow_name: string
  execution_count: number
  success_rate: number
  avg_duration_ms: number
  avg_cost: number
}

export interface LeaderboardEntry {
  workflow_name: string
  metric_value: number
  execution_count: number
}
