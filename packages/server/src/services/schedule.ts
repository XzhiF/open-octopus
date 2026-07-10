import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { parseExpression } from "cron-parser"
import cronstrue from "cronstrue"
import { z } from "zod"
import { WorkflowRef } from "@octopus/shared"
import { SSEService } from "./sse"
import { getExecutionService } from "./execution-service-registry"
import { ScheduleConfigDAO, ScheduleRunDAO, ExecutionDAO } from "../db/dao"

// ── Error Classes (type-safe HTTP status classification) ─────────────

export class ScheduleNotFoundError extends Error {
  constructor(message = "Schedule not found") { super(message); this.name = "ScheduleNotFoundError" }
}
export class ScheduleConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleConflictError" }
}

// ── Zod Validation Schemas ──────────────────────────────────────────

const createScheduleSchema = z.object({
  name: z.string().min(1).max(64),
  workflow_ref: WorkflowRef.zodSchema(),
  cron_expression: z.string().min(1).refine(
    (val) => { try { parseExpression(val); return true } catch { return false } },
    { message: "无效的 Cron 表达式" },
  ),
  timezone: z.string().refine(
    (val) => {
      try { new Intl.DateTimeFormat("en", { timeZone: val }); return true } catch { return false }
    },
    { message: "无效的 IANA 时区" },
  ),
  input_values: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().int().min(60).max(86400).optional().default(3600),
  notify_on_failure: z.boolean().optional().default(false),
  notify_channel: z.enum(["telegram", "slack"]).optional(),
  notify_target: z.string().max(255).optional(),
}).refine(
  (data) => !data.notify_on_failure || (data.notify_channel && data.notify_target),
  { message: "开启失败通知时必须指定渠道和目标" },
)

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  cron_expression: z.string().min(1).refine(
    (val) => { try { parseExpression(val); return true } catch { return false } },
    { message: "无效的 Cron 表达式" },
  ).optional(),
  timezone: z.string().refine(
    (val) => {
      try { new Intl.DateTimeFormat("en", { timeZone: val }); return true } catch { return false }
    },
    { message: "无效的 IANA 时区" },
  ).optional(),
  input_values: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().int().min(60).max(86400).optional(),
  notify_on_failure: z.boolean().optional(),
  notify_channel: z.enum(["telegram", "slack"]).optional(),
  notify_target: z.string().max(255).optional(),
})

// ── Row Types ────────────────────────────────────────────────────────

interface ScheduleRow {
  id: string
  workspace_id: string
  name: string
  workflow_ref: string
  cron_expression: string
  timezone: string
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
}

interface AuditLogRow {
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

// ── Enriched Return Types ────────────────────────────────────────────

interface ScheduleView {
  id: string
  workspace_id: string
  name: string
  workflow_ref: string
  cron_expression: string
  timezone: string
  input_values: Record<string, string>
  enabled: boolean
  timeout_seconds: number
  notify_on_failure: boolean
  notify_channel: string | null
  notify_target: string | null
  container_execution_id: string | null
  missed_alert_dismissed_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  next_trigger_at: string | null
  cron_description: string
  running_execution_count: number
  missed_execution_count: number
}

// ── WorkspaceScheduleService ──────────────────────────────────────────────────

export class WorkspaceScheduleService {
  private onScheduleChange?: () => void
  private configDAO: ScheduleConfigDAO
  private runDAO: ScheduleRunDAO
  private execDAO: ExecutionDAO

  constructor(
    private sse: SSEService,
    configDAO: ScheduleConfigDAO,
    runDAO: ScheduleRunDAO,
    execDAO: ExecutionDAO,
  ) {
    this.configDAO = configDAO
    this.runDAO = runDAO
    this.execDAO = execDAO
  }

  setOnScheduleChange(callback: () => void): void {
    this.onScheduleChange = callback
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  create(workspaceId: string, data: z.input<typeof createScheduleSchema>): ScheduleView {
    const validated = createScheduleSchema.parse(data)

    // Look up org from workspace for v23 org-scoped uniqueness
    const org = this.configDAO.findWorkspaceOrg(workspaceId) ?? ''

    // Check unique name within org (excluding soft-deleted)
    if (this.configDAO.checkNameConflict(org, validated.name)) {
      throw new ScheduleConflictError(`调度名称 "${validated.name}" 已存在`)
    }

    const id = randomUUID()
    const now = new Date().toISOString()
    const inputValues = JSON.stringify(validated.input_values ?? {})
    const nextTrigger = this.calculateNextTrigger(validated.cron_expression, validated.timezone)

    this.configDAO.transaction(() => {
      // Create container root execution first
      const containerId = this.ensureContainerExecution(workspaceId, validated.workflow_ref)

      // Insert schedule
      this.configDAO.insertWorkspaceSchedule({
        id, org, workspace_id: workspaceId, name: validated.name,
        workflow_ref: validated.workflow_ref,
        cron_expression: validated.cron_expression, timezone: validated.timezone,
        input_values: inputValues,
        timeout_seconds: validated.timeout_seconds,
        notify_on_failure: validated.notify_on_failure ? 1 : 0,
        notify_channel: validated.notify_channel ?? null,
        notify_target: validated.notify_target ?? null,
        container_execution_id: containerId,
        next_trigger_at: nextTrigger,
        created_at: now, updated_at: now,
      })

      // Write audit log inside transaction
      this.writeAuditLog("created", workspaceId, id, validated.name, {
        workflow_ref: validated.workflow_ref,
        cron_expression: validated.cron_expression,
        timezone: validated.timezone,
        timeout_seconds: validated.timeout_seconds,
        notify_on_failure: validated.notify_on_failure,
      })
    })

    this.onScheduleChange?.()
    return this.getById(workspaceId, id)!
  }

  list(
    workspaceId: string,
    query?: { search?: string; status?: string },
  ): ScheduleView[] {
    const rows = this.configDAO.listByWorkspace(workspaceId, query) as ScheduleRow[]
    return rows.map((row) => this.enrichRow(row))
  }

  getById(workspaceId: string, scheduleId: string): ScheduleView | undefined {
    const row = this.configDAO.findScheduleByWorkspace(scheduleId, workspaceId) as ScheduleRow | undefined

    if (!row) return undefined
    return this.enrichRow(row)
  }

  update(
    workspaceId: string,
    scheduleId: string,
    data: Partial<z.input<typeof createScheduleSchema>>,
  ): ScheduleView {
    const existing = this.configDAO.findScheduleByWorkspaceNotDeleted(scheduleId, workspaceId) as ScheduleRow | undefined

    if (!existing) {
      throw new ScheduleNotFoundError()
    }

    const validated = updateScheduleSchema.parse(data)
    const changes: Record<string, unknown> = {}

    // Determine effective cron/timezone for next_trigger recalculation
    const effectiveCron = validated.cron_expression ?? existing.cron_expression
    const effectiveTz = validated.timezone ?? existing.timezone

    // Check unique name if changing
    if (validated.name !== undefined && validated.name !== existing.name) {
      if (this.configDAO.checkNameConflictByWorkspace(workspaceId, validated.name, scheduleId)) {
        throw new ScheduleConflictError(`调度名称 "${validated.name}" 已存在`)
      }
    }

    // Build fields for update
    const updateFields: Record<string, unknown> = {}

    const fieldMap: Array<[keyof typeof validated, string]> = [
      ["name", "name"],
      ["cron_expression", "cron_expression"],
      ["timezone", "timezone"],
      ["timeout_seconds", "timeout_seconds"],
      ["notify_channel", "notify_channel"],
      ["notify_target", "notify_target"],
    ]

    for (const [key, col] of fieldMap) {
      const value = validated[key]
      if (value !== undefined) {
        updateFields[col] = value
        changes[col] = value
      }
    }

    // input_values needs JSON serialization
    if (validated.input_values !== undefined) {
      updateFields.input_values = JSON.stringify(validated.input_values)
      changes.input_values = validated.input_values
    }

    // notify_on_failure needs boolean-to-int conversion
    if (validated.notify_on_failure !== undefined) {
      updateFields.notify_on_failure = validated.notify_on_failure ? 1 : 0
      changes.notify_on_failure = validated.notify_on_failure
    }

    // Recalculate next_trigger_at when cron or timezone changes
    if (validated.cron_expression !== undefined || validated.timezone !== undefined) {
      const nextTrigger = this.calculateNextTrigger(effectiveCron, effectiveTz)
      updateFields.next_trigger_at = nextTrigger
    }

    if (Object.keys(updateFields).length === 0) {
      // Nothing changed
      return this.getById(workspaceId, scheduleId)!
    }

    this.configDAO.transaction(() => {
      this.configDAO.updateScheduleByWorkspace(scheduleId, workspaceId, updateFields)

      this.writeAuditLog("updated", workspaceId, scheduleId, existing.name, changes)
    })

    this.onScheduleChange?.()
    return this.getById(workspaceId, scheduleId)!
  }

  delete(workspaceId: string, scheduleId: string): void {
    const existing = this.configDAO.findScheduleByWorkspaceNotDeleted(scheduleId, workspaceId) as ScheduleRow | undefined

    if (!existing) {
      throw new ScheduleNotFoundError()
    }

    this.configDAO.transaction(() => {
      this.configDAO.softDeleteByWorkspace(scheduleId, workspaceId)

      this.writeAuditLog("deleted", workspaceId, scheduleId, existing.name)
    })

    this.onScheduleChange?.()
  }

  // ── Enable / Disable ──────────────────────────────────────────────

  enable(workspaceId: string, scheduleId: string): ScheduleView {
    return this.setEnabled(workspaceId, scheduleId, true)
  }

  disable(workspaceId: string, scheduleId: string): ScheduleView {
    return this.setEnabled(workspaceId, scheduleId, false)
  }

  // ── Trigger ───────────────────────────────────────────────────────

  trigger(
    workspaceId: string,
    scheduleId: string,
    triggerType: "manual" | "scheduled" | "retry" = "manual",
  ): ScheduleExecutionRow | null {
    const schedule = this.configDAO.findScheduleByWorkspaceNotDeleted(scheduleId, workspaceId) as ScheduleRow | undefined

    if (!schedule) {
      throw new ScheduleNotFoundError()
    }

    // Skip-if-running: check for any active execution + insert atomically in transaction
    const schedExecId = randomUUID()
    const now = new Date()
    const tzOffset = this.getTimezoneOffset(schedule.timezone)

    try {
      this.runDAO.insertExecution({
        id: schedExecId,
        schedule_id: scheduleId,
        execution_id: null,
        status: 'triggered',
        trigger_type: triggerType,
        triggered_at: now.toISOString(),
        timezone_offset: tzOffset,
        timezone_iana: schedule.timezone,
      })
    } catch (err: unknown) {
      // Unique constraint violation means a running execution already exists
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
        this.writeAuditLog("trigger_skipped", workspaceId, scheduleId, schedule.name, {
          reason: '已有执行正在运行，跳过本次触发（唯一约束）',
        })
        return null
      }
      throw err
    }

    // 2. Get ExecutionService for this workspace and start the workflow
    const registry = getExecutionService(workspaceId)
    if (!registry) {
      this.runDAO.updateExecutionStatusSimple(schedExecId, 'failed', 'Workspace ExecutionService unavailable')

      this.sse.emit(workspaceId, {
        event: "schedule_triggered",
        data: { schedule_id: scheduleId, execution_id: schedExecId, trigger_type: triggerType },
      })

      return this.runDAO.findExecutionById(schedExecId) as unknown as ScheduleExecutionRow
    }

    try {
      const inputValues = schedule.input_values ? JSON.parse(schedule.input_values) : {}
      const scheduleVars: Record<string, string> = {
        'schedule.id': schedule.id,
        'schedule.name': schedule.name,
        'schedule.triggered_at': now.toISOString(),
        'schedule.cron_expression': schedule.cron_expression,
        'schedule.timezone': schedule.timezone,
        'execution.trigger_type': triggerType,
      }

      // 3. Create actual execution via ExecutionService
      const execution = registry.service.create(workspaceId, {
        workflow_ref: schedule.workflow_ref,
        parent_id: schedule.container_execution_id ?? undefined,
        triggered_by: 'scheduler',
        input_values: inputValues,
        initial_var_pool: scheduleVars,
      })

      // 4. Link schedule_execution to execution
      this.runDAO.updateExecutionLinkId(schedExecId, execution.id)

      // 5. Register onComplete callback scoped to this execution
      const triggeredAt = now.getTime()
      registry.service.registerExternalCallbacks({
        onComplete: (() => {
          const durationMs = Date.now() - triggeredAt
          this.completeScheduleExecution(schedExecId, execution.id, durationMs)

          // Clean up callback to prevent memory leak
          registry.service.clearExternalCallbacks(execution.id)
        }) as any,
      }, execution.id)

      // 6. Update schedule_execution to 'running' BEFORE calling start()
      this.runDAO.markExecutionRunning(schedExecId)

      // 7. Start execution (async — catch both sync and async errors)
      let startPromise: Promise<void>
      try {
        startPromise = registry.service.start(execution.id, inputValues) as Promise<void>
      } catch (syncErr: unknown) {
        const message = syncErr instanceof Error ? syncErr.message : String(syncErr)
        console.error(`[WorkspaceScheduleService] trigger() synchronous start error for ${execution.id}:`, message)
        this.runDAO.markExecutionFailed(schedExecId, message, ['triggered', 'running'])
        registry.service.clearExternalCallbacks(execution.id)
        startPromise = Promise.resolve()
      }
      startPromise.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[WorkspaceScheduleService] trigger() execution ${execution.id} failed:`, message)
        this.runDAO.markExecutionFailed(schedExecId, message, ['running'])
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.runDAO.updateExecutionStatusSimple(schedExecId, 'failed', message)
    }

    // Broadcast SSE event
    this.sse.emit(workspaceId, {
      event: "schedule_triggered",
      data: { schedule_id: scheduleId, execution_id: schedExecId, trigger_type: triggerType },
    })

    return this.runDAO.findExecutionById(schedExecId) as unknown as ScheduleExecutionRow
  }

  retryExecution(
    workspaceId: string,
    scheduleId: string,
    executionId: string,
  ): ScheduleExecutionRow {
    const schedule = this.configDAO.findScheduleByWorkspaceNotDeleted(scheduleId, workspaceId) as ScheduleRow | undefined

    if (!schedule) {
      throw new ScheduleNotFoundError()
    }

    // Verify source execution exists
    const sourceExec = this.runDAO.findExecutionByJobAndId(scheduleId, executionId)

    if (!sourceExec) {
      throw new Error("执行记录不存在")
    }

    const retryId = randomUUID()
    const now = new Date()
    const tzOffset = this.getTimezoneOffset(schedule.timezone)

    // 1. Create schedule_execution record
    this.runDAO.insertExecution({
      id: retryId,
      schedule_id: scheduleId,
      execution_id: null,
      status: 'triggered',
      trigger_type: 'retry',
      triggered_at: now.toISOString(),
      timezone_offset: tzOffset,
      timezone_iana: schedule.timezone,
      retry_of: executionId,
    })

    // 2. Get ExecutionService and start retry execution
    const registry = getExecutionService(workspaceId)
    if (!registry) {
      this.runDAO.updateExecutionStatusSimple(retryId, 'failed', 'Workspace ExecutionService unavailable')

      return this.runDAO.findExecutionById(retryId) as unknown as ScheduleExecutionRow
    }

    try {
      const inputValues = schedule.input_values ? JSON.parse(schedule.input_values) : {}
      const scheduleVars: Record<string, string> = {
        'schedule.id': schedule.id,
        'schedule.name': schedule.name,
        'schedule.triggered_at': now.toISOString(),
        'schedule.cron_expression': schedule.cron_expression,
        'schedule.timezone': schedule.timezone,
        'execution.trigger_type': 'retry',
        'execution.retry_of': executionId,
      }

      const execution = registry.service.create(workspaceId, {
        workflow_ref: schedule.workflow_ref,
        parent_id: schedule.container_execution_id ?? undefined,
        triggered_by: 'scheduler',
        input_values: inputValues,
        initial_var_pool: scheduleVars,
      })

      this.runDAO.updateExecutionLinkId(retryId, execution.id)

      const triggeredAt = now.getTime()
      registry.service.registerExternalCallbacks({
        onComplete: (() => {
          const durationMs = Date.now() - triggeredAt
          this.completeScheduleExecution(retryId, execution.id, durationMs)

          registry.service.clearExternalCallbacks(execution.id)
        }) as any,
      }, execution.id)

      // Update schedule_execution to 'running' BEFORE calling start()
      this.runDAO.markExecutionRunning(retryId)

      // Start execution (async — catch errors to prevent unhandled rejections)
      registry.service.start(execution.id, inputValues).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[WorkspaceScheduleService] retryExecution ${execution.id} failed:`, message)
        this.runDAO.markExecutionFailed(retryId, message, ['running'])
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.runDAO.updateExecutionStatusSimple(retryId, 'failed', message)
    }

    return this.runDAO.findExecutionById(retryId) as unknown as ScheduleExecutionRow
  }

  // ── Execution History ─────────────────────────────────────────────

  listExecutions(
    workspaceId: string,
    scheduleId: string,
    query?: { page?: number; limit?: number },
  ): { items: ScheduleExecutionRow[]; total: number; page: number; limit: number } {
    const page = Math.max(1, query?.page ?? 1)
    const limit = Math.min(100, Math.max(1, query?.limit ?? 20))
    const offset = (page - 1) * limit

    // Verify schedule belongs to workspace
    const schedule = this.configDAO.findScheduleByWorkspace(scheduleId, workspaceId)

    if (!schedule) {
      return { items: [], total: 0, page, limit }
    }

    const total = this.runDAO.countExecutionsBySchedule(scheduleId)

    const items = this.runDAO.findExecutionsBySchedulePaginated(scheduleId, limit, offset) as unknown as ScheduleExecutionRow[]

    return { items, total, page, limit }
  }

  // ── Alert Management ──────────────────────────────────────────────

  dismissAlert(workspaceId: string, scheduleId: string): void {
    this.configDAO.updateDismissAlert(scheduleId, workspaceId)
  }

  // ── Emergency Stop ────────────────────────────────────────────────

  emergencyStop(workspaceId: string): { disabled_count: number } {
    const disabledCount = this.configDAO.transaction(() => {
      const count = this.configDAO.emergencyStopByWorkspace(workspaceId)

      if (count > 0) {
        this.writeAuditLog("emergency_stop", workspaceId, undefined, undefined, {
          disabled_count: count,
        })
      }

      return count
    })

    this.onScheduleChange?.()
    return { disabled_count: disabledCount }
  }

  // ── Audit Logs ────────────────────────────────────────────────────

  listAuditLogs(
    workspaceId: string,
    query?: { page?: number; limit?: number; scheduleId?: string },
  ): { items: AuditLogRow[]; total: number; page: number; limit: number } {
    const result = this.runDAO.listScheduleAuditLogs(workspaceId, {
      scheduleId: query?.scheduleId,
      page: query?.page,
      limit: query?.limit,
    })

    return {
      items: result.data as unknown as AuditLogRow[],
      total: result.total,
      page: result.page,
      limit: result.pageSize,
    }
  }

  // ── Permissions ───────────────────────────────────────────────────

  getPermissions(_workspaceId: string): Record<string, boolean> {
    // V1: all permissions granted
    return {
      can_create: true,
      can_update: true,
      can_delete: true,
      can_enable_disable: true,
      can_trigger: true,
      can_view_audit_logs: true,
      can_emergency_stop: true,
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private completeScheduleExecution(schedExecId: string, executionId: string, durationMs: number): void {
    const statusRow = this.execDAO.findExecutionStatus(executionId)
    const status = statusRow?.status ?? 'completed'

    if (status === 'completed') {
      this.runDAO.markExecutionCompleteWithDuration(schedExecId, 'completed', durationMs)
    } else {
      const errorSummary = this.execDAO.findFirstNodeError(executionId) ?? 'Execution failed'
      this.runDAO.markExecutionCompleteWithDuration(schedExecId, 'failed', durationMs, errorSummary)
    }
  }

  private writeAuditLog(
    action: string,
    workspaceId: string,
    scheduleId?: string,
    scheduleName?: string,
    changes?: Record<string, unknown>,
  ): void {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.runDAO.insertScheduleAuditLog({
      id,
      action,
      actor_id: null,
      schedule_id: scheduleId ?? null,
      schedule_name: scheduleName ?? null,
      workspace_id: workspaceId,
      changes: changes ? JSON.stringify(changes) : null,
      created_at: now,
    })
  }

  private calculateNextTrigger(cron: string, tz: string): string | null {
    try {
      const interval = parseExpression(cron, {
        tz,
        currentDate: new Date(),
      })
      return interval.next().toISOString()
    } catch {
      return null
    }
  }

  private ensureContainerExecution(workspaceId: string, workflowRef: string): string {
    const containerId = randomUUID()
    const now = new Date().toISOString()
    const org = this.configDAO.findWorkspaceOrg(workspaceId) ?? "unknown"

    this.execDAO.insertContainerExecution(containerId, workspaceId, workflowRef, org, now)

    return containerId
  }

  private setEnabled(workspaceId: string, scheduleId: string, enabled: boolean): ScheduleView {
    const existing = this.configDAO.findScheduleByWorkspaceNotDeleted(scheduleId, workspaceId) as ScheduleRow | undefined

    if (!existing) {
      throw new ScheduleNotFoundError()
    }

    // Recalculate next_trigger_at when re-enabling
    const nextTrigger = enabled
      ? this.calculateNextTrigger(existing.cron_expression, existing.timezone)
      : null

    this.configDAO.transaction(() => {
      this.configDAO.updateEnabledByWorkspace(scheduleId, workspaceId, enabled ? 1 : 0, nextTrigger)

      this.writeAuditLog(
        enabled ? "enabled" : "disabled",
        workspaceId,
        scheduleId,
        existing.name,
        { enabled },
      )
    })

    this.onScheduleChange?.()
    return this.getById(workspaceId, scheduleId)!
  }

  private enrichRow(row: ScheduleRow): ScheduleView {
    let cronDescription: string
    try {
      cronDescription = cronstrue.toString(row.cron_expression)
    } catch {
      cronDescription = row.cron_expression
    }

    const runningCount = this.runDAO.countRunningBySchedule(row.id)

    const missedCount = this.runDAO.countMissedBySchedule(row.id)

    return {
      id: row.id,
      workspace_id: row.workspace_id,
      name: row.name,
      workflow_ref: row.workflow_ref,
      cron_expression: row.cron_expression,
      timezone: row.timezone,
      input_values: safeJsonParse<Record<string, string>>(row.input_values, {}),
      enabled: row.enabled === 1,
      timeout_seconds: row.timeout_seconds,
      notify_on_failure: row.notify_on_failure === 1,
      notify_channel: row.notify_channel,
      notify_target: row.notify_target,
      container_execution_id: row.container_execution_id,
      missed_alert_dismissed_at: row.missed_alert_dismissed_at,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_trigger_at: row.next_trigger_at,
      cron_description: cronDescription,
      running_execution_count: runningCount,
      missed_execution_count: missedCount,
    }
  }

  private getTimezoneOffset(tz: string): string {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "shortOffset",
      })
      const parts = formatter.formatToParts(new Date())
      const tzPart = parts.find((p) => p.type === "timeZoneName")
      return tzPart?.value ?? "+00:00"
    } catch {
      return "+00:00"
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
