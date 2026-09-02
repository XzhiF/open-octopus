-- =============================================================================
-- Octopus Unified Schema (schema.sql)
-- Complete database schema: 28 tables + 3 FTS5 virtual tables + 4 triggers
-- This file is idempotent — safe to execute on an empty database.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- =============================================================================
-- Core Tables (from main DB — schema.ts)
-- =============================================================================

-- 1. Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  source_schedule_id TEXT,
  archive_status TEXT DEFAULT NULL
);

-- 2. Executions
-- schema v40 (task-phase-redesign K4): + phase_index/round_index — v4 round
-- identity (1 execution = 1 round). NULL = v3/generic (non-phase execution).
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '0',
  child_index INTEGER DEFAULT 0,
  workflow_ref TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  gate_status TEXT DEFAULT 'closed',
  rollback TEXT DEFAULT 'none',
  rollback_on_error INTEGER DEFAULT 0,
  input_values TEXT DEFAULT '{}',
  var_pool TEXT DEFAULT '{}',
  progress INTEGER DEFAULT 0,
  triggered_by TEXT DEFAULT 'manual',
  node_type TEXT NOT NULL DEFAULT 'normal',
  branch TEXT,
  start_commit_id TEXT,
  end_commit_id TEXT,
  name TEXT,
  instance_id TEXT,
  global_session_id TEXT,
  retry_count INTEGER DEFAULT 0,
  pending_hooks TEXT DEFAULT '[]',
  approval_metadata TEXT,
  interaction_metadata TEXT,
  resume_attempts INTEGER DEFAULT 0,
  pipeline_config TEXT DEFAULT '{}',
  chain_retry_count INTEGER DEFAULT 0,
  preset_inputs TEXT DEFAULT NULL,
  harness_status TEXT DEFAULT NULL,
  harness_summary TEXT DEFAULT NULL,
  budget_snapshot TEXT DEFAULT NULL,
  phase_index INTEGER DEFAULT NULL,
  round_index INTEGER DEFAULT NULL,
  started_at TEXT,
  completed_at TEXT,
  duration INTEGER,
  org TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- 3. Node Executions
CREATE TABLE IF NOT EXISTS node_executions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  duration INTEGER,
  exit_code INTEGER,
  error TEXT,
  vars_snapshot TEXT,
  outputs TEXT,
  session_id TEXT,
  retry_count INTEGER DEFAULT 0,
  last_retry_at TEXT,
  parent_node_id TEXT,
  iteration_index INTEGER,
  harness_status TEXT,
  harness_interventions TEXT,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

-- 4. Node Edges
CREATE TABLE IF NOT EXISTS node_edges (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  label TEXT,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

-- 5. Branch Executions
CREATE TABLE IF NOT EXISTS branch_executions (
  id TEXT PRIMARY KEY,
  node_execution_id TEXT NOT NULL,
  iteration INTEGER,
  branch_label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  duration INTEGER,
  output TEXT,
  FOREIGN KEY (node_execution_id) REFERENCES node_executions(id)
);

-- 6. Chat Sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provider TEXT DEFAULT 'claude',
  provider_session_id TEXT
);

-- 7. Chat Messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL
);

-- 8. Orgs
CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 9. Node Token Usages
CREATE TABLE IF NOT EXISTS node_token_usages (
  id TEXT PRIMARY KEY,
  node_execution_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  source TEXT DEFAULT 'node',
  created_at TEXT NOT NULL,
  FOREIGN KEY (node_execution_id) REFERENCES node_executions(id)
);

-- 10. Agent Events
CREATE TABLE IF NOT EXISTS agent_events (
  node_execution_id TEXT NOT NULL,
  event_order       INTEGER NOT NULL,
  turn_index        INTEGER NOT NULL,
  event_type        TEXT NOT NULL,
  timestamp         INTEGER NOT NULL,
  content           TEXT,
  content_length    INTEGER DEFAULT 0,
  tool_call_id      TEXT,
  tool_name         TEXT,
  tool_input        TEXT,
  tool_result       TEXT,
  tool_is_error     INTEGER DEFAULT 0,
  tool_duration_ms  INTEGER,
  status_value      TEXT,
  error_code        TEXT,
  error_message     TEXT,
  PRIMARY KEY (node_execution_id, event_order)
);

-- 11. LLM Calls
CREATE TABLE IF NOT EXISTS llm_calls (
  id                    TEXT PRIMARY KEY,
  node_execution_id     TEXT NOT NULL,
  execution_id          TEXT NOT NULL,
  turn_index            INTEGER NOT NULL,
  call_index            INTEGER NOT NULL,
  message_id            TEXT,
  model                 TEXT,
  stop_reason           TEXT,
  timestamp             INTEGER NOT NULL,
  duration_ms           INTEGER NOT NULL,
  ttft_ms               INTEGER,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL,
  org                   TEXT,
  workspace_id          TEXT,
  workflow_ref          TEXT,
  node_id               TEXT,
  session_id            TEXT,
  instance_id           TEXT,
  FOREIGN KEY (node_execution_id) REFERENCES node_executions(id)
);

-- 12. Optimization Suggestions
CREATE TABLE IF NOT EXISTS optimization_suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  workflow_ref TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  node_id TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  detection TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  prescription TEXT NOT NULL,
  impact_estimate TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  applied_at TEXT,
  applied_changes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- 13. Execution Summaries
CREATE TABLE IF NOT EXISTS execution_summaries (
  id          TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  workflow_ref TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  failed_nodes TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

-- 14. Pipeline State
CREATE TABLE IF NOT EXISTS pipeline_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL UNIQUE,
  chain_status TEXT NOT NULL DEFAULT 'idle',
  config_hash TEXT,
  config_change_strategy TEXT NOT NULL DEFAULT 'snapshot',
  last_execution_id TEXT,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- 15. Schedules
-- schema v37: cron_expression nullable (drafts from trigger_source='requirement' had no cron)
--             + status / trigger_source / source_chat_session_id / claimed_at for task-pool
-- schema v38: ADDITIVE origin cols (origin_type/origin_id/origin_role/assoc_meta) for S2
--             polymorphic origin (no FK on origin_id — app-level cascade-reap + orphan
--             reaper maintain integrity). trigger_source/source_chat_session_id are KEPT
--             for now (coexist transiently) — their REMOVAL + migrating the 3 承重 sites
--             (scheduler-engine failed-promotion / checkQueuedTasks filter / task-dispatch
--             child creation) to origin_type is ticket 06's job, done together so the build
--             stays green through the removal. The first-class `tasks` table owns lifecycle/spec.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  cron_expression TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  workspace_id TEXT,
  workflow_ref TEXT,
  input_values TEXT DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_seconds INTEGER NOT NULL DEFAULT 3600,
  notify_on_failure INTEGER NOT NULL DEFAULT 0,
  notify_channel TEXT,
  notify_target TEXT,
  container_execution_id TEXT,
  missed_alert_dismissed_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_trigger_at TEXT,
  job_type TEXT NOT NULL DEFAULT 'workflow',
  config TEXT NOT NULL DEFAULT '{}',
  parallel_policy TEXT NOT NULL DEFAULT 'skip',
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  max_retain INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'queued',
  -- v2: trigger_source + source_chat_session_id REMOVED (SG1b) — schedules is now
  -- origin-typed (origin_type/origin_id/origin_role/assoc_meta); task linkage lives on
  -- tasks.source_chat_session_id. status + claimed_at KEPT (run-phase, runner needs).
  origin_type TEXT NOT NULL DEFAULT 'cron',
  origin_id TEXT,
  origin_role TEXT,
  assoc_meta TEXT,
  claimed_at TEXT,
  -- schema v39: one-shot due time for task-origin triggers (manual/time trigger).
  -- NULL = cron/legacy/claim-immediately. Distinct from next_trigger_at (cron cycle).
  scheduled_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

-- 16. Schedule Executions
CREATE TABLE IF NOT EXISTS schedule_executions (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  execution_id TEXT,
  status TEXT NOT NULL DEFAULT 'triggered',
  trigger_type TEXT NOT NULL DEFAULT 'scheduled',
  triggered_at TEXT NOT NULL,
  timezone_offset TEXT NOT NULL,
  timezone_iana TEXT NOT NULL,
  duration_ms INTEGER,
  skip_reason TEXT,
  missed_reason TEXT,
  retry_of TEXT,
  error_summary TEXT,
  exit_code INTEGER,
  agent_output TEXT,
  model_used TEXT,
  token_usage TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  triggered_by TEXT,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (schedule_id) REFERENCES schedules(id),
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

-- 17. Schedule Audit Logs (immutable)
CREATE TABLE IF NOT EXISTS schedule_audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL DEFAULT 'system',
  schedule_id TEXT,
  schedule_name TEXT,
  workspace_id TEXT NOT NULL,
  changes TEXT,
  created_at TEXT NOT NULL
);

-- 18. Scheduler State
CREATE TABLE IF NOT EXISTS scheduler_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  last_heartbeat TEXT,
  schema_version INTEGER NOT NULL DEFAULT 21,
  missed_alert_pending INTEGER NOT NULL DEFAULT 0
);

-- 19. Scheduler Audit Logs (immutable)
CREATE TABLE IF NOT EXISTS scheduler_audit_logs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  changes TEXT,
  ip_address TEXT,
  workspace_id TEXT,
  created_at TEXT NOT NULL
);

-- 20. Schedule Workspaces
CREATE TABLE IF NOT EXISTS schedule_workspaces (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  execution_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  branch_suffix TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

-- =============================================================================
-- Agent Tables (from agent_memory.db — agent-schema.ts + agent-migrations/)
-- =============================================================================

-- 21. Sessions
-- scope_id semantics (schema v38): retargeted to tasks.id (was schedules.id soft-link).
-- The writer is the autosave seam (clone/index.ts) + POST /api/tasks (SG3) — both set
-- scope_id = task.id after creating a draft task bound to this chat session. The
-- back-ref lives on tasks.source_chat_session_id.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '新会话',
  clone_name TEXT,
  perspective_clone_name TEXT,
  session_type TEXT NOT NULL DEFAULT 'main',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  scope_id TEXT,
  provider_session_id TEXT,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 21b. Tasks (schema v38 — first-class task domain; v2-D1)
-- Owns draft→ready→running→done/failed/aborted lifecycle + task_spec (WHAT) +
-- resource/skill bindings. S2 polymorphic origin: NO schedule_id / execution_id /
-- claimed_at here — the link to schedules is via
-- `schedules WHERE origin_type='task' AND origin_id=task.id` (no FK; integrity via
-- app-level cascade-reap + orphan reaper, SG12). task_spec is the structured WHAT
-- (D9); resources (workspace-scope → workflow.requires at dispatch, v2-D13/SG7) and
-- authoring_resources (draft-scope, prompt-injected into the task-author session,
-- v2-D8/D13) live as their own JSON columns for query/provisioning convenience.
-- Autosave (clone/index.ts) writes ONLY name+updated_at — never task_spec/resources
-- or version (SG8). status CHECK enforces the lifecycle states (claimed folded into
-- running, v2-D14); soft-deleted drafts/ready carry deleted_at, not a status value.
-- schema v40 (task-phase-redesign K3/K4): + awaiting_review / archiving (v4 gate
-- states); 'failed' KEPT in the CHECK for v3 legacy rows (K13 停用不物理删 — v4
-- derivation never writes it, existing rows must remain readable). + workspace_id
-- (K4): the task's bound workspace — NULL = never triggered; first trigger creates
-- + binds, later rounds reuse (票 05 dispatchPhaseRound).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','running','awaiting_review','archiving','done','failed','aborted')),
  source_chat_session_id TEXT,
  task_spec TEXT NOT NULL DEFAULT '{}',
  authoring_resources TEXT NOT NULL DEFAULT '[]',
  resources TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  project_ids TEXT NOT NULL DEFAULT '[]',
  workflow_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  workspace_id TEXT DEFAULT NULL,
  FOREIGN KEY (source_chat_session_id) REFERENCES sessions(id)
);

-- 21c. Task Phase Acceptances (schema v40 — task-phase-redesign K4)
-- The 验收 Gate ledger: one row per human decision on a phase round
-- (accepted | rejected + feedback). APPEND-ONLY — a round's decision is a
-- historical fact; corrections append a new row, never mutate. No FK on
-- task_id (S2 polymorphic-integrity convention: app-level cascade, same as
-- schedules.origin_id) so future tasks rebuilds can't strand the ledger.
-- UPDATE/DELETE blocked by triggers (mirrors the schedule_audit_logs precedent).
CREATE TABLE IF NOT EXISTS task_phase_acceptances (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  phase_index INTEGER NOT NULL,
  round_index INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
  feedback TEXT,
  decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_phase_acceptances_task_phase
  ON task_phase_acceptances(task_id, phase_index);

CREATE TRIGGER IF NOT EXISTS prevent_task_phase_acceptance_update
  BEFORE UPDATE ON task_phase_acceptances
  BEGIN SELECT RAISE(ABORT, 'task_phase_acceptances is append-only'); END;

CREATE TRIGGER IF NOT EXISTS prevent_task_phase_acceptance_delete
  BEFORE DELETE ON task_phase_acceptances
  BEGIN SELECT RAISE(ABORT, 'task_phase_acceptances is append-only'); END;

-- 22. Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  metadata TEXT,
  tool_calls TEXT,
  is_summary INTEGER NOT NULL DEFAULT 0,
  is_compressed INTEGER NOT NULL DEFAULT 0,
  is_edited INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 23. Clones
CREATE TABLE IF NOT EXISTS clones (
  name TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  persona TEXT NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',
  workspace_ref TEXT NOT NULL DEFAULT '{}',
  memory_scope TEXT NOT NULL DEFAULT '[]',
  last_active_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 24. Evolution Log
CREATE TABLE IF NOT EXISTS evolution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  change_type TEXT NOT NULL,
  level TEXT NOT NULL,
  summary TEXT NOT NULL,
  diff_path TEXT,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  org TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

-- 25. Experiences (v2 — schema version 35: +scope, scope_ref, pattern_tags, outcome, source_type, execution_id, node_id)
CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  content TEXT NOT NULL,
  source_session_id TEXT,
  org TEXT NOT NULL,
  created_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'agent',
  scope_ref TEXT DEFAULT NULL,
  pattern_tags TEXT DEFAULT '[]',
  outcome TEXT DEFAULT NULL,
  source_type TEXT NOT NULL DEFAULT 'session',
  execution_id TEXT DEFAULT NULL,
  node_id TEXT DEFAULT NULL
);

-- 26. Safety Events
CREATE TABLE IF NOT EXISTS safety_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  operation TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor TEXT NOT NULL,
  context TEXT,
  org TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

-- 27. Reports
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  date TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  org TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 28. Scheduled Job Executions (from agent migration 002)
CREATE TABLE IF NOT EXISTS scheduled_job_executions (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  report_path TEXT,
  report_summary TEXT,
  error_message TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'cron',
  org TEXT NOT NULL,
  metadata TEXT
);

-- =============================================================================
-- FTS5 Virtual Tables (from agent DB)
-- =============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS session_memory_fts USING fts5(
  session_id,
  summary,
  session_title,
  created_at,
  source
);

-- FTS5 v2: scope-aware columns (schema version 35)
-- Blue-green migration: old table is dropped and replaced by v2 in schema.ts migration.
-- External content mode (no content= param): manual sync via DAO.
CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  skill_name,
  content,
  scope,
  scope_ref,
  pattern_tags
);

CREATE VIRTUAL TABLE IF NOT EXISTS reports_fts USING fts5(
  task_name,
  content
);

-- =============================================================================
-- Indexes — Core Tables
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_executions_workspace ON executions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_executions_parent ON executions(parent_id);
CREATE INDEX IF NOT EXISTS idx_node_execs_execution ON node_executions(execution_id);
CREATE INDEX IF NOT EXISTS idx_node_edges_execution ON node_edges(execution_id);
CREATE INDEX IF NOT EXISTS idx_branch_execs_node ON branch_executions(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_node_token_usages_node ON node_token_usages(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_ntu_composite ON node_token_usages(node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd);
CREATE INDEX IF NOT EXISTS idx_agent_events_node ON agent_events(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_turn ON agent_events(node_execution_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_llm_calls_node ON llm_calls(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_execution ON llm_calls(execution_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_timestamp ON llm_calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_calls_workspace_workflow ON llm_calls(workspace_id, workflow_ref);
CREATE INDEX IF NOT EXISTS idx_suggestions_workspace ON optimization_suggestions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON optimization_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_summaries_workflow ON execution_summaries(workflow_ref, workspace_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON execution_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_state_status ON pipeline_state(chain_status);
CREATE INDEX IF NOT EXISTS idx_executions_chain_retry ON executions(chain_retry_count);

-- Schedules indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_org_name ON schedules(org, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled, deleted_at);
CREATE INDEX IF NOT EXISTS idx_schedules_next_trigger ON schedules(next_trigger_at) WHERE enabled = 1 AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedules_job_type ON schedules(job_type);
CREATE INDEX IF NOT EXISTS idx_schedules_enabled_type ON schedules(enabled, job_type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status) WHERE deleted_at IS NULL;
-- schema v38: additive origin lookup index (S2 polymorphic association).
-- findSchedulesByOrigin + cascade-reap + orphan reaper use (origin_type, origin_id).
CREATE INDEX IF NOT EXISTS idx_schedules_origin ON schedules(origin_type, origin_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_schedules_claimed ON schedules(claimed_at) WHERE claimed_at IS NOT NULL;
-- v39: due-time FIFO for queued task triggers
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(scheduled_at) WHERE deleted_at IS NULL AND status = 'queued';

-- Schedule executions indexes
CREATE INDEX IF NOT EXISTS idx_sched_execs_schedule ON schedule_executions(schedule_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_execs_status ON schedule_executions(status);
CREATE INDEX IF NOT EXISTS idx_sched_execs_execution ON schedule_executions(execution_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_execs_unique_active ON schedule_executions(schedule_id) WHERE status IN ('triggered', 'running');
CREATE INDEX IF NOT EXISTS idx_sched_execs_schedule_status ON schedule_executions(schedule_id, status) WHERE status IN ('triggered', 'running');

-- Schedule audit indexes
CREATE INDEX IF NOT EXISTS idx_sched_audit_ws ON schedule_audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_audit_schedule ON schedule_audit_logs(schedule_id, created_at DESC);

-- Scheduler audit indexes
CREATE INDEX IF NOT EXISTS idx_scheduler_audit_schedule ON scheduler_audit_logs(schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduler_audit_ws ON scheduler_audit_logs(workspace_id, created_at DESC);

-- Schedule workspaces indexes
CREATE INDEX IF NOT EXISTS idx_sched_ws_schedule ON schedule_workspaces(schedule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_ws_workspace ON schedule_workspaces(workspace_id);

-- =============================================================================
-- Indexes — Agent Tables
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(org);
CREATE INDEX IF NOT EXISTS idx_sessions_clone ON sessions(clone_name);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_sessions_last_message ON sessions(last_message_at DESC) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope_id) WHERE scope_id IS NOT NULL;

-- Tasks indexes (schema v38)
-- kanban listByStatus + listByOrg (active = deleted_at IS NULL)
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_org_status ON tasks(org, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org) WHERE deleted_at IS NULL;
-- autosave seam lookup (find the draft task bound to a chat session)
CREATE INDEX IF NOT EXISTS idx_tasks_source_chat_session ON tasks(source_chat_session_id) WHERE source_chat_session_id IS NOT NULL AND deleted_at IS NULL;
-- board recency sort
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_summary ON messages(is_summary) WHERE is_summary = 1;
CREATE INDEX IF NOT EXISTS idx_clones_org ON clones(org);
CREATE INDEX IF NOT EXISTS idx_clones_status ON clones(status);
CREATE INDEX IF NOT EXISTS idx_evolution_skill ON evolution_log(skill_name);
CREATE INDEX IF NOT EXISTS idx_evolution_org ON evolution_log(org);
CREATE INDEX IF NOT EXISTS idx_evolution_timestamp ON evolution_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_experiences_skill ON experiences(skill_name);
CREATE INDEX IF NOT EXISTS idx_experiences_org ON experiences(org);
-- Experiences v2 indexes (schema version 35)
CREATE INDEX IF NOT EXISTS idx_experiences_scope ON experiences(scope);
CREATE INDEX IF NOT EXISTS idx_experiences_scope_ref ON experiences(scope, scope_ref);
CREATE INDEX IF NOT EXISTS idx_experiences_source_type ON experiences(source_type);
CREATE INDEX IF NOT EXISTS idx_experiences_execution_id ON experiences(execution_id);
CREATE INDEX IF NOT EXISTS idx_experiences_org_scope_time ON experiences(org, scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_events_org ON safety_events(org);
CREATE INDEX IF NOT EXISTS idx_safety_events_type ON safety_events(type);
CREATE INDEX IF NOT EXISTS idx_safety_events_timestamp ON safety_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_reports_org ON reports(org);
CREATE INDEX IF NOT EXISTS idx_reports_task ON reports(task_name);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(date DESC);
CREATE INDEX IF NOT EXISTS idx_sje_org ON scheduled_job_executions(org);
CREATE INDEX IF NOT EXISTS idx_sje_job ON scheduled_job_executions(job_name);
CREATE INDEX IF NOT EXISTS idx_sje_started ON scheduled_job_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sje_status ON scheduled_job_executions(status);

-- =============================================================================
-- Interaction Messages (schema version 31)
-- =============================================================================

-- 29. Interaction Messages
CREATE TABLE IF NOT EXISTS interaction_messages (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  role TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (execution_id) REFERENCES executions(id)
);

CREATE INDEX IF NOT EXISTS idx_interaction_msgs_exec_node
  ON interaction_messages(execution_id, node_id, created_at ASC);

-- =============================================================================
-- Insight Marks (evolution pipeline — immediate marking + batch processing)
-- =============================================================================

CREATE TABLE IF NOT EXISTS insight_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  insight TEXT NOT NULL,
  session_id TEXT,
  org TEXT NOT NULL,
  marked_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_insight_marks_org ON insight_marks(org);
CREATE INDEX IF NOT EXISTS idx_insight_marks_processed ON insight_marks(processed);
CREATE INDEX IF NOT EXISTS idx_insight_marks_marked_at ON insight_marks(marked_at DESC);

-- =============================================================================
-- Agent Version Management (schema version 33)
-- =============================================================================

-- 30. Agent Versions
CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  version TEXT NOT NULL,
  major INTEGER NOT NULL,
  minor INTEGER NOT NULL,
  patch INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'stable',
  status TEXT NOT NULL DEFAULT 'draft',
  snapshot TEXT NOT NULL,
  changelog TEXT,
  published_at TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(agent_name, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_name_status
  ON agent_versions(agent_name, status);
CREATE INDEX IF NOT EXISTS idx_agent_versions_name_stage
  ON agent_versions(agent_name, stage, published_at DESC);

-- =============================================================================
-- Triggers
-- =============================================================================

-- Immutable audit logs: schedule_audit_logs
CREATE TRIGGER IF NOT EXISTS prevent_audit_update
  BEFORE UPDATE ON schedule_audit_logs
  BEGIN SELECT RAISE(ABORT, 'Audit logs are immutable'); END;

CREATE TRIGGER IF NOT EXISTS prevent_audit_delete
  BEFORE DELETE ON schedule_audit_logs
  BEGIN SELECT RAISE(ABORT, 'Audit logs are immutable'); END;

-- Immutable audit logs: scheduler_audit_logs
CREATE TRIGGER IF NOT EXISTS prevent_scheduler_audit_update
  BEFORE UPDATE ON scheduler_audit_logs
  BEGIN SELECT RAISE(ABORT, 'Audit logs are immutable'); END;

CREATE TRIGGER IF NOT EXISTS prevent_scheduler_audit_delete
  BEFORE DELETE ON scheduler_audit_logs
  BEGIN SELECT RAISE(ABORT, 'Audit logs are immutable'); END;

-- FTS sync triggers for messages
CREATE TRIGGER IF NOT EXISTS messages_after_insert
AFTER INSERT ON messages
WHEN NEW.is_summary = 1
BEGIN
  INSERT INTO session_memory_fts(rowid, session_id, summary, session_title, created_at, source)
  VALUES (NEW.rowid, NEW.session_id, NEW.content,
    (SELECT title FROM sessions WHERE id = NEW.session_id),
    NEW.created_at,
    COALESCE(NEW.source, 'main'));
END;

CREATE TRIGGER IF NOT EXISTS messages_after_delete
AFTER DELETE ON messages
WHEN OLD.is_summary = 1
BEGIN
  DELETE FROM session_memory_fts WHERE rowid = OLD.rowid;
END;

-- =============================================================================
-- Harness Tables (schema version 34)
-- =============================================================================

-- 31. Harness Events — records every detector diagnosis, strategy intervention,
--     agent delegation, and blocked event during workflow execution.
CREATE TABLE IF NOT EXISTS harness_events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id TEXT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detector TEXT,
  severity TEXT,
  report_json TEXT,
  action_json TEXT,
  result_json TEXT,
  token_usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_harness_events_exec ON harness_events(execution_id);
CREATE INDEX IF NOT EXISTS idx_harness_events_time ON harness_events(timestamp);

-- 32. Harness Config — per-workspace harness.yaml overrides.
--     Singleton row (id='default'); version bumped on each save.
CREATE TABLE IF NOT EXISTS harness_config (
  id TEXT PRIMARY KEY DEFAULT 'default',
  config_yaml TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1
);

-- =============================================================================
-- Seed Data
-- =============================================================================

-- Default org (idempotent via UNIQUE constraint on name)
INSERT OR IGNORE INTO orgs (name, path, created_at) VALUES ('xzf', '~/.octopus/orgs/xzf', datetime('now'));

-- Scheduler state singleton (idempotent via PRIMARY KEY)
INSERT INTO scheduler_state (id, schema_version, missed_alert_pending)
  VALUES (1, 21, 0) ON CONFLICT DO NOTHING;

-- =============================================================================
-- Knowledge System Tables
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_review (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'rule',
  source TEXT NOT NULL DEFAULT 'system',
  source_ref TEXT NOT NULL DEFAULT '',
  source_label TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  target_file TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'project',
  conflicts TEXT DEFAULT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  auto_approve INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT DEFAULT NULL,
  user_notes TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_effectiveness (
  rule_id TEXT PRIMARY KEY,
  injected_count INTEGER NOT NULL DEFAULT 0,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  not_helpful_count INTEGER NOT NULL DEFAULT 0,
  last_injected TEXT DEFAULT NULL,
  confidence REAL NOT NULL DEFAULT 0.5
);

CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_review(status);
CREATE INDEX IF NOT EXISTS idx_effectiveness_stale ON knowledge_effectiveness(injected_count, confidence, last_injected);

-- Knowledge subsystem: indexes added in schema version 25 to support
-- listBySource queries that previously did full-table scans.
-- Idempotent via IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS idx_pending_review_source ON pending_review(source);
CREATE INDEX IF NOT EXISTS idx_pending_review_type_status ON pending_review(type, status);

-- =============================================================================
-- Archive Tables (schema version 26)
-- =============================================================================

-- execution_archive: permanent storage for archived execution metrics
CREATE TABLE IF NOT EXISTS execution_archive (
  execution_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  org TEXT NOT NULL,
  workflow_name TEXT,
  total_cost REAL DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  node_count INTEGER DEFAULT 0,
  success_rate REAL DEFAULT 0,
  token_breakdown TEXT,
  model_breakdown TEXT,
  node_summary TEXT,
  chain_info TEXT,
  status TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_execution_archive_workspace ON execution_archive(workspace_id);
CREATE INDEX IF NOT EXISTS idx_execution_archive_org ON execution_archive(org);
CREATE INDEX IF NOT EXISTS idx_execution_archive_archived ON execution_archive(archived_at);
CREATE INDEX IF NOT EXISTS idx_execution_archive_workflow ON execution_archive(workflow_name);

-- workspace_archive: permanent storage for deleted workspace metadata snapshots
CREATE TABLE IF NOT EXISTS workspace_archive (
  workspace_id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT,
  execution_count INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  created_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT,
  extracted_experiences INTEGER DEFAULT 0,
  extracted_skills INTEGER DEFAULT 0,
  extracted_workflows INTEGER DEFAULT 0,
  extracted_agents INTEGER DEFAULT 0,
  analysis_report TEXT,
  file_deleted INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_workspace_archive_org ON workspace_archive(org);
CREATE INDEX IF NOT EXISTS idx_workspace_archive_archived ON workspace_archive(archived_at);

-- archive_drafts: cached analysis results to avoid repeated LLM calls
CREATE TABLE IF NOT EXISTS archive_drafts (
  workspace_id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  analysis_report TEXT NOT NULL,
  experiences TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  stats TEXT NOT NULL DEFAULT '{}',
  workflows TEXT NOT NULL DEFAULT '[]',
  token_stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
