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
  ScheduleStatus,
} from '@octopus/shared'
import { jobTypeSchema } from '@octopus/shared'
import { usageFromLegacyJson } from '../../db/dao/usage-mapping'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'
import type { ScheduleRowWithLastExec } from '../../db/dao/schedule-config-dao'
import { SSEService } from '../sse'
import { BUILTIN_JOB_ID_PREFIX } from './builtin-jobs'

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

/** 票05: the built-in jobs are the system's own housekeeping. Deleting
 *  `builtin-task-lifecycle` stops every 定时/周期 launch, and re-writing its config clobbers
 *  the handler pointer the executor resolves — neither is a job edit, so both are refused
 *  (the UI hiding the affordance is not a gate; the API answered DELETE anyway). */
export class SchedulerBuiltinJobProtectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulerBuiltinJobProtectedError'
  }
}

// Re-export for convenience
export { ConfigValidationError }

// ── JobDetail (composite view, ticket 10) ─────────────────────────────

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

// ── Zod Validation Schemas ───────────────────────────────────────────

const cronExpressionField = z.string().min(1).refine(
  (val) => { try { parseExpression(val); return true } catch { return false } },
  { message: '无效的 Cron 表达式' },
)

const createJobSchema = z.object({
  name: z.string().min(1).max(200),
  // jobTypeSchema, not a local enum: 'job' rows must be creatable/updateable through
  // the API too (the built-in seed is not a user-facing way to add a handler job).
  job_type: jobTypeSchema,
  cron_expression: cronExpressionField.nullable().optional(),
  timezone: z.string().refine(
    (val) => { try { new Intl.DateTimeFormat('en', { timeZone: val }); return true } catch { return false } },
    { message: '无效的 IANA 时区' },
  ).optional().default('Asia/Shanghai'),
  org: z.string().min(1).max(100).optional(),
  config: z.record(z.unknown()).optional(),
  parallel_policy: z.enum(['allow', 'wait', 'skip']).optional().default('skip'),
  timeout_seconds: z.number().int().min(60).max(86400).optional().default(3600),
  notify_on_failure: z.boolean().optional().default(false),
  description: z.string().max(1000).optional(),
}).superRefine((data, ctx) => {
  if (!data.cron_expression) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cron_expression is required',
      path: ['cron_expression'],
    })
  }
  if (!data.config) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'config is required',
      path: ['config'],
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
  parallel_policy: z.enum(['allow', 'wait', 'skip']).optional(),
  timeout_seconds: z.number().int().min(60).max(86400).optional(),
  notify_on_failure: z.boolean().optional(),
  description: z.string().max(1000).optional(),
})

// ── Row Types ────────────────────────────────────────────────────────

/** The job row as this service sees it: the `schedules` columns plus the four
 *  `last_exec_*` fields the correlated subqueries add. Aliased to the DAO's type instead
 *  of re-declared — the local copy here is exactly how 票06's 耗时 went missing: the DAO
 *  query grew a column, this interface did not, and nothing failed to say so. */
type ScheduleRow = ScheduleRowWithLastExec

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

  constructor(
    configDAO: ScheduleConfigDAO,
    runDAO: ScheduleRunDAO,
    sse?: SSEService,
  ) {
    this.configDAO = configDAO
    this.runDAO = runDAO
    this.sse = sse
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

    // A workspace-scoped view: schedules carry org, not workspace_id, so the filter maps
    // through the workspace's org. Restored verbatim after the 票03 sweep (the route has
    // always passed it; ListJobsParams now declares it instead of leaning on a cast).
    if (params.workspace_id) {
      conditions.push('s.org = (SELECT org FROM workspaces WHERE id = ?)')
      queryParams.push(params.workspace_id)
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

  createJob(input: CreateJobInput): SchedulerJob {
    const validated = createJobSchema.parse(input)

    const validatedConfig = validateConfig(validated.job_type, validated.config)

    // Derive org: explicit org param, or from workspace_spec in config, or empty
    const org = validated.org
      ?? (validatedConfig.type === 'workflow' ? validatedConfig.workspace_spec.org : '')

    // Check name uniqueness within org
    if (org) {
      if (this.configDAO.checkNameConflict(org, validated.name)) {
        throw new SchedulerJobConflictError(`调度名称 "${validated.name}" 已存在`)
      }
    }

    const cronExpression = validated.cron_expression!
    const nextTrigger = cronExpression
      ? this.calculateNextTrigger(cronExpression, validated.timezone)
      : null

    const id = randomUUID()
    const now = new Date().toISOString()
    const configJson = JSON.stringify(validatedConfig)

    // Derive max_retain from config for workflow jobs
    const maxRetain = validatedConfig.type === 'workflow' ? validatedConfig.max_retain : 10

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

    return job
  }

  // ── Update Job (optimistic locking) ──────────────────────────────

  updateJob(id: string, input: UpdateJobInput, version: number): SchedulerJob {
    const existing = this.configDAO.findByIdRaw(id) as unknown as ScheduleRow | undefined

    if (!existing) {
      throw new SchedulerJobNotFoundError()
    }

    if (existing.version !== version) {
      throw new SchedulerVersionConflictError()
    }

    const validated = updateJobSchema.parse(input)

    // A built-in row's config IS its handler pointer (`{handler, args}` — the code never
    // enters the DB). The edit form cannot express that shape, so submitting one writes an
    // agent/workflow config over it and the next fire dies in the registry lookup. Cron /
    // enabled / timeout / description stay editable — those are the user's to tune.
    if (id.startsWith(BUILTIN_JOB_ID_PREFIX) && validated.config !== undefined) {
      throw new SchedulerBuiltinJobProtectedError(
        '内置作业的配置（handler 指针）不可修改，可改的是 cron / 开关 / 超时 / 描述',
      )
    }

    let validatedConfig: JobConfig | undefined
    if (validated.config) {
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
        updateFields.config = JSON.stringify(validatedConfig)
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

    // 票05: the built-in jobs are the system's own housekeeping — the task-lifecycle one
    // IS every 定时/周期 launch. Deleting it is not "remove this job", it is "stop the
    // scheduler's reason for existing", and the UI only ever offers 暂停 for these rows.
    // Refused server-side, because the affordance being hidden is not a gate (the agent
    // that wired the menu found the API still answered DELETE for it).
    if (id.startsWith(BUILTIN_JOB_ID_PREFIX)) {
      throw new SchedulerBuiltinJobProtectedError(
        '内置作业不可删除，只能暂停（删除会停止全部定时/周期任务启动）',
      )
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

  // ── Abort Job (claimed/running → aborted) ───────────────────────
  // G4 (ticket 06): user-triggered abort. Terminal — checkStaleClaimed (engine)
  // filters status IN (claimed,running), so 'aborted' is never rolled back to
  // queued, breaking the stale→rollback→redispatch loop. The running-execution
  // cancel is best-effort.
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
    // 票03 (ADR-0021): the tasks.status mirror is gone with the listener. A schedule
    // status transition belongs to a job, and a job no longer has a task behind it —
    // the task's own status is written by the task-lifecycle job that owns its runs.
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
        duration_ms: row.last_exec_duration_ms ?? null,
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
