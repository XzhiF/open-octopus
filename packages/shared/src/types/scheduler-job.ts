import { z } from 'zod'
import { WorkflowRef } from '../resource/workflow-ref'

export type JobType = 'workflow' | 'agent'
export type ParallelPolicy = 'allow' | 'wait' | 'skip'
export type SchedulerExecutionStatus =
  | 'triggered'
  | 'running'
  | 'success'
  | 'failure'
  | 'timeout'
  | 'cancelled'
  | 'skipped'
  | 'missed'

/** What created this schedule. 'cron' = scheduled by cron_expression; 'requirement' = draft from chat/manual input awaiting claim. */
export type TriggerSource = 'cron' | 'requirement'

/** v2 (S2 polymorphic origin) — generalizes {@link TriggerSource}. What created
 *  a schedule, with no FK on origin_id (app-level cascade-reap + orphan reaper
 *  maintain integrity, the tradeoff for S2's uniform polymorphic association):
 *  'cron' = cron_expression-driven; 'task' = spawned by the tasks dispatch seam
 *  (origin_id = parent task id); 'agent' = spawned by an agent run; 'manual' =
 *  user-enqueued; 'api' = external API enqueue. Extensible. */
export const OriginTypeSchema = z.enum(["cron", "task", "agent", "manual", "api"])
export type OriginType = z.infer<typeof OriginTypeSchema>

/** Lifecycle status of a schedule (schema v37). draft → queued → claimed → running → done.
 *  'claimed' = taken by executor before dispatch confirms; 'running' = execution in flight;
 *  'done' = chain completed (requirement-type only; cron uses enabled/disabled).
 *  'failed' = chain failed (G2, terminal — checkStaleClaimed must NOT roll back to queued);
 *  'aborted' = user-triggered abort (G4, terminal — workspace cleaned). */
export type ScheduleStatus = 'draft' | 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'aborted'

// ── Project & Workspace Spec (for scheduler-created workspaces) ─────

export const projectSpecSchema = z.object({
  name: z.string().min(1).max(100),
  // Empty source_path means "resolve at dispatch time". Resolution is the server's
  // job, performed in initWorktreesFromSpec by reading ~/.octopus/orgs/{org}/repos/index.md.
  // `group` (below) locates the project within that index file. Neither field is
  // resolved inside the shared package — shared only carries the contract.
  source_path: z.string().default(""),
  // Repo-group key used by the server to locate this project in repos/index.md
  // when source_path is empty (G3/G8). Retained for ticket 08's server code.
  group: z.string().default(""),
})

export const workspaceSpecSchema = z.object({
  org: z.string().min(1).max(100),
  branch_prefix: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  projects: z.array(projectSpecSchema).min(1).max(20),
})

export const workflowChainItemSchema = z.object({
  workflow_ref: WorkflowRef.zodSchema(),
  input_values: z.record(z.string(), z.string()).default({}),
})

// ── Task resource refs (v2-D3/D13) ──────────────────────────────────

/** The 4 provisionable resource types a task may bind. Mirrors
 *  `ProvisionableType` (resource-provisioner.ts); excludes 'clone' (manual
 *  install only) and 'workflow' (referenced via workflow_ref, not a bound
 *  resource). Each member maps 1:1 to a {@link workflowConfigRequiresSchema}
 *  key: skill→skills, agent→agent_files, command→commands, rule→rules. */
export const taskResourceTypeSchema = z.enum(["skill", "agent", "command", "rule"])
export type TaskResourceType = z.infer<typeof taskResourceTypeSchema>

/** A bound resource reference. `type` selects the requires bucket the resource
 *  materializes into; `name` is the resource name in the global registry (may
 *  be group-qualified, e.g. "built-in/octo-backend"). */
export const resourceRefSchema = z.object({
  type: taskResourceTypeSchema,
  name: z.string().min(1).max(200),
})
export type ResourceRef = z.infer<typeof resourceRefSchema>

// ── Task pool v3.0 types (composite dispatch: spec = WHAT, workflow_ref = HOW) ──

/** How subunit outputs are combined at the end of a composition workflow (D14).
 *  'synthesis' (default) = moa-style aggregation; 'merge' = opt-in structural merge. */
export const integrationGoalSchema = z.object({
  strategy: z.enum(["synthesis", "merge"]).default("synthesis"),
  prompt: z.string().optional(),
})

/** One declarative subunit of a composite task (D5). Each materializes as its own
 *  workspace + child schedule at dispatch time (createFromSpec). */
export const subunitSpecSchema = z.object({
  name: z.string().min(1).max(100),
  workspace_spec: workspaceSpecSchema,
  workflow_ref: WorkflowRef.zodSchema(),
  input_values: z.record(z.string(), z.string()).default({}),
  skills: z.array(z.string()).default([]),
  // v2-D13/SG7: workspace-scope resources → child workflow.requires at dispatch.
  resources: z.array(resourceRefSchema).default([]),
})

/** Structured task body produced by the task-author chatbot (D9). Stored as
 *  schedules.config.task_spec (v3.0). `subunits` present ⇒ composite task.
 *
 *  Task-authoring v3 (ADR-0010/0011/0012, SW-BP2) adds authoring-side fields:
 *  `task_type` (coding|generic) + `skill_groups[]` (selected at creation then
 *  LOCKED — PUT must not drop them), `decisions[]` (decision memos adopted from
 *  MoA output, SW-BP3), and confirmation gates `goal_confirmed` /
 *  `ac_confirmed[]` (D18, persisted through spec-field so drafts survive modal
 *  close). All five are part of the schema so zod does not strip them on a PUT
 *  round-trip (SW-BP2 — unknown keys would be silently dropped). */
export const taskSpecSchema = z.object({
  goal: z.string().min(1),
  ac: z.array(z.string().min(1)).min(1),
  // Permissive authoring artifacts — typed but not over-constrained here.
  data_model: z.record(z.string(), z.unknown()).optional(),
  contracts: z.record(z.string(), z.unknown()).optional(),
  subunits: z.array(subunitSpecSchema).optional(),
  integration_goal: integrationGoalSchema.optional(),
  // v2-D13/SG7: workspace-scope resources → workflow.requires at dispatch.
  resources: z.array(resourceRefSchema).default([]),
  // v2-D8/D13: draft-scope resources prompt-injected into the task-author session.
  authoring_resources: z.array(resourceRefSchema).default([]),
  // ── task-authoring v3 (ticket 01) ──
  // Template selected on the template page (D13). Optional: legacy/v2 tasks
  // predate the two-phase flow and omit it; treated as "generic" downstream.
  task_type: z.enum(["coding", "generic"]).optional(),
  // Skill groups chosen at creation (D2/D3); locked post-create (ADR-0012).
  // Default [] so v2 tasks parse cleanly. NOT written into authoring_resources
  // (D4 — that would trigger the augmenter's full-text injection, double-loading
  // skills already exposed via the per-task plugin dir, D1).
  skill_groups: z.array(z.string()).default([]),
  // Decision memos adopted from MoA expert output (D10/SW-BP3). A bindable
  // spec-field (see TaskSpecFieldSchema "decisions") so adoption persists here.
  decisions: z.array(z.string()).default([]),
  // Confirmation gates (D18): persisted via spec-field so a draft's confirmed
  // state survives modal close; readyTask enforces both before enqueue.
  goal_confirmed: z.boolean().optional(),
  ac_confirmed: z.array(z.string()).default([]),
  // task-workflow-presets (T1): input_values for workflow binding. Keys/values
  // are non-empty strings; values may contain ${goal}/${ac} placeholders resolved
  // at materialization time. Single value ≤ 2048 chars. Optional for backward
  // compat with tasks created before this field existed.
  input_values: z.record(
    z.string().min(1),
    z.string().min(1).max(2048),
  ).optional(),
})

// ── Zod schemas (single source of truth) ────────────────────────────

export const agentRetryPolicySchema = z.object({
  max_attempts: z.number().int().min(0).max(5).default(0),
  backoff_type: z.enum(['fixed', 'exponential']).default('exponential'),
  base_delay_ms: z.number().int().min(0).default(1000),
  max_delay_ms: z.number().int().min(0).default(60000),
  jitter: z.boolean().default(true),
})

/** @deprecated v1.0 — kept for backward compatibility with existing data */
export const workflowConfigSchemaV1 = z.object({
  schema_version: z.literal('1.0'),
  type: z.literal('workflow'),
  workflow_ref: WorkflowRef.zodSchema(),
  input_values: z.record(z.string(), z.string()).optional(),
})

/** Shape of {@link workflowConfigSchema}.requires — mirrors `WorkflowDef.requires`
 *  (workflow.ts). 4 keys; 'clones' is omitted because tasks do not provision
 *  clones via config (clones are manual-install per ResourceProvisioner).
 *  {@link materializeTaskSpecToConfig} propagates tasks.resources[] /
 *  subunit.resources[] → here; EngineInitPhase UNION-merges config.requires →
 *  workflow.requires (does NOT override, SG7). */
export const workflowConfigRequiresSchema = z.object({
  skills: z.array(z.string()).optional(),
  agent_files: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  rules: z.array(z.string()).optional(),
})

/** v2.0/v3.0 — workspace spec + workflow chain + retention.
 *  v3.0 adds optional `task_spec` (composite task body, D9). v2.0 configs (no
 *  task_spec) remain valid for backward compatibility — versioned TEXT, no migration.
 *  schema_version is a union so existing v2.0 fallbacks (scheduler-engine/service)
 *  stay type-safe: '2.0' is still assignable to WorkflowConfig.schema_version. */
export const workflowConfigSchema = z.object({
  schema_version: z.enum(["2.0", "3.0"]),
  type: z.literal("workflow"),
  workspace_spec: workspaceSpecSchema,
  workflow_chain: z.array(workflowChainItemSchema).min(1).max(20),
  max_retain: z.number().int().min(1).max(100).default(10),
  task_spec: taskSpecSchema.optional(),
  // v2-D13/SG7: optional, mirrors WorkflowDef.requires.
  requires: workflowConfigRequiresSchema.optional(),
})

export const agentConfigSchema = z.object({
  schema_version: z.literal('1.0'),
  type: z.literal('agent'),
  prompt: z.string().min(1).max(10000),
  model: z.string().optional().default('default'),
  timeout_seconds: z.number().int().min(10).max(3600).optional().default(300),
  retry_policy: agentRetryPolicySchema.optional(),
})

export const jobConfigSchema = z.discriminatedUnion('type', [
  workflowConfigSchema,
  agentConfigSchema,
])

/** Accepts both v1.0 (legacy) and v2.0 workflow configs */
export const legacyJobConfigSchema = z.union([
  workflowConfigSchemaV1,
  workflowConfigSchema,
  agentConfigSchema,
])

export const configSchemasByJobType = {
  workflow: workflowConfigSchema,
  agent: agentConfigSchema,
} as const

// ── TS types (derived from zod) ─────────────────────────────────────

export type AgentRetryPolicy = z.infer<typeof agentRetryPolicySchema>
export type ProjectSpec = z.infer<typeof projectSpecSchema>
export type WorkspaceSpec = z.infer<typeof workspaceSpecSchema>
export type WorkflowChainItem = z.infer<typeof workflowChainItemSchema>
export type IntegrationGoal = z.infer<typeof integrationGoalSchema>
export type SubunitSpec = z.infer<typeof subunitSpecSchema>
export type TaskSpec = z.infer<typeof taskSpecSchema>
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>
export type WorkflowConfigV1 = z.infer<typeof workflowConfigSchemaV1>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type JobConfig = z.infer<typeof jobConfigSchema>
export type LegacyJobConfig = z.infer<typeof legacyJobConfigSchema>

export interface SchedulerExecutionSummary {
  status: SchedulerExecutionStatus
  triggered_at: string
  error_summary: string | null
}

export interface SchedulerJob {
  id: string
  name: string
  job_type: JobType
  cron_expression: string | null
  timezone: string
  enabled: boolean
  org?: string
  config: JobConfig
  parallel_policy: ParallelPolicy
  timeout_seconds: number
  notify_on_failure: boolean
  description?: string
  max_retain?: number
  version: number
  consecutive_failures: number
  next_trigger_at: string | null
  last_execution?: SchedulerExecutionSummary | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  status: ScheduleStatus
  trigger_source: TriggerSource
  /** v38b polymorphic origin (S2). Authoritative source discriminator —
   *  trigger_source is a lossy legacy mapping (task/manual/api/agent all
   *  collapse to 'requirement'). Scheduler UI shows origin via this field:
   *  'cron' = cron-driven recurring job; 'task' = dispatched by the task
   *  board ready-gate (origin_id = parent task id, UI deep-links /tasks/:id);
   *  'agent'/'manual'/'api' = other one-shot enqueues. Null for legacy rows. */
  origin_type?: OriginType | null
  origin_id?: string | null
  source_chat_session_id: string | null
  claimed_at: string | null
}

export interface CreateJobInput {
  name: string
  job_type: JobType
  cron_expression: string | null
  timezone: string
  org?: string
  config: JobConfig
  parallel_policy?: ParallelPolicy
  timeout_seconds?: number
  notify_on_failure?: boolean
  description?: string
  trigger_source?: TriggerSource
  source_chat_session_id?: string | null
}

export interface UpdateJobInput {
  name?: string
  cron_expression?: string | null
  timezone?: string
  config?: JobConfig
  parallel_policy?: ParallelPolicy
  timeout_seconds?: number
  notify_on_failure?: boolean
  description?: string
}

export interface ListJobsParams {
  page?: number
  limit?: number
  search?: string
  status?: 'enabled' | 'disabled' | 'failed'
  job_type?: JobType
  org?: string
  sort?: 'next_trigger_at' | 'name' | 'created_at'
  order?: 'asc' | 'desc'
  /** Legacy route filter ('cron'→origin_type='cron'; 'requirement'→IN
   *  ('task','manual','api')). Omit → no origin filter (list spans all origins). */
  trigger_source?: TriggerSource
  /** Precise single-origin filter (takes precedence when both given). */
  origin?: OriginType
}
