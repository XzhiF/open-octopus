import { z } from 'zod'

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

// ── Project & Workspace Spec (for scheduler-created workspaces) ─────

export const projectSpecSchema = z.object({
  name: z.string().min(1).max(100),
  // ponytail: empty source_path resolved server-side from repos/index.md
  source_path: z.string().default(""),
  group: z.string().default(""),
})

export const workspaceSpecSchema = z.object({
  org: z.string().min(1).max(100),
  branch_prefix: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  projects: z.array(projectSpecSchema).min(1).max(20),
})

export const workflowChainItemSchema = z.object({
  workflow_ref: z.string().min(1).regex(/^[a-zA-Z0-9_\-./]+\.ya?ml$/),
  input_values: z.record(z.string(), z.string()).default({}),
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
  workflow_ref: z.string().min(1).regex(/^[a-zA-Z0-9_\-./]+\.ya?ml$/),
  input_values: z.record(z.string(), z.string()).optional(),
})

/** v2.0 — workspace spec + workflow chain + retention */
export const workflowConfigSchema = z.object({
  schema_version: z.literal('2.0'),
  type: z.literal('workflow'),
  workspace_spec: workspaceSpecSchema,
  workflow_chain: z.array(workflowChainItemSchema).min(1).max(20),
  max_retain: z.number().int().min(1).max(100).default(10),
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
  cron_expression: string
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
}

export interface CreateJobInput {
  name: string
  job_type: JobType
  cron_expression: string
  timezone: string
  org?: string
  config: JobConfig
  parallel_policy?: ParallelPolicy
  timeout_seconds?: number
  notify_on_failure?: boolean
  description?: string
}

export interface UpdateJobInput {
  name?: string
  cron_expression?: string
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
}
