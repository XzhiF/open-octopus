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
} from '@octopus/shared'
import { ScheduleConfigDAO, ScheduleRunDAO } from '../../db/dao'

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

// Re-export for convenience
export { ConfigValidationError }

// ── Zod Validation Schemas ───────────────────────────────────────────

const createJobSchema = z.object({
  name: z.string().min(1).max(200),
  job_type: z.enum(['workflow', 'agent']),
  cron_expression: z.string().min(1).refine(
    (val) => {
      try { parseExpression(val); return true } catch { return false }
    },
    { message: '无效的 Cron 表达式' },
  ),
  timezone: z.string().refine(
    (val) => {
      try { new Intl.DateTimeFormat('en', { timeZone: val }); return true } catch { return false }
    },
    { message: '无效的 IANA 时区' },
  ),
  org: z.string().min(1).max(100).optional(),
  config: z.record(z.unknown()),
  parallel_policy: z.enum(['allow', 'wait', 'skip']).optional().default('skip'),
  timeout_seconds: z.number().int().min(60).max(86400).optional().default(3600),
  notify_on_failure: z.boolean().optional().default(false),
  description: z.string().max(1000).optional(),
})

const updateJobSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cron_expression: z.string().min(1).refine(
    (val) => {
      try { parseExpression(val); return true } catch { return false }
    },
    { message: '无效的 Cron 表达式' },
  ).optional(),
  timezone: z.string().refine(
    (val) => {
      try { new Intl.DateTimeFormat('en', { timeZone: val }); return true } catch { return false }
    },
    { message: '无效的 IANA 时区' },
  ).optional(),
  config: z.record(z.unknown()).optional(),
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
  cron_expression: string
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

  constructor(configDAO: ScheduleConfigDAO, runDAO: ScheduleRunDAO) {
    this.configDAO = configDAO
    this.runDAO = runDAO
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

    // Validate config against job type schema
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

    const id = randomUUID()
    const now = new Date().toISOString()
    const nextTrigger = this.calculateNextTrigger(validated.cron_expression, validated.timezone)
    const configJson = JSON.stringify(validatedConfig)

    // Derive max_retain from config for workflow jobs
    const maxRetain = validatedConfig.type === 'workflow' ? validatedConfig.max_retain : 10

    this.configDAO.transaction(() => {
      this.configDAO.insertSchedule({
        id, org, name: validated.name,
        cron_expression: validated.cron_expression, timezone: validated.timezone,
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
          cron_expression: { before: null, after: validated.cron_expression },
          timezone: { before: null, after: validated.timezone },
          org: { before: null, after: org },
        },
      })
    })

    this.notifyScheduleChange()
    return this.getJob(id)
  }

  // ── Get Job ───────────────────────────────────────────────────────

  getJob(id: string): SchedulerJob {
    const row = this.configDAO.getJobWithLastExec(id)

    if (!row) {
      throw new SchedulerJobNotFoundError()
    }

    return this.enrichJobRow(row)
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

    // Validate config if provided
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

    // Recalculate next_trigger_at when cron or timezone changes
    const effectiveCron = validated.cron_expression ?? existing.cron_expression
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
        const nextTrigger = existing.enabled === 1
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

    const now = new Date().toISOString()
    const newEnabled = existing.enabled === 1 ? 0 : 1
    const nextTrigger = newEnabled === 1
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
      token_usage: safeJsonParse<{ input: number; output: number } | null>(row.token_usage, null),
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
