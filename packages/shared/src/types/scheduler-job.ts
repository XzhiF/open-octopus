import { z } from 'zod'
import { WorkflowRef } from '../resource/workflow-ref'

/**
 * What a scheduled job runs. THE list, as a zod schema rather than a bare union, so the
 * API's input validation (`createJobSchema`), the list route's `?job_type=` parsing and
 * every typed consumer read one vocabulary instead of three hand-written copies — a
 * local `['workflow','agent']` in createJobSchema is exactly what kept the `job` type
 * (票02) unreachable through the API after the union was widened.
 *   workflow — a YAML workflow chain inside a workspace (WorkflowExecutor)
 *   agent    — one LLM prompt (AgentExecutor)
 *   job      — a registered TypeScript handler (ADR-0021): the system's own
 *              housekeeping, armed by cron like any other job and visible in the same
 *              ops surface. The built-in `task-lifecycle` job is one of these.
 */
export const jobTypeSchema = z.enum(['workflow', 'agent', 'job'])
export type JobType = z.infer<typeof jobTypeSchema>
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

/**
 * What created a schedule — **gone**. The `origin_*` columns were dropped in schema v42
 * and the last consumer (the `origin_type: 'task'` discriminator on the taskpool SSE
 * payloads) was removed in 票05, so the vocabulary has no referent left: a `schedules`
 * row is a job, and a task's run is an `executions` row. `schedule_executions.trigger_type`
 * ('scheduled' | 'manual') is a different, still-live concept — how a JOB FIRE happened.
 */

/** Lifecycle status of a job DEFINITION's run state (schema v37, narrowed by v42).
 *  'queued' = registered, nothing in flight; 'claimed' = taken by the executor before
 *  dispatch confirms; 'running' = execution in flight; 'done'/'failed' = last fire's
 *  outcome; 'aborted' = user abort (terminal — the stale sweep must not roll it back).
 *  'draft' is gone: it was the parked state of a task envelope, and tasks no longer have
 *  schedule rows. */
export type ScheduleStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'aborted'

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

/** Path-safe slug 的单一规则 —— task 级主 slug（{@link taskSpecSchema}.slug，
 *  批次父目录名）与 phase 级 sub-slug（{@link taskPhaseSchema}.slug，批次子目录
 *  名）共用：字母/数字开头，其后字母/数字/._-。批次目录 =
 *  `.scratch/<main-slug>/<sub-slug>/`（2026-09-20 契约改版，替代旧日期层
 *  `.scratch/<YYYYMMDD>/<slug>/`；旧布局存量任务不迁移 —— gate/batchTree 按
 *  home 相对路径解存在性，布局无关）。 */
export const pathSafeSlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
    message: "Invalid slug: path-safe only (letters/digits start, then letters/digits/dots/hyphens/underscores)",
  })

/** task-phase-redesign (K1/K4, ticket 01) — one Phase of a v4 task.
 *  1 phase = 1 spec (scope + tickets + acceptance method, pointed to by
 *  `specPath` at the task home) + 1 workflow binding (`workflowRef` +
 *  `inputValues`) + ≥1 round. Phase↔slug is 1:1; `slug` names the batch
 *  SUB-dir — `.scratch/<task.slug>/<slug>/` (K10), so it is path-safe by
 *  regex. Convention since 2026-09-20: short kebab sub-name (e.g. `auth-flow`,
 *  `2`) — the main name already lives in the parent dir. Pre-contract tasks
 *  keep their `<main>-<i>` full-name slugs untouched (slug 字段语义放宽为约定,
 *  不是校验差集)。
 *  `index` is 1-based (ticket 07 derivation: accepted ∧ i<n → next round is
 *  i+1; accepted ∧ i=n → archiving). `inputValues` values may carry the v4
 *  placeholder vocabulary (`${phase.slug}`, `${phase.spec_dir}`,
 *  `${task.home}`, `${task_artifacts_dir}`) resolved at materialization
 *  (ticket 04) — same length cap as the task-level `input_values`. */
export const taskPhaseSchema = z.object({
  index: z.number().int().min(1),
  name: z.string().min(1).max(100),
  slug: pathSafeSlugSchema,
  specPath: z.string().min(1),
  workflowRef: WorkflowRef.zodSchema(),
  inputValues: z.record(z.string().min(1), z.string().min(1).max(2048)).default({}),
})

/** 验收面 v2「验货台」— the task's on-demand re-verification command
 *  (`acceptance_verify`). Acceptance is the moment to VERIFY goods, not read
 *  reports; this field persists what the platform runs live in the task's
 *  workspace when the reviewer hits ▶复检. Trust class = workflow bash nodes
 *  (user-authored, never auto-run — explicit button only). `cwd` is
 *  workspace-relative (no escape; default = workspace root); `timeoutS`
 *  defaults to 600 server-side, hard-capped at 1800. Edge: the bash runner
 *  substitutes literal `$vars.` / `${x|filter}` sequences — avoid them in
 *  commands. A spec-field (whitelisted) so it is bindable/patchable at
 *  awaiting_review time (v4 spec stays editable until done/aborted/archiving). */
export const acceptanceVerifySchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().max(500).optional(),
  // 双靶/跨仓任务（多 worktree 在 projects/ 下）：per_repo=true 时，server 对
  // projects/*/ 每个 git 仓各跑一次 command（仓根为 cwd，聚合退出码：任一仓失败
  // 即整体 failed）。此时 command 应写成「仓内相对」（如 `mvn -B test`），不带
  // cd 前缀；cwd 字段被忽略。timeoutS 视为多仓总预算。
  per_repo: z.boolean().optional(),
  timeoutS: z.number().int().min(5).max(1800).optional(),
})
export type AcceptanceVerify = z.infer<typeof acceptanceVerifySchema>
/** 验收面 v2.1「跑起来看」— the task's live-preview service (ADR-0022).
 *  Same trust class as {@link acceptanceVerifySchema}: user-authored,
 *  user-triggered, NEVER auto-run. Runs as a long-lived BashExecutor process
 *  in the task workspace; readiness = HTTP probe of `url` (any response =
 *  port up) optionally AND-matched against stdout `readyPattern`. No iframe —
 *  the panel only starts/stops and links out. Hard cap 2h (server-side),
 *  auto-stopped by every acceptance decision (recorded in the ledger). */
export const acceptancePreviewSchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().max(500).optional(),
  url: z.string().min(1).max(200).regex(/^https?:\/\//i, { message: "url must be http(s)" }),
  readyPattern: z.string().max(500).optional(),
})
export type AcceptancePreview = z.infer<typeof acceptancePreviewSchema>
/** 验收台「跑起来看」通用运行手册（runbook）—— 把「起服务→等就绪→给入口→收尾」
 *  抽象成 4 个工具无关的槽，一套覆盖单服务 / docker-compose / N×java -jar / 脚本 /
 *  远端 Jenkins 部署。平台不认具体工具，只：跑 `up`（可前台长驻、可快速退出=detached）、
 *  轮询跑 `ready`（**退出码 0 = 就绪**，这是唯一就绪判据）、暴露 `views[]` 入口、
 *  收尾跑 `down`（可缺省 → 停止只结束会话，用于远端部署不可/不该本地杀的情况）。
 *  工具差异全塞进 command 数据或项目自带脚本，schema 不随新工具增长。
 *  与 {@link acceptancePreviewSchema} 并存：后者是单服务简写，server 会把它合成为
 *  一份 runbook（up=command，ready=`curl` 探 url 看退出码，views=[url]），故旧任务
 *  与 web 面板零改动继续跑；runbook 是给多服务/远端部署的正道形态。 */
export const runbookStepSchema = z.object({
  command: z.string().min(1).max(4000),
  cwd: z.string().max(500).optional(),
})
export const runbookViewSchema = z.object({
  label: z.string().max(120).optional(),
  url: z.string().min(1).max(200).regex(/^https?:\/\//i, { message: "url must be http(s)" }),
})
export const acceptanceRunbookSchema = z.object({
  up: runbookStepSchema,
  ready: runbookStepSchema,
  views: z.array(runbookViewSchema).max(20).optional(),
  down: runbookStepSchema.optional(),
  /** ready 轮询总预算（秒）；缺省用 server 端默认。 */
  timeoutS: z.number().int().min(5).max(1800).optional(),
})
export type RunbookStep = z.infer<typeof runbookStepSchema>
export type RunbookView = z.infer<typeof runbookViewSchema>
export type AcceptanceRunbook = z.infer<typeof acceptanceRunbookSchema>
export type TaskPhase = z.infer<typeof taskPhaseSchema>

/** Structured task body produced by the task-author chatbot (D9). Stored as
 *  schedules.config.task_spec (v3.0). `subunits` present ⇒ composite task.
 *
 *  Task-authoring v3 (ADR-0010/0011/0012, SW-BP2) adds authoring-side fields:
 *  `task_type` (coding|generic) + `skill_groups[]` (selected at creation then
 *  LOCKED — PUT must not drop them), `decisions[]` (decision memos adopted from
 *  MoA output, SW-BP3), and confirmation gates `goal_confirmed` /
 *  `ac_confirmed[]` (D18, persisted through spec-field so drafts survive modal
 *  close). All five are part of the schema so zod does not strip them on a PUT
 *  round-trip (SW-BP2 — unknown keys would be silently dropped).
 *
 *  task-phase-redesign v4 (ticket 01, K4/K13): adds `format` ("v4" flag — the
 *  ONLY discriminator; absent = v3/legacy, read-time derived single phase),
 *  `phases[]` ({@link taskPhaseSchema}) and `autoAdvance` (K6 — schema keeps it
 *  `boolean?`, the default-on derivation `!== false` is the server gate's lane,
 *  not a zod default so v3 JSON round-trips stay byte-identical).
 *  `goal`/`ac` become OPTIONAL (`.optional()`, min constraints preserved when
 *  present) so a v4 payload without them parses; v3/generic enforcement moves
 *  to the format-branched ready gate (ticket 04), which still requires both
 *  for non-v4 specs. */
export const taskSpecSchema = z.object({
  goal: z.string().min(1).optional(),
  ac: z.array(z.string().min(1)).min(1).optional(),
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
  // ── task-phase-redesign v4 (ticket 01, K4/K13) ──
  // Sole v4 discriminator. Absent ⇒ v3/legacy (generic/composite keep the old
  // chain: goal/ac double-confirm gate). Only "v4" is defined today.
  format: z.literal("v4").optional(),
  // 批次主 slug (2026-09-20 契约改版) — task 级唯一命名锚，Batch 目录的父层：
  // specPath 约定 `./.scratch/<slug>/<phase.slug>/spec.md`（旧约定为日期层
  // `<YYYYMMDD>`，已废 —— 新草稿一律主 slug；存量任务无此字段照旧运行）。
  // 拆分定一次、全 phase 共用；也用作自动 workspace 名的第一优先来源
  // (task-ws-name.ts)。Optional — not locked (draft 期可改，ready 后随结构冻结)。
  slug: pathSafeSlugSchema.optional(),
  // 执行分支名（author 定名，2026-09-22）—— 任务工作区 git 分支前缀的显式来源。
  // 缺省时 server 以 `feat-<slug|标题锚>-<YYYYMMDD>` 推导（task-ws-name.ts），
  // 连锚都取不到才回退历史 `taskpool-{taskId}`。字符面与工作名同规
  // （ASCII [a-zA-Z0-9_-]，禁冒号/空格/中文 —— worktree+Windows 事故史）。
  branch: z.string().min(2).max(60).regex(/^[a-zA-Z0-9_-]+$/, {
    message: "branch must match ^[a-zA-Z0-9_-]+$",
  }).optional(),
  // Phase plan (K1). Optional: a v4 draft mid-authoring may omit it entirely;
  // when present it must carry ≥1 phase (the ready gate, ticket 04, re-checks
  // ≥1 plus per-phase specPath/workflowRef resolvability — schema only owns
  // the shape).
  phases: z.array(taskPhaseSchema).min(1).optional(),
  // K6 flow driver: accepted ∧ autoAdvance ∧ i<n ⇒ next phase auto-dispatches.
  // `undefined` means default-ON; only explicit `false` parks each phase at
  // the human gate. Kept optional (no zod default) so v3 stored JSON never
  // gains a spurious key on PUT round-trips.
  autoAdvance: z.boolean().optional(),
  // 验收面 v2: the 验货台 re-verify command (see {@link acceptanceVerifySchema}).
  // Optional — absent = 「尚未预设复检命令」 state in the acceptance panel.
  acceptance_verify: acceptanceVerifySchema.optional(),
  // 验收面 v2.1: the 「跑起来看」 preview service ({@link acceptancePreviewSchema}).
  // Optional — absent = 「未配置预览」 state; clearable to null via spec-field.
  acceptance_preview: acceptancePreviewSchema.optional(),
  // 通用运行手册（多服务/远端部署的正道形态，见 {@link acceptanceRunbookSchema}）。
  // 缺省时 server 从 acceptance_preview 合成一份；两者都无 → 「未配置预览」。
  acceptance_runbook: acceptanceRunbookSchema.optional(),
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

/**
 * A `job`-type payload: a pointer at TypeScript that is already in the process.
 *
 * Deliberately tiny. The handler name is the whole contract — the config carries no
 * logic, so a schedule row can never make the server execute code the deployment
 * didn't register (an unregistered handler fails the run, it does not run anything).
 * `args` is opaque per-handler config (timeouts, batch sizes), never a script.
 */
export const codeJobConfigSchema = z.object({
  schema_version: z.literal('1.0'),
  type: z.literal('job'),
  handler: z.string().min(1).max(120),
  timeout_seconds: z.number().int().min(10).max(3600).optional().default(300),
  args: z.record(z.string(), z.unknown()).optional().default({}),
})

export const jobConfigSchema = z.discriminatedUnion('type', [
  workflowConfigSchema,
  agentConfigSchema,
  codeJobConfigSchema,
])


export const configSchemasByJobType = {
  workflow: workflowConfigSchema,
  agent: agentConfigSchema,
  job: codeJobConfigSchema,
} as const

// ── TS types (derived from zod) ─────────────────────────────────────

export type AgentRetryPolicy = z.infer<typeof agentRetryPolicySchema>
export type ProjectSpec = z.infer<typeof projectSpecSchema>
export type WorkspaceSpec = z.infer<typeof workspaceSpecSchema>
export type WorkflowChainItem = z.infer<typeof workflowChainItemSchema>
export type SubunitSpec = z.infer<typeof subunitSpecSchema>
export type TaskSpec = z.infer<typeof taskSpecSchema>
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type CodeJobConfig = z.infer<typeof codeJobConfigSchema>
export type JobConfig = z.infer<typeof jobConfigSchema>

/** The one fire the list row shows: the job's most recent schedule_executions row.
 *  `duration_ms` is the fire's own wall clock (NULL while it is still running, and NULL
 *  for the skip/miss rows that never had an engine) — 票06 手测⑤ asks for 「上次触发与
 *  耗时」 on the built-in job's row, and the number exists on the row already; it was
 *  simply not carried across the wire. */
export interface SchedulerExecutionSummary {
  status: SchedulerExecutionStatus
  triggered_at: string
  duration_ms: number | null
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
  claimed_at: string | null
  // ADR-0021 票03: trigger_source / origin_type / origin_id / source_chat_session_id are
  // gone. A schedule row is a job definition; it never records which task (if any) asked
  // for it, because after v41 no task asks the scheduler for anything. The board's task
  // read model comes from GET /api/tasks/:id/executions instead of from here.
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
  /** Scope the list to one workspace's org (the scheduler page per-workspace view). */
  workspace_id?: string
  sort?: 'next_trigger_at' | 'name' | 'created_at'
  order?: 'asc' | 'desc'
  // The trigger_source / origin filters left with the columns: after v42 every row in
  // the table is a job, so there is nothing to filter task-ness out of.
}
