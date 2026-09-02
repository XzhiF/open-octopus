import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { parseExpression } from 'cron-parser'
import { z } from 'zod'
import { validateConfig, ConfigValidationError } from './config-validator'
import type {
  SchedulerJob,
  SchedulerExecution,
  SchedulerAuditLog,
  PaginatedResponse,
  JobType,
  CreateJobInput,
  UpdateJobInput,
  ListJobsParams,
  ListExecutionsParams,
  ListAuditLogsParams,
  SchedulerExecutionSummary,
  SchedulerExecutionStatus,
  JobConfig,
  TriggerSource,
  ScheduleStatus,
  WorkflowConfig,
  TaskSpec,
  SubunitSpec,
  OriginType,
  ResourceRef, TokenUsage } from '@octopus/shared'
import { usageFromLegacyJson } from '../../db/dao/usage-mapping'
import {
  taskSpecSchema,
  type ScheduleStatusListener,
  type OriginType,
} from '@octopus/shared'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'
import { SSEService } from '../sse'
import { resolveInputValues } from './template-resolver'

// ── Error Classes ────────────────────────────────────────────────────

export class SchedulerJobNotFoundError extends Error {
  constructor(message = 'Schedule not found') {
    super(message)
    this.name = 'SchedulerJobNotFoundError'
  }
}

export class SchedulerJobConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulerJobConflictError'
  }
}

export class SchedulerVersionConflictError extends Error {
  constructor(message = 'Conflict: schedule has been modified by another user') {
    super(message)
    this.name = 'SchedulerVersionConflictError'
  }
}

export class SchedulerTriggerConflictError extends Error {
  constructor(message = '调度正在运行中，跳过本次触发') {
    super(message)
    this.name = 'SchedulerTriggerConflictError'
  }
}

export class SchedulerTriggerSourceMismatchError extends Error {
  constructor(message = 'Only cron schedules can be toggled') {
    super(message)
    this.name = 'SchedulerTriggerSourceMismatchError'
  }
}

// G4 (ticket 06): abort is only valid on an in-flight (claimed/running) task.
// Aborting a draft (not yet enqueued), a queued task (not yet claimed), or a
// terminal state (done/failed/aborted) is a no-op at best and a data-corruption
// race at worst. Maps to HTTP 400 so callers can surface "cannot abort a task
// that isn't running" rather than a generic 500.
export class SchedulerJobNotAbortableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulerJobNotAbortableError'
  }
}

// Re-export for convenience
export { ConfigValidationError }

// ── JobDetail (composite view, ticket 10) ─────────────────────────────
// GET /jobs/:id returns a JobDetail for composite tasks: children[] (actual
// dispatched child schedules, found via the parent_task_dispatch marker written
// by TaskDispatchService at dispatch time) + dag (the composition structure
// derived from task_spec.subunits + integration_goal). Simple tasks return a
// plain SchedulerJob (children/dag undefined).

export interface JobDetailDagNode {
  id: string
  type: 'subunit' | 'integration'
  label: string
  workflow_ref?: string
}

export interface JobDetailDagEdge {
  from: string
  to: string
}

export interface JobDetailDag {
  nodes: JobDetailDagNode[]
  edges: JobDetailDagEdge[]
}

export interface JobDetailChild {
  schedule_id: string
  name: string
  status: string
  workflow_ref: string
  subunit_name: string
}

export type JobDetail = SchedulerJob & {
  children?: JobDetailChild[]
  dag?: JobDetailDag
}

/** CreateJobInput extended with task_spec-authoring fields (G9). The shared
 *  CreateJobInput carries the legacy config path; these fields drive the
 *  task_spec materialization path in createJob/updateJob. */
export interface CreateJobInputWithSpec extends CreateJobInput {
  task_spec?: TaskSpec
  project_ids?: string[]
  skills?: string[]
  workflow_ref?: string
}

export interface UpdateJobInputWithSpec extends UpdateJobInput {
  task_spec?: TaskSpec
  project_ids?: string[]
  skills?: string[]
  workflow_ref?: string
}

// ── task_spec → WorkflowConfig materialization (G9) ────────────────────
// Transforms a task-author-produced TaskSpec into the full WorkflowConfig the
// executor reads. Simple task (no subunits): workflow_chain single item using
// the provided workflow_ref. Composite task (subunits present): workflow_ref
// 'composition-task' (the core-pack template, ticket 04's COMPOSITION_WF_REF)
// + task_spec.subunits preserved in config (executor reads via
// buildCompositeInputValues). skills are re-attached post-validation (Zod
// strips unknown keys from workflowConfigSchema) so per-task skills survive in
// the persisted config JSON for downstream skill injection (D6).

const COMPOSITION_WF_REF = 'composition-task'

// SG9 (ticket 06): composite requires subunits.length >= 2 (1-subunit → simple
// workflow_chain). The dispatch seam (TasksService.readyTask) uses the same
// threshold; materialize + isCompositeTask (workflow-executor) mirror it so
// simple 1-subunit tasks skip the coordinator-ws (ADR-0009 N+1→1 optimization).
function isCompositeTaskSpec(task_spec: TaskSpec): boolean {
  return (task_spec.subunits?.length ?? 0) >= 2
}

// SG5 (ticket 06): the tasks dispatch seam (TasksService.readyTask) calls this
// to materialize the WorkflowConfig for the schedules envelope. Body changes:
//   1. DROP task_spec from the output config — task_spec lives in the tasks
//      table (v2-D1); the schedules.config carries only the runtime WorkflowConfig
//      (workspace_spec + workflow_chain + requires), not the authoring WHAT.
//   2. Composite path injects input_values.subunit_count on workflow_chain[0]
//      so the composition-task workflow's Loop break_when can read it without
//      re-parsing task_spec.subunits at runtime.
//   3. Simple path (subunits.length < 2) uses the provided workflow_ref directly
//      (skips coordinator-ws, ADR-0009). No subunit_count injected (none needed).
// SG7 (ticket 07): propagate `resources` (task-level, from tasks.resources
//   column) + `task_spec.subunits[].resources[]` → `config.requires`. Mapping:
//   skill→skills, agent→agent_files, command→commands, rule→rules. UNION + dedupe
//   across task-level and all subunits. Omitted entirely when no resources
//   (backward compat with 06's AC4 — config.requires stays undefined).
// Ticket 08 (D14/SW-BP7): $vars.task_artifacts_dir injection. The dispatch seam
// (TasksService.readyTask) computes the task's artifacts directory via
// TaskHomeService.artifactsDir(id) (pure path, ADR-0011) and passes it here. It
// lands in workflow_chain[0].input_values so:
//   - simple tasks: execute() passes firstStep.input_values directly → the
//     workflow's $vars.task_artifacts_dir is set.
//   - composite tasks: buildCompositeInputValues (workflow-executor.ts) READS
//     it from here and preserves it in the composition wf's input_values (AC2 —
//     without this, buildCompositeInputValues would drop it since it replaces
//     firstStep.input_values entirely).
// Omitted (undefined) for legacy tasks that have no task home (AC4 backward
// compat — createJob/updateJob paths don't pass it).
//
// task-workflow-handoff (ADR-0013): taskWorkflowsDir is injected as
// $vars.task_workflows_dir for simple tasks (mirroring task_artifacts_dir).
// WorkflowExecutor reads this post-createFromSpec to copy agent-authored
// workflow YAMLs from the task home into the execution ws workflows/.
//
// task-phase-redesign (ticket 04, K5/K13): v4Phases is the ready-gate's
// per-phase resolution result (tasks-service.gateV4Phases — spec files exist,
// workflow_refs resolvable, required inputs satisfied). When present the
// envelope gains `format:'v4'` + `phases:[...]` (consumed by ticket 05's
// dispatchPhaseRound) and workflow_chain[0] is PRE-LOADED with phase 1, so the
// unchanged trigger→claim→execute path runs the first phase. One task, one
// schedule envelope (K5) — later phases are new executions under it, not new
// schedules. `phases`/`format` are intentional unknown keys for
// workflowConfigSchema (stripped on a strict re-parse, NOT rejected — same
// survival mechanism as the `skills` key below: the persisted JSON carries them).
/** One v4 phase fully resolved at the ready gate (absolute specPath verified
 *  against the task home; inputValues placeholder-resolved — management keys
 *  appended here by materializeTaskSpecToConfig). */
export interface TaskV4PhaseConfig {
  index: number
  name: string
  slug: string
  specPath: string
  specDir: string
  workflowRef: string
  inputValues: Record<string, string>
}
export function materializeTaskSpecToConfig(
  task_spec: TaskSpec,
  project_ids: string[],
  org: string,
  workflow_ref?: string,
  skills?: string[],
  resources?: ResourceRef[],
  taskArtifactsDir?: string,
  taskWorkflowsDir?: string,
  v4Phases?: TaskV4PhaseConfig[],
): WorkflowConfig {
  const isComposite = isCompositeTaskSpec(task_spec)
  const projects = project_ids.map((id) => ({ name: id, source_path: '', group: '' }))
  // branch_prefix must match /^[a-zA-Z0-9_-]+$/ (workspaceSpecSchema). Derive a
  // safe, stable prefix from org so multiple drafts in the same org share a prefix.
  const branchPrefix = `taskpool-${org}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50) || 'taskpool'

  // Ticket 08: build the input_values for workflow_chain[0]. Simple tasks carry
  // task_artifacts_dir directly (execute passes firstStep.input_values to the
  // workflow). Composite tasks carry subunit_count (SG5) + task_artifacts_dir
  // (the latter is read by buildCompositeInputValues at execute time, AC2).
  // task-workflow-presets (T4): resolve ${goal}/${ac} placeholders in
  // task_spec.input_values and merge into simpleInputValues. Management keys
  // (task_artifacts_dir, task_workflows_dir) are written LAST so they take
  // priority over any user-supplied input_values with the same key.
  const { values: resolvedInputs, unresolved } = resolveInputValues(
    task_spec.input_values,
    task_spec.goal,
    task_spec.ac,
  )
  // Best-effort at dispatch: an unresolved placeholder (e.g. `${goaal}`) is a
  // gate-visible defect — the ready-gate pushes it into missing before enqueue.
  // If one slips through here, warn and keep the "" value instead of blocking
  // the whole dispatch (SW-BP13: never let a data quirk kill the run).
  if (unresolved.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scheduler] input_values has unresolved placeholders for a task — check before ready: ${unresolved.join(", ")}`,
    )
  }
  const simpleInputValues: Record<string, unknown> = { ...resolvedInputs }
  const compositeInputValues: Record<string, unknown> = {
    subunit_count: task_spec.subunits?.length ?? 0,
  }
  if (taskArtifactsDir) {
    simpleInputValues.task_artifacts_dir = taskArtifactsDir
    compositeInputValues.task_artifacts_dir = taskArtifactsDir
  }
  // task-workflow-handoff (ADR-0013): task_workflows_dir injection (mirrors
  // task_artifacts_dir). WorkflowExecutor reads this to copy {home}/workflows/
  // YAMLs into the execution ws `workflows/` post-createFromSpec.
  if (taskWorkflowsDir) {
    simpleInputValues.task_workflows_dir = taskWorkflowsDir
    compositeInputValues.task_workflows_dir = taskWorkflowsDir
  }
  const config: WorkflowConfig = {
    schema_version: '3.0',
    type: 'workflow',
    workspace_spec: {
      org,
      branch_prefix: branchPrefix,
      projects: projects.length
        ? projects
        : [{ name: 'default', source_path: '', group: '' }],
    },
    workflow_chain: isComposite
      ? [{
          workflow_ref: COMPOSITION_WF_REF,
          // SG5: inject subunit_count so the composition-task Loop break_when
          // can read it without re-parsing task_spec.subunits at runtime. The
          // subunits array itself is NOT injected here (task_spec is dropped);
          // the composition-task workflow reads subunits from its own input_values
          // if needed — but the canonical input source is subunit_count for the
          // Loop break, which is all that's needed for iteration control.
          // Ticket 08: task_artifacts_dir is also injected here so
          // buildCompositeInputValues can read+preserve it (AC2).
          input_values: compositeInputValues as unknown as Record<string, string>,
        }]
      : [{ workflow_ref: workflow_ref ?? '', input_values: simpleInputValues as unknown as Record<string, string> }],
    max_retain: 10,
    // SG5: NO task_spec in the output config — it lives in the tasks table now.
    // The composition-task workflow reads subunit_count (above) + the parent
    // task's task_spec via the tasks origin lookup if needed (future), not from
    // this config.
  }
  // Re-attach skills post-validation-safe (survives JSON.stringify; Zod would
  // strip on re-parse but we only parse-read, not re-validate, on GET).
  if (skills?.length) {
    ;(config as WorkflowConfig & { skills?: string[] }).skills = skills
  }
  // SG7 (ticket 07): propagate task-level + subunit-level resources → config.requires.
  // UNION + dedupe across all sources (task.resources + each subunit.resources).
  // Omitted entirely when no resources → config.requires stays undefined (backward
  // compat: 06's AC4 doesn't expect requires, and existing schedules have none).
  const requires = buildConfigRequires(task_spec, resources)
  if (requires) {
    config.requires = requires
  }
  // task-phase-redesign (ticket 04): v4 envelope overlay. The gate resolved
  // every phase (spec exists / ref resolvable / required inputs non-empty);
  // here we append the management keys per-phase (same priority rule as the
  // simple path: user keys first, management keys last) and mirror phase 1
  // into workflow_chain[0] so the existing trigger path runs it unchanged.
  if (v4Phases && v4Phases.length > 0) {
    const envelopePhases = v4Phases.map((p) => ({
      ...p,
      inputValues: {
        ...p.inputValues,
        ...(taskArtifactsDir ? { task_artifacts_dir: taskArtifactsDir } : {}),
        ...(taskWorkflowsDir ? { task_workflows_dir: taskWorkflowsDir } : {}),
      },
    }))
    const ext = config as WorkflowConfig & {
      format?: string
      phases?: typeof envelopePhases
    }
    ext.format = 'v4'
    ext.phases = envelopePhases
    config.workflow_chain = [{
      workflow_ref: envelopePhases[0].workflowRef,
      input_values: envelopePhases[0].inputValues as unknown as Record<string, string>,
    }]
  }
  return config
}

/** SG7 (ticket 07): build config.requires from task-level resources[] +
 *  task_spec.subunits[].resources[] (UNION, deduped). Returns undefined when
 *  the union is empty (no resources anywhere) so the config stays minimal.
 *  Mapping: skill→skills, agent→agent_files, command→commands, rule→rules. */
function buildConfigRequires(
  task_spec: TaskSpec,
  taskResources?: ResourceRef[],
): { skills: string[]; agent_files: string[]; commands: string[]; rules: string[] } | undefined {
  const all: ResourceRef[] = [...(taskResources ?? []), ...(task_spec.resources ?? [])]
  for (const su of task_spec.subunits ?? []) {
    all.push(...(su.resources ?? []))
  }
  if (all.length === 0) return undefined

  const skills = new Set<string>()
  const agent_files = new Set<string>()
  const commands = new Set<string>()
  const rules = new Set<string>()
  for (const ref of all) {
    switch (ref.type) {
      case "skill": skills.add(ref.name); break
      case "agent": agent_files.add(ref.name); break
      case "command": commands.add(ref.name); break
      case "rule": rules.add(ref.name); break
    }
  }
  const result: { skills: string[]; agent_files: string[]; commands: string[]; rules: string[] } = {
    skills: [...skills],
    agent_files: [...agent_files],
    commands: [...commands],
    rules: [...rules],
  }
  // Only return when at least one bucket is non-empty (defensive — `all` was
  // non-empty but an unknown type could land in no bucket; keep the contract).
  if (result.skills.length === 0 && result.agent_files.length === 0
    && result.commands.length === 0 && result.rules.length === 0) {
    return undefined
  }
  return result
}

/** Build the composition DAG from task_spec: one node per subunit + one
 *  integration node (if integration_goal present), edges subunit→integration. */
function buildDagFromTaskSpec(task_spec: TaskSpec): JobDetailDag {
  const subunits = task_spec.subunits ?? []
  const nodes: JobDetailDagNode[] = subunits.map((su: SubunitSpec) => ({
    id: su.name,
    type: 'subunit',
    label: su.name,
    workflow_ref: su.workflow_ref,
  }))

  const edges: JobDetailDagEdge[] = []

  if (task_spec.integration_goal || subunits.length > 1) {
    const integrationId = 'integration'
    nodes.push({
      id: integrationId,
      type: 'integration',
      label: task_spec.integration_goal?.strategy === 'merge' ? 'merge' : 'synthesis',
    })
    for (const su of subunits) {
      edges.push({ from: su.name, to: integrationId })
    }
  } else if (subunits.length === 1) {
    // Single subunit, no integration — still surface it as a node (no edges).
  }

  return { nodes, edges }
}

// ── Zod Validation Schemas ───────────────────────────────────────────

const cronExpressionField = z.string().min(1).refine(
  (val) => { try { parseExpression(val); return true } catch { return false } },
  { message: '无效的 Cron 表达式' },
)

const createJobSchema = z.object({
  name: z.string().min(1).max(200),
  job_type: z.enum(['workflow', 'agent']),
  cron_expression: cronExpressionField.nullable().optional(),
  timezone: z.string().refine(
    (val) => { try { new Intl.DateTimeFormat('en', { timeZone: val }); return true } catch { return false } },
    { message: '无效的 IANA 时区' },
  ).optional().default('Asia/Shanghai'),
  org: z.string().min(1).max(100).optional(),
  // config is now optional when task_spec is provided (G9: materialize from task_spec).
  // Backward compatible: existing callers still pass config directly.
  config: z.record(z.unknown()).optional(),
  // Ticket 10 (G9): task-author-produced spec → materialized into WorkflowConfig.
  task_spec: taskSpecSchema.optional(),
  project_ids: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string()).optional(),
  workflow_ref: z.string().optional(),
  parallel_policy: z.enum(['allow', 'wait', 'skip']).optional().default('skip'),
  timeout_seconds: z.number().int().min(60).max(86400).optional().default(3600),
  notify_on_failure: z.boolean().optional().default(false),
  description: z.string().max(1000).optional(),
  trigger_source: z.enum(['cron', 'requirement']).optional().default('cron'),
  source_chat_session_id: z.string().nullable().optional(),
}).superRefine((data, ctx) => {
  // trigger_source='cron' (default) requires a valid cron_expression
  if (data.trigger_source === 'cron' && !data.cron_expression) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cron_expression is required when trigger_source='cron'",
      path: ['cron_expression'],
    })
  }
  // G9: one of config or task_spec must be present. task_spec path materializes
  // the full WorkflowConfig; the legacy config path passes it through directly.
  if (!data.config && !data.task_spec) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'either config or task_spec is required',
      path: ['config'],
    })
  }
  // task_spec path requires project_ids (for workspace_spec.projects). The legacy
  // config path already carries workspace_spec inside config.
  if (data.task_spec && !data.project_ids?.length && !data.config) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'project_ids is required when task_spec is provided (without config)',
      path: ['project_ids'],
    })
  }
})

const updateJobSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cron_expression: cronExpressionField.nullable().optional(),
  timezone: z.string().refine(
    (val) => { try { new Intl.DateTimeFormat('en', { timeZone: val }); return true } catch { return false } },
    { message: '无效的 IANA 时区' },
  ).optional(),
  config: z.record(z.unknown()).optional(),
  // Ticket 10: edit task_spec while status=draft (PUT /jobs/:id, If-Match).
  // Re-materializes the WorkflowConfig from the updated task_spec.
  task_spec: taskSpecSchema.optional(),
  project_ids: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string()).optional(),
  workflow_ref: z.string().optional(),
  parallel_policy: z.enum(['allow', 'wait', 'skip']).optional(),
  timeout_seconds: z.number().int().min(60).max(86400).optional(),
  notify_on_failure: z.boolean().optional(),
  description: z.string().max(1000).optional(),
})

// ── Row Types ────────────────────────────────────────────────────────

interface ScheduleRow {
  id: string
  org: string
  name: string
  cron_expression: string | null
  timezone: string
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
  // schema v38b (ticket 06 / SG1b): trigger_source + source_chat_session_id
  // DROPPED. The承重 sites below use origin_type (S2 polymorphic origin).
  origin_type: string | null
  origin_id: string | null
  origin_role: string | null
  assoc_meta: string | null
  claimed_at: string | null
  // Populated by correlated subqueries in listJobs/getJob (not a real column)
  last_exec_status?: string | null
  last_exec_triggered_at?: string | null
  last_exec_error_summary?: string | null
}

interface ScheduleExecutionRow {
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
  created_at: string
  completed_at: string | null
  exit_code: number | null
  agent_output: string | null
  model_used: string | null
  token_usage: string | null
  metadata: string | null
  triggered_by: string | null
}

interface ScheduleWorkspaceRow {
  id: string
  schedule_id: string
  workspace_id: string
  execution_id: string | null
  status: string
  branch_suffix: string
  started_at: string
  completed_at: string | null
  error: string | null
  workspace_name?: string
  workspace_status?: string
}

// ── Utilities ────────────────────────────────────────────────────────

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function mapExecutionStatus(dbStatus: string): SchedulerExecutionStatus {
  if (dbStatus === 'completed') return 'success'
  if (dbStatus === 'failed') return 'failure'
  return dbStatus as SchedulerExecutionStatus
}

// ── SchedulerService ──────────────────────────────────────────────

export interface SchedulerCallbacks {
  /** Fired after create/update/delete/toggle so the engine can reload cron jobs */
  onScheduleChange?: () => void
  /** Fired after a manual trigger INSERTs the schedule_execution row;
   *  the engine dispatches the actual executor. */
  onTrigger?: (scheduleId: string, executionId: string) => void
}

export class SchedulerService {
  private callbacks: SchedulerCallbacks = {}
  private configDAO: ScheduleConfigDAO
  private runDAO: ScheduleRunDAO
  // 07 (G5): optional so existing 2-arg call sites (incl. other tickets'
  // tests) keep compiling; production (index.ts) always passes the real
  // SSEService. Emits are guarded with this.sse?.emit.
  private sse?: SSEService
  // 03 (SG2): optional ScheduleStatusListener. When injected, the
  // emitScheduleStatus seam also mirrors the transition onto the parent task's
  // status + emits task_status SSE (covers enqueueJob→queued + abortJob→aborted
  // — the two transitions this service owns). Optional so existing 3-arg call
  // sites keep compiling; production wires the real listener.
  private scheduleStatusListener?: ScheduleStatusListener

  constructor(
    configDAO: ScheduleConfigDAO,
    runDAO: ScheduleRunDAO,
    sse?: SSEService,
    scheduleStatusListener?: ScheduleStatusListener,
  ) {
    this.configDAO = configDAO
    this.runDAO = runDAO
    this.sse = sse
    this.scheduleStatusListener = scheduleStatusListener
  }

  /** Late-bind engine callbacks (engine is constructed after the service). */
  setCallbacks(cb: SchedulerCallbacks): void {
    this.callbacks = cb
  }

  protected notifyScheduleChange(): void {
    try {
      this.callbacks.onScheduleChange?.()
    } catch (err: unknown) {
      console.error('[SchedulerService] onScheduleChange callback failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // ── List Jobs (global, cross-workspace) ───────────────────────────

  listJobs(params: ListJobsParams = {}): PaginatedResponse<SchedulerJob> {
    const page = Math.max(1, params.page ?? 1)
    const limit = Math.min(100, Math.max(1, params.limit ?? 20))
    const offset = (page - 1) * limit

    const conditions: string[] = ['s.deleted_at IS NULL']
    const queryParams: unknown[] = []

    if (params.search) {
      const raw = params.search.slice(0, 200)
      conditions.push('INSTR(s.name, ?) > 0')
      queryParams.push(raw)
    }

    if (params.status === 'enabled') {
      conditions.push('s.enabled = 1')
    } else if (params.status === 'disabled') {
      conditions.push('s.enabled = 0')
    } else if (params.status === 'failed') {
      conditions.push('s.enabled = 1 AND s.consecutive_failures > 0')
    }

    if (params.job_type) {
      conditions.push('s.job_type = ?')
      queryParams.push(params.job_type)
    }

    if (params.workspace_id) {
      conditions.push('s.org = (SELECT org FROM workspaces WHERE id = ?)')
      queryParams.push(params.workspace_id)
    }

    // SG1b (ticket 06): listJobs still accepts ?trigger_source=requirement (legacy
    // route filter), but the schedules table no longer has the trigger_source col.
    // Map the legacy filter to origin_type: 'requirement' → origin_type IN
    // ('task','manual','api') (non-cron); 'cron' → origin_type='cron'. This keeps
    // the existing /api/scheduler/jobs?trigger_source=... route working without
    // touching routes/scheduler.ts.
    if (params.trigger_source) {
      if (params.trigger_source === 'requirement') {
        conditions.push("s.origin_type IN ('task','manual','api')")
      } else {
        conditions.push("s.origin_type = 'cron'")
      }
    }

    // 2026-08-29 (approach A): precise single-origin filter — takes precedence
    // when combined with the legacy trigger_source above (both AND-ed).
    if (params.origin) {
      conditions.push('s.origin_type = ?')
      queryParams.push(params.origin)
    }

    if (params.org) {
      conditions.push('s.org = ?')
      queryParams.push(params.org)
    }

    const sortColumn = params.sort === 'name'
      ? 's.name'
      : params.sort === 'created_at'
        ? 's.created_at'
        : 's.next_trigger_at'
    const sortDirection = params.order === 'asc' ? 'ASC' : 'DESC'

    // NULLs last for next_trigger_at sorting
    const orderClause = params.sort === 'next_trigger_at' || !params.sort
      ? `CASE WHEN ${sortColumn} IS NULL THEN 1 ELSE 0 END ${sortDirection}, ${sortColumn} ${sortDirection}`
      : `${sortColumn} ${sortDirection}`

    const { rows, total } = this.configDAO.listJobsQuery({
      conditions, queryParams, orderClause, limit, offset,
    })

    const items = rows.map((row) => this.enrichJobRow(row))

    return { items, total, page, limit }
  }

  // ── Create Job ────────────────────────────────────────────────────

  createJob(input: CreateJobInputWithSpec): SchedulerJob {
    const validated = createJobSchema.parse(input)

    // G9: materialize WorkflowConfig from task_spec if provided (task-author path),
    // else use the legacy config path (backward compatible). validateConfig runs
    // the full Zod schema (workflowConfigSchema v3.0) so task_spec survives (it's
    // in the schema); skills are re-attached post-validation (Zod strips unknown keys).
    let validatedConfig: JobConfig
    let skills: string[] | undefined
    if (validated.task_spec && !validated.config) {
      const orgForMaterialization = validated.org ?? ''
      const materialized = materializeTaskSpecToConfig(
        validated.task_spec,
        validated.project_ids ?? [],
        orgForMaterialization,
        validated.workflow_ref,
        validated.skills,
      )
      // SG5 (ticket 06): materialize injects input_values.subunit_count as a
      // NUMBER for the composition-task Loop break_when. The shared
      // workflowChainItemSchema.input_values is z.record(z.string(), z.string())
      // (string values only — boundary: shared off-limits to widen). Zod
      // validation would reject the number, so SKIP validateConfig for the
      // task_spec-materialized path — the materialize output is a known-good
      // system-produced shape (not user input), same as the v2 readyTask path
      // (TasksService.readyTask doesn't validate either). The legacy config
      // path below still validates user-supplied configs.
      validatedConfig = materialized as unknown as JobConfig
      skills = validated.skills
    } else {
      validatedConfig = validateConfig(validated.job_type, validated.config)
    }

    // Derive org: explicit org param, or from workspace_spec in config, or empty
    const org = validated.org
      ?? (validatedConfig.type === 'workflow' ? validatedConfig.workspace_spec.org : '')

    // Check name uniqueness within org
    if (org) {
      if (this.configDAO.checkNameConflict(org, validated.name)) {
        throw new SchedulerJobConflictError(`调度名称 "${validated.name}" 已存在`)
      }
    }

    // Derive status + origin_type from trigger_source. SG1b (ticket 06):
    // trigger_source is no longer persisted (DROPPED col) — the SchedulerService
    // still accepts it in the input schema (backward-compat with routes/scheduler.ts)
    // but maps it to origin_type at the boundary:
    //   trigger_source='requirement' → origin_type='task' (task-pool semantics)
    //   trigger_source='cron' (default) → origin_type='cron'
    // The new dispatch seam (TasksService.readyTask) sets origin_type directly
    // ('task' + origin_role). This createJob path is the legacy /api/scheduler/jobs
    // route (task-author v1; spec: removed in favor of /api/tasks, but the route
    // is out of this ticket's scope — keep working via the mapping).
    const triggerSource: TriggerSource = validated.trigger_source
    const originType: OriginType = triggerSource === 'requirement' ? 'task' : 'cron'
    const status: ScheduleStatus = triggerSource === 'requirement' ? 'draft' : 'queued'

    // For 'cron' jobs, compute next trigger from cron_expression.
    // For 'requirement' drafts, cron_expression is null and next_trigger_at stays null.
    const cronExpression = triggerSource === 'cron' ? validated.cron_expression! : null
    const nextTrigger = cronExpression
      ? this.calculateNextTrigger(cronExpression, validated.timezone)
      : null

    const id = randomUUID()
    const now = new Date().toISOString()
    // Re-attach skills (stripped by Zod validateConfig) so per-task skills persist
    // in the config JSON for downstream skill injection (D6).
    const configObj = skills?.length ? { ...validatedConfig, skills } : validatedConfig
    const configJson = JSON.stringify(configObj)

    // Derive max_retain from config for workflow jobs
    const maxRetain = validatedConfig.type === 'workflow' ? validatedConfig.max_retain : 10

    // Drafts are born disabled (enabled=0); cron jobs born enabled=1
    const enabled = status === 'draft' ? 0 : 1

    this.configDAO.transaction(() => {
      this.configDAO.insertSchedule({
        id, org, name: validated.name,
        cron_expression: cronExpression, timezone: validated.timezone,
        timeout_seconds: validated.timeout_seconds,
        notify_on_failure: validated.notify_on_failure ? 1 : 0,
        next_trigger_at: nextTrigger,
        created_at: now, updated_at: now,
        job_type: validated.job_type, config: configJson,
        parallel_policy: validated.parallel_policy,
        description: validated.description ?? null,
        max_retain: maxRetain,
        enabled,
        status,
        // SG1b: origin cols replace the dropped trigger_source/source_chat_session_id.
        // The legacy createJob path doesn't carry origin_id/origin_role (those are
        // set by the dispatch seam / TaskDispatchService); only origin_type here.
        origin_type: originType,
      })

      this.writeAuditLog({
        schedule_id: id,
        action: 'created',
        changes: {
          name: { before: null, after: validated.name },
          job_type: { before: null, after: validated.job_type },
          cron_expression: { before: null, after: cronExpression },
          timezone: { before: null, after: validated.timezone },
          org: { before: null, after: org },
          origin_type: { before: null, after: originType },
          status: { before: null, after: status },
        },
      })
    })

    this.notifyScheduleChange()
    return this.getJob(id)
  }

  // ── Get Job ───────────────────────────────────────────────────────

  getJob(id: string): JobDetail {
    const row = this.configDAO.getJobWithLastExec(id)

    if (!row) {
      throw new SchedulerJobNotFoundError()
    }

    const job = this.enrichJobRow(row)

    // Ticket 10: composite tasks return JobDetail with children[] + dag.
    // dag is derived from task_spec.subunits + integration_goal (static structure).
    // children[] are actual dispatched child schedules (found via the
    // parent_task_dispatch marker written by TaskDispatchService at dispatch time).
    // For a draft (not yet dispatched), children=[] — only the planned dag exists.
    //
    // SG5 (ticket 06): task_spec is NO LONGER in config (lives in the tasks table).
    // Detect composite via the composition-task workflow_ref OR input_values.subunit_count
    // (injected by materializeTaskSpecToConfig). When composite, look up the task_spec
    // from the tasks table via S2 origin (origin_type='task', origin_id=task.id) to
    // build the dag. Falls back to config.task_spec for legacy/test configs that
    // still carry it (defensive — backward compat).
    const taskSpec = this.resolveCompositeTaskSpec(job.config, row as ScheduleRow)
    if (job.config.type === 'workflow' && taskSpec?.subunits?.length) {
      const detail = job as JobDetail
      detail.dag = buildDagFromTaskSpec(taskSpec)
      detail.children = this.findCompositeChildren(id, taskSpec.subunits)
    }

    return job
  }

  /** SG5 (ticket 06): resolve the task_spec for a composite schedule. The config
   *  no longer carries task_spec (dropped by materializeTaskSpecToConfig). Look it
   *  up from the tasks table via S2 origin (origin_type='task', origin_id=task.id).
   *  Falls back to config.task_spec for legacy/test configs that still carry it.
   *  Returns null for non-composite or unresolvable schedules. */
  private resolveCompositeTaskSpec(config: JobConfig, row: ScheduleRow): TaskSpec | null {
    // Legacy/test path: config still carries task_spec (composite-dispatch.test.ts seeds this).
    if (config.task_spec?.subunits?.length) return config.task_spec
    // SG5 new path: detect composite via composition-task workflow_ref OR
    // input_values.subunit_count (injected by materializeTaskSpecToConfig).
    const ref = config.workflow_chain?.[0]?.workflow_ref
    const isCompositeRef = typeof ref === 'string' && (ref === COMPOSITION_WF_REF || ref.endsWith(`/${COMPOSITION_WF_REF}`))
    const subunitCount = (config.workflow_chain?.[0]?.input_values as Record<string, unknown> | undefined)?.subunit_count
    const isCompositeCount = typeof subunitCount === 'number' && subunitCount >= 2
    if (!isCompositeRef && !isCompositeCount) return null
    // Look up the parent task's task_spec via S2 origin.
    const originId = row.origin_id
    const originType = row.origin_type
    if (!originId || (originType ?? 'cron') !== 'task') return null
    try {
      const taskRow = this.configDAO
        .getDb()
        .prepare('SELECT task_spec FROM tasks WHERE id = ? AND deleted_at IS NULL')
        .get(originId) as { task_spec: string | null } | undefined
      if (!taskRow?.task_spec) return null
      return JSON.parse(taskRow.task_spec) as TaskSpec
    } catch {
      return null
    }
  }

  /** Look up dispatched child schedules for a composite parent. Correlates via the
   *  parent_task_dispatch marker in each child's config (pointing at the parent
   *  composition-wf execution_id). Matches each child to a subunit by workflow_ref
   *  (first unmatched) so the kanban can label children with their subunit name. */
  private findCompositeChildren(scheduleId: string, subunits: SubunitSpec[]): JobDetailChild[] {
    // Find the parent's composition-wf execution_id from schedule_executions.
    // Draft → no executions → children=[].
    const execs = this.runDAO.listExecutions(scheduleId, { limit: 5 })
    const parentExecId = execs.data.find((e) => e.execution_id)?.execution_id
    if (!parentExecId) return []

    const childRows = this.configDAO.findChildSchedules(parentExecId)
    const usedSubunitIdx = new Set<number>()

    return childRows.map((row) => {
      const childConfig = safeJsonParse<{ workflow_chain?: Array<{ workflow_ref: string }> }>(
        row.config,
        {},
      )
      const childWorkflowRef = childConfig.workflow_chain?.[0]?.workflow_ref ?? ''

      // Match child to subunit by workflow_ref (first unmatched subunit).
      let subunitName = row.name
      for (let i = 0; i < subunits.length; i++) {
        if (usedSubunitIdx.has(i)) continue
        if (subunits[i].workflow_ref === childWorkflowRef) {
          subunitName = subunits[i].name
          usedSubunitIdx.add(i)
          break
        }
      }

      return {
        schedule_id: row.id,
        name: row.name,
        status: row.status,
        workflow_ref: childWorkflowRef,
        subunit_name: subunitName,
      }
    })
  }

  // ── Update Job (optimistic locking) ──────────────────────────────

  updateJob(id: string, input: UpdateJobInputWithSpec, version: number): SchedulerJob {
    const existing = this.configDAO.findByIdRaw(id) as unknown as ScheduleRow | undefined

    if (!existing) {
      throw new SchedulerJobNotFoundError()
    }

    if (existing.version !== version) {
      throw new SchedulerVersionConflictError()
    }

    const validated = updateJobSchema.parse(input)

    // G9: re-materialize config if task_spec provided (edit while draft).
    // task_spec edits are only allowed while status=draft (the authoring review
    // state). Once enqueued (queued/claimed/running/done/failed/aborted), the
    // config is immutable — editing it would desync the executor.
    let validatedConfig: JobConfig | undefined
    let skills: string[] | undefined
    if (validated.task_spec) {
      if ((existing.status ?? 'queued') !== 'draft') {
        throw new SchedulerJobConflictError(
          `Cannot edit task_spec: current status is ${existing.status ?? 'queued'} (only draft can be edited)`,
        )
      }
      const existingConfig = safeJsonParse<WorkflowConfig>(existing.config, {} as WorkflowConfig)
      const existingProjects = existingConfig.workspace_spec?.projects?.map((p) => p.name) ?? []
      const projectIds = validated.project_ids ?? existingProjects
      const org = existingConfig.workspace_spec?.org ?? existing.org ?? ''
      // Preserve the existing workflow_ref when re-materializing (simple tasks need
      // it for workflow_chain; composite tasks use 'composition-task' regardless).
      const existingWorkflowRef = existingConfig.workflow_chain?.[0]?.workflow_ref
      const materialized = materializeTaskSpecToConfig(
        validated.task_spec,
        projectIds,
        org,
        validated.workflow_ref ?? existingWorkflowRef,
        validated.skills,
      )
      validatedConfig = validateConfig(existing.job_type as JobType, materialized)
      skills = validated.skills
    } else if (validated.config) {
      // Legacy config path (backward compatible)
      validatedConfig = validateConfig(existing.job_type as JobType, validated.config)
    }

    // Check name uniqueness if changing
    if (validated.name !== undefined && validated.name !== existing.name && existing.org) {
      if (this.configDAO.checkNameConflict(existing.org, validated.name, id)) {
        throw new SchedulerJobConflictError(`调度名称 "${validated.name}" 已存在`)
      }
    }

    const now = new Date().toISOString()
    const changes: Record<string, { before: unknown; after: unknown }> = {}

    const fieldMap: Array<[keyof typeof validated, string]> = [
      ['name', 'name'],
      ['cron_expression', 'cron_expression'],
      ['timezone', 'timezone'],
      ['parallel_policy', 'parallel_policy'],
      ['timeout_seconds', 'timeout_seconds'],
      ['description', 'description'],
    ]

    for (const [key, col] of fieldMap) {
      const value = validated[key]
      if (value !== undefined) {
        const existingRecord = existing as unknown as Record<string, unknown>
        changes[col] = { before: existingRecord[col], after: value }
      }
    }

    // notify_on_failure: boolean to int
    if (validated.notify_on_failure !== undefined) {
      changes.notify_on_failure = {
        before: existing.notify_on_failure === 1,
        after: validated.notify_on_failure,
      }
    }

    // config: JSON serialization
    if (validatedConfig) {
      changes.config = {
        before: safeJsonParse(existing.config, {}),
        after: validatedConfig,
      }
    }

    // Recalculate next_trigger_at when cron or timezone changes.
    // Use === undefined (not ??) so user can explicitly clear cron by passing null.
    const effectiveCron = validated.cron_expression === undefined
      ? existing.cron_expression
      : validated.cron_expression
    const effectiveTz = validated.timezone ?? existing.timezone

    this.configDAO.transaction(() => {
      // Build the fields object for updateScheduleWithVersion
      const updateFields: Record<string, unknown> = {}
      for (const [key, col] of fieldMap) {
        const value = validated[key]
        if (value !== undefined) updateFields[col] = value
      }
      if (validated.notify_on_failure !== undefined) {
        updateFields.notify_on_failure = validated.notify_on_failure ? 1 : 0
      }
      if (validatedConfig) {
        // Re-attach skills (stripped by Zod validateConfig) so per-task skills
        // persist in the config JSON (D6, same as createJob).
        const configObj = skills?.length ? { ...validatedConfig, skills } : validatedConfig
        updateFields.config = JSON.stringify(configObj)
        if (existing.job_type === 'workflow' && validatedConfig.type === 'workflow') {
          updateFields.max_retain = validatedConfig.max_retain
        }
      }
      if (validated.cron_expression !== undefined || validated.timezone !== undefined) {
        const nextTrigger = existing.enabled === 1 && effectiveCron
          ? this.calculateNextTrigger(effectiveCron, effectiveTz)
          : null
        updateFields.next_trigger_at = nextTrigger
      }

      const vr = this.configDAO.updateScheduleWithVersion(id, updateFields, version)
      if (vr.changes === 0) {
        throw new SchedulerVersionConflictError()
      }

      this.writeAuditLog({
        schedule_id: id,
        action: 'updated',
        changes,
      })
    })

    this.notifyScheduleChange()
    return this.getJob(id)
  }

  // ── Delete Job (soft delete) ──────────────────────────────────────

  deleteJob(id: string): void {
    const existing = this.configDAO.findByIdRaw(id)

    if (!existing) {
      throw new SchedulerJobNotFoundError()
    }

    this.configDAO.transaction(() => {
      this.configDAO.softDelete(id)

      this.writeAuditLog({
        schedule_id: id,
        action: 'deleted',
      })
    })

    this.notifyScheduleChange()
  }

  // ── Toggle Job (enable/disable) ───────────────────────────────────

  toggleJob(id: string): SchedulerJob {
    const existing = this.configDAO.findByIdRaw(id) as unknown as ScheduleRow | undefined

    if (!existing) {
      throw new SchedulerJobNotFoundError()
    }

    // ponytail: guard at service level protects all callers (scheduler route, agent route, agent service)
    // SG1b (ticket 06): only cron-origin schedules use enabled/disabled toggle.
    // task/manual/api-origin schedules use status draft/queued/claimed/done, never enabled/disabled.
    // Migrated from trigger_source!=='cron' to origin_type!=='cron' (same semantics).
    if ((existing.origin_type ?? 'cron') !== 'cron') {
      throw new SchedulerTriggerSourceMismatchError()
    }

    const now = new Date().toISOString()
    const newEnabled = existing.enabled === 1 ? 0 : 1
    const nextTrigger = newEnabled === 1 && existing.cron_expression
      ? this.calculateNextTrigger(existing.cron_expression, existing.timezone)
      : null

    this.configDAO.transaction(() => {
      this.configDAO.updateScheduleWithVersion(id, {
        enabled: newEnabled,
        next_trigger_at: nextTrigger,
      }, existing.version)

      this.writeAuditLog({
        schedule_id: id,
        action: newEnabled === 1 ? 'enabled' : 'disabled',
        changes: { enabled: { before: existing.enabled === 1, after: newEnabled === 1 } },
      })
    })

    this.notifyScheduleChange()
    return this.getJob(id)
  }

  // ── Enqueue Job (draft → queued) ──────────────────────────────────

  enqueueJob(id: string): SchedulerJob {
    const existing = this.configDAO.findByIdRaw(id) as unknown as ScheduleRow | undefined

    if (!existing) {
      throw new SchedulerJobNotFoundError()
    }

    // SG1b (ticket 06): only task-origin schedules can be enqueued (draft→queued).
    // Migrated from trigger_source!=='requirement' to origin_type!=='task'
    // (same semantics: task-pool drafts, not cron jobs).
    if ((existing.origin_type ?? 'cron') !== 'task') {
      throw new SchedulerTriggerSourceMismatchError('Only task-origin schedules can be enqueued')
    }

    if ((existing.status ?? 'queued') !== 'draft') {
      throw new SchedulerJobConflictError(`Cannot enqueue: current status is ${existing.status ?? 'queued'}`)
    }

    this.configDAO.transaction(() => {
      this.configDAO.updateSchedule(id, { status: 'queued' })

      this.writeAuditLog({
        schedule_id: id,
        action: 'enqueued',
        changes: { status: { before: 'draft', after: 'queued' } },
      })
    })

    // 07 (G5): emit draft→queued so the kanban moves the card out of draft
    // instantly on [入队]. Emitted AFTER the transaction commits so a rolled-
    // back enqueue never produces a spurious SSE event.
    this.emitScheduleStatus(id, 'queued')

    this.notifyScheduleChange()
    return this.getJob(id)
  }

  // ── Abort Job (claimed/running → aborted) ───────────────────────
  // G4 (ticket 06): user-triggered abort. Terminal — checkStaleClaimed (engine)
  // filters status IN (claimed,running), so 'aborted' is never rolled back to
  // queued, breaking the stale→rollback→redispatch loop. Mirrors enqueueJob's
  // guard+transaction+audit shape; the running-execution cancel is best-effort.
  async abortJob(id: string): Promise<SchedulerJob> {
    const existing = this.configDAO.findByIdRaw(id) as unknown as ScheduleRow | undefined

    if (!existing) {
      throw new SchedulerJobNotFoundError()
    }

    const currentStatus = (existing.status ?? 'queued') as ScheduleStatus
    // Guard: only an in-flight task may be aborted. Drafts/queued haven't
    // claimed a worker; done/failed/aborted are already terminal.
    if (currentStatus !== 'claimed' && currentStatus !== 'running') {
      throw new SchedulerJobNotAbortableError(
        `Cannot abort: current status is ${currentStatus} (only claimed/running can be aborted)`,
      )
    }

    // Capture the in-flight execution's links BEFORE mutating schedule_executions.
    // markStaleExecutionsFailed (below) flips the row to 'failed'; we need the
    // execution_id + workspace_id to cancel the running workflow execution (if any).
    const activeExec = this.configDAO.findActiveExecutions(id)[0]
    const activeExecRow = activeExec ? this.runDAO.findExecutionById(activeExec.id) : null
    const executionId = activeExecRow?.execution_id ?? null
    const workspaceId = activeExecRow?.workspace_id ?? null

    const now = new Date().toISOString()
    const reason = `Aborted by user at ${now}`

    this.configDAO.transaction(() => {
      this.configDAO.updateSchedule(id, {
        status: 'aborted',
        claimed_at: null,
      })

      // Release the partial unique index idx_sched_execs_unique_active
      // (status IN triggered/running) so the schedule can be re-dispatched /
      // no longer blocks. Same primitive the stale-claimed rollback uses.
      this.runDAO.markStaleExecutionsFailed(id, reason)

      // Mark any in-flight schedule_workspaces as cleaned. Workspace dir
      // cleanup is deferred to the retain loop (matches checkStaleClaimed).
      this.configDAO.markScheduleWorkspacesCleanedBySchedule(id, now)

      this.writeAuditLog({
        schedule_id: id,
        action: 'aborted',
        changes: { status: { before: currentStatus, after: 'aborted' } },
      })
    })

    // 07 (G5): emit claimed/running→aborted so the kanban moves the card to the
    // aborted column instantly on [中止]. Emitted AFTER the transaction commits
    // (so a rolled-back abort never produces a spurious SSE event) and BEFORE
    // the best-effort execution cancel (so a slow cancel can't delay the UI
    // signal — the DB state is already terminal).
    this.emitScheduleStatus(id, 'aborted')

    // Cancel the running workflow execution (if any). Best-effort: a missing
    // execution_id (claimed but not yet linked to an executions row) or a
    // gone workspace must NOT block the abort — the DB state above is already
    // terminal. Dynamic import mirrors scheduler-engine.checkTimeouts to avoid
    // a static dependency cycle with execution-service-registry.
    if (executionId && workspaceId) {
      try {
        const { getExecutionService } = await import('../execution-service-registry')
        const registry = getExecutionService(workspaceId)
        if (registry) {
          await registry.service.cancel(executionId)
        }
      } catch (err: unknown) {
        console.error(
          '[SchedulerService] abortJob: failed to cancel running execution (non-fatal — abort already persisted):',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    this.notifyScheduleChange()
    return this.getJob(id)
  }

  // ── Trigger Job ───────────────────────────────────────────────────

  triggerJob(id: string): {
    execution_id: string
    schedule_id: string
    status: string
    trigger_type: string
    triggered_at: string
  } {
    const existing = this.configDAO.findByIdRaw(id) as unknown as ScheduleRow | undefined

    if (!existing) {
      throw new SchedulerJobNotFoundError()
    }

    // Check parallel policy: skip if there's an active execution
    if (existing.parallel_policy === 'skip') {
      const activeCount = this.runDAO.countRunningBySchedule(id)
      if (activeCount > 0) {
        throw new SchedulerTriggerConflictError()
      }
    }

    const schedExecId = randomUUID()
    const now = new Date().toISOString()
    const tzOffset = this.getTimezoneOffset(existing.timezone)

    this.runDAO.insertTriggeredExecutionForManual(schedExecId, id, now, tzOffset, existing.timezone)

    // Dispatch the actual executor via the engine callback.
    if (this.callbacks.onTrigger) {
      try {
        this.callbacks.onTrigger(id, schedExecId)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        this.runDAO.updateExecutionStatusSimple(schedExecId, 'failed', `手动触发派发失败: ${msg}`)
        throw err
      }
    }

    return {
      execution_id: schedExecId,
      schedule_id: id,
      status: 'triggered',
      trigger_type: 'manual',
      triggered_at: now,
    }
  }

  // ── List Executions ───────────────────────────────────────────────

  getExecutions(
    jobId: string,
    params: ListExecutionsParams = {},
  ): PaginatedResponse<SchedulerExecution> {
    // Verify job exists
    const job = this.configDAO.findByIdRaw(jobId)
    if (!job) {
      throw new SchedulerJobNotFoundError()
    }

    const page = Math.max(1, params.page ?? 1)
    const limit = Math.min(100, Math.max(1, params.limit ?? 20))

    const result = this.runDAO.listExecutions(jobId, {
      status: params.status,
      page,
      limit,
    })

    const items = result.data.map((row) => this.enrichExecutionRow(row as unknown as ScheduleExecutionRow))

    return { items, total: result.total, page, limit }
  }

  // ── Get Single Execution ──────────────────────────────────────────

  getExecution(jobId: string, executionId: string): SchedulerExecution {
    const row = this.runDAO.findExecutionByJobAndId(jobId, executionId)

    if (!row) {
      throw new Error('Execution not found')
    }

    return this.enrichExecutionRow(row as unknown as ScheduleExecutionRow)
  }

  // ── Get Execution Log ─────────────────────────────────────────────

  getExecutionLog(
    executionId: string,
    offset = 0,
    limit = 1000,
  ): {
    content: string
    offset: number
    length: number
    total_size: number
    has_more: boolean
  } {
    const row = this.runDAO.findExecutionWithJobType(executionId)

    if (!row) {
      throw new Error('Execution not found')
    }

    let fullContent = ''

    if (row.job_type === 'agent') {
      fullContent = row.agent_output ?? ''
    } else {
      // Workflow type: read from linked execution's var_pool
      if (row.execution_id) {
        const execRow = this.runDAO.findExecutionVarPool(row.execution_id)
        fullContent = execRow?.var_pool ?? ''
      }
    }

    const totalSize = fullContent.length
    const sliced = fullContent.slice(offset, offset + limit)

    return {
      content: sliced,
      offset,
      length: sliced.length,
      total_size: totalSize,
      has_more: offset + limit < totalSize,
    }
  }

  // ── Audit Logs ────────────────────────────────────────────────────

  getAuditLogs(
    jobId: string,
    params: ListAuditLogsParams = {},
  ): PaginatedResponse<SchedulerAuditLog> {
    const result = this.runDAO.listSchedulerAuditLogs(jobId, {
      action: params.action,
      page: params.page,
      limit: params.limit,
    })

    const items: SchedulerAuditLog[] = result.data.map((row) => ({
      id: row.id,
      schedule_id: row.schedule_id ?? '',
      action: row.action as SchedulerAuditLog['action'],
      actor: row.actor,
      changes: safeJsonParse<SchedulerAuditLog['changes']>(row.changes, null),
      ip_address: row.ip_address,
      created_at: row.created_at,
    }))

    return { items, total: result.total, page: result.page, limit: result.pageSize }
  }

  // ── Schedule Workspaces ──────────────────────────────────────────

  getScheduleWorkspaces(
    scheduleId: string,
    params: { page?: number; limit?: number; status?: string } = {},
  ): { items: ScheduleWorkspaceRow[]; total: number; page: number; limit: number } {
    // Verify schedule exists
    const schedule = this.configDAO.findByIdRaw(scheduleId)
    if (!schedule) throw new SchedulerJobNotFoundError()

    const result = this.configDAO.findScheduleWorkspaces(scheduleId, {
      status: params.status,
      page: params.page,
      limit: params.limit,
    })

    return {
      items: result.data,
      total: result.total,
      page: result.page,
      limit: result.pageSize,
    }
  }

  getScheduleWorkspace(scheduleId: string, workspaceId: string): ScheduleWorkspaceRow | undefined {
    const row = this.configDAO.findScheduleWorkspace(scheduleId, workspaceId)
    return row ?? undefined
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private writeAuditLog(opts: {
    schedule_id: string
    action: string
    workspace_id?: string
    changes?: Record<string, unknown>
    actor?: string
    ip_address?: string
  }): void {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.runDAO.insertSchedulerAuditLog({
      id,
      schedule_id: opts.schedule_id,
      action: opts.action,
      changes: opts.changes ? JSON.stringify(opts.changes) : null,
      ip_address: opts.ip_address ?? null,
      workspace_id: opts.workspace_id ?? null,
      created_at: now,
      actor: opts.actor,
    })
  }

  private calculateNextTrigger(cron: string, tz: string): string | null {
    try {
      const interval = parseExpression(cron, { tz, currentDate: new Date() })
      return interval.next().toISOString()
    } catch {
      return null
    }
  }

  /**
   * 07 (G5): broadcast a schedule lifecycle transition on the global 'taskpool'
   * SSE channel. Mirrors WorkflowExecutor's emit shape (workflow-executor.ts:257)
   * so the /tasks kanban receives draft→queued and abort transitions in real
   * time instead of the 10s poll. No-op when no SSEService was injected.
   */
  private emitScheduleStatus(scheduleId: string, status: string): void {
    this.sse?.emit('taskpool', {
      event: 'schedule_status',
      data: { schedule_id: scheduleId, status },
    })
    // 03 (SG2): mirror the schedule transition onto the parent task's status +
    // emit task_status SSE. The listener self-filters by origin_type='task'
    // (cron/agent/manual/api schedules are no-ops). The schedule row is fetched
    // to pass origin_type/origin_id — origin_id IS the parent task id (S2).
    const schedule = this.configDAO.findByIdRaw(scheduleId)
    if (schedule && schedule.origin_type) {
      this.scheduleStatusListener?.onScheduleTransition({
        schedule_id: scheduleId,
        origin_type: schedule.origin_type as OriginType,
        origin_id: schedule.origin_id ?? '',
        status: status as ScheduleStatus,
      })
    }
  }

  private enrichJobRow(row: ScheduleRow): SchedulerJob {
    const config = safeJsonParse<JobConfig>(row.config, {
      schema_version: '2.0',
      type: 'workflow',
      workspace_spec: { org: row.org, projects: [] },
      workflow_chain: [],
      max_retain: row.max_retain,
    } as JobConfig)

    const lastExecution: SchedulerExecutionSummary | null = row.last_exec_status
      ? {
        status: mapExecutionStatus(row.last_exec_status),
        triggered_at: row.last_exec_triggered_at!,
        error_summary: row.last_exec_error_summary ?? null,
      }
      : null

    return {
      id: row.id,
      name: row.name,
      job_type: row.job_type as JobType,
      cron_expression: row.cron_expression,
      timezone: row.timezone,
      enabled: row.enabled === 1,
      org: row.org || undefined,
      config,
      parallel_policy: row.parallel_policy as 'allow' | 'wait' | 'skip',
      timeout_seconds: row.timeout_seconds,
      notify_on_failure: row.notify_on_failure === 1,
      description: row.description ?? undefined,
      max_retain: row.max_retain,
      version: row.version,
      consecutive_failures: row.consecutive_failures,
      next_trigger_at: row.next_trigger_at,
      last_execution: lastExecution,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      status: (row.status ?? 'queued') as ScheduleStatus,
      // SG1b (ticket 06): trigger_source + source_chat_session_id DROPPED from
      // schedules. The shared SchedulerJob type still carries trigger_source
      // (boundary: shared off-limits), so derive it from origin_type for the
      // DTO: cron → 'cron'; task/agent/manual/api → 'requirement' (v1 semantics
      // = "queue/claim-driven, not cron-driven"). source_chat_session_id is null
      // (no longer persisted; tasks table owns the chat-session back-ref).
      trigger_source: ((row.origin_type ?? 'cron') === 'cron' ? 'cron' : 'requirement') as TriggerSource,
      // 2026-08-29 (approach A): pass the authoritative polymorphic origin
      // through — the lossy trigger_source above collapses task/manual/api/agent
      // into 'requirement'; the scheduler UI needs origin_type for the 来源
      // badge + conditional toggle, and origin_id to deep-link task rows.
      origin_type: (row.origin_type ?? null) as OriginType | null,
      origin_id: row.origin_id ?? null,
      source_chat_session_id: null,
      claimed_at: row.claimed_at ?? null,
    }
  }

  private enrichExecutionRow(row: ScheduleExecutionRow): SchedulerExecution {
    return {
      id: row.id,
      schedule_id: row.schedule_id,
      status: mapExecutionStatus(row.status),
      trigger_type: row.trigger_type as 'scheduled' | 'manual' | 'retry',
      triggered_at: row.triggered_at,
      completed_at: row.completed_at,
      duration_ms: row.duration_ms,
      exit_code: row.exit_code,
      error_summary: row.error_summary,
      skip_reason: row.skip_reason,
      triggered_by: row.triggered_by,
      agent_output: row.agent_output,
      model_used: row.model_used,
      token_usage: usageFromLegacyJson(safeJsonParse<unknown>(row.token_usage, null)),
      metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
      created_at: row.created_at,
    }
  }

  private getTimezoneOffset(tz: string): string {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'shortOffset',
      })
      const parts = formatter.formatToParts(new Date())
      const tzPart = parts.find((p) => p.type === 'timeZoneName')
      return tzPart?.value ?? '+00:00'
    } catch {
      return '+00:00'
    }
  }
}
