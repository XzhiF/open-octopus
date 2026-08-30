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
  archive_status: string | null
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
  interaction_metadata: string | null
  resume_attempts: number
  pipeline_config: string
  chain_retry_count: number
  preset_inputs: string | null
  harness_status: string | null
  harness_summary: string | null
  budget_snapshot: string | null
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
  parent_node_id: string | null
  iteration_index: number | null
  harness_status: string | null
  harness_interventions: string | null
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
  cron_expression: string | null
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
  status: string
  /** v38b (ticket 06 / SG1b): trigger_source + source_chat_session_id were
   *  DROPPED from schedules. The承重 sites are migrated to origin_type (S2
   *  polymorphic origin). The shared `SchedulerJob` type still carries a
   *  `trigger_source` field (boundary: shared off-limits) — derived from
   *  origin_type by buildSchedulerJob/enrichJobRow, NOT read from this row. */
  /** v38 S2 polymorphic origin (no FK on origin_id). 'cron' default for legacy rows. */
  origin_type: string
  /** Parent id — for tasks: the tasks.id this schedule was dispatched from. */
  origin_id: string | null
  /** Role within the parent origin: 'primary' | 'coordinator' | 'subunit' | 'auxiliary'. */
  origin_role: string | null
  /** Arbitrary JSON for the origin association (e.g. parent_task_dispatch marker). */
  assoc_meta: string | null
  claimed_at: string | null
  /** v39 — one-shot due time (ISO) for task-origin triggers; NULL =
   *  cron/legacy/claim-immediately. Distinct from next_trigger_at (cron cycle). */
  scheduled_at: string | null
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

// ── Tasks Table (schema v38 — first-class task domain, v2-D1) ──────────

/** A first-class task row. S2 polymorphic origin: NO schedule_id / execution_id /
 *  claimed_at — the link to schedules is via
 *  `schedules WHERE origin_type='task' AND origin_id=task.id` (no FK; integrity
 *  via app-level cascade-reap + orphan reaper, SG12). task_spec/resources/
 *  authoring_resources/skills/project_ids are JSON TEXT; the autosave seam writes
 *  ONLY name+updated_at and never touches task_spec/resources/version (SG8). */
export interface TaskRow {
  id: string
  org: string
  name: string
  /** 'draft' | 'ready' | 'running' | 'done' | 'failed' | 'aborted' (CHECK-enforced). */
  status: string
  /** FK→sessions.id; back-ref for sessions.scope_id (SG3 retarget). */
  source_chat_session_id: string | null
  /** JSON TaskSpec — the structured WHAT (D9). */
  task_spec: string
  /** JSON ResourceRef[] — draft-scope, prompt-injected (v2-D8/D13). */
  authoring_resources: string
  /** JSON ResourceRef[] — workspace-scope → workflow.requires at dispatch (v2-D13/SG7). */
  resources: string
  /** JSON string[] — bound skill names. */
  skills: string
  /** JSON string[] — bound project ids. */
  project_ids: string
  workflow_ref: string | null
  /** Optimistic concurrency; bumped on task_spec/resources/authoring_resources writes. */
  version: number
  /** Soft-delete marker (discard draft/ready = soft delete, not a status). */
  deleted_at: string | null
  created_at: string
  updated_at: string
  /** Set when status reaches terminal done/failed/aborted. */
  completed_at: string | null
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
  scope_id: string | null
  provider_session_id: string | null
  last_message_at: string | null
  created_at: string
  updated_at: string
}

export interface MessageRow {
  id: string
  session_id: string
  role: string
  content: string
  type: string           // 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error'
  metadata: string | null  // JSON metadata
  tool_calls: string | null
  is_summary: number
  is_compressed: number
  is_edited: number
  source: string         // 'main' | clone-name (memory source for FTS)
  created_at: string
}

export interface CloneRow {
  name: string
  org: string
  type: string           // 'built-in' | 'user'
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

/**
 * ExperienceRowV2 — extends ExperienceRow with scope-aware columns (schema version 35).
 * All new columns have DEFAULT values for backward compatibility.
 */
export interface ExperienceRowV2 extends ExperienceRow {
  /** Scope dimension: 'agent' | 'workflow' | 'harness' | 'global' */
  scope: string
  /** Reference within scope: skill_name / workflow_ref / detector name */
  scope_ref: string | null
  /** JSON array of pattern tags, e.g. '["deterministic_error","bash","critical"]' */
  pattern_tags: string
  /** Outcome JSON: {label, success_rate, usage_count, last_applied} or null if pending */
  outcome: string | null
  /** Source type: 'session' | 'harness' | 'reflection' */
  source_type: string
  /** Execution ID for node-level association */
  execution_id: string | null
  /** Node ID for node-level association */
  node_id: string | null
}

export interface InsightMarkRow {
  id: number
  skill_name: string
  insight: string
  session_id: string | null
  org: string
  marked_at: string
  processed: number
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

// ── Interaction Messages ─────────────────────────────────────────────

export interface InteractionMessageRow {
  id: string
  execution_id: string
  node_id: string
  role: "user" | "assistant" | "system"
  type: "text" | "thinking" | "tool_call" | "ask_user_question"
  content: string
  metadata: string | null
  created_at: string
}

// ── Pagination ──────────────────────────────────────────────────────

export interface PaginatedResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

// ── Agent Version Tables ────────────────────────────────────────────

export interface AgentVersionRow {
  id: string
  agent_name: string
  version: string
  major: number
  minor: number
  patch: number
  stage: string            // 'alpha' | 'beta' | 'rc' | 'stable'
  status: string           // 'draft' | 'published' | 'archived'
  snapshot: string         // JSON: { persona: string, config: object, skills: string[] }
  changelog: string | null
  published_at: string | null
  published_by: string | null
  created_at: string
}

// ── Archive Tables ──────────────────────────────────────────────────

export interface ExecutionArchiveRow {
  execution_id: string
  workspace_id: string
  org: string
  workflow_name: string | null
  /** C3: ledger 三态 —— NULL = 归档时全部未定价（REAL DEFAULT 0 可空，存量 0 不回填） */
  total_cost: number | null
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
  total_cost: number | null
  total_duration_ms: number
  created_at: string | null
  archived_at: string
  metadata: string | null
  extracted_experiences: number
  extracted_skills: number
  extracted_workflows: number
  extracted_agents: number
  analysis_report: string | null
  file_deleted: number
}

export interface ArchiveStats {
  total_executions: number
  total_cost: number | null
  avg_duration_ms: number
  avg_cost_per_execution: number | null
  success_rate: number
  archived_workspaces: number
  archived_workspace_cost: number | null
}

export interface CostTrend {
  date: string
  cost: number | null
  execution_count: number
}

export interface WorkflowStat {
  workflow_name: string
  execution_count: number
  success_rate: number
  avg_duration_ms: number
  avg_cost: number | null
}

export interface LeaderboardEntry {
  workflow_name: string
  metric_value: number
  execution_count: number
}
