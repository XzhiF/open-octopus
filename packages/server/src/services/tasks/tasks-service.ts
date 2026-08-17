// packages/server/src/services/tasks/tasks-service.ts
//
// TasksService — first-class `tasks` domain (v2-D1). Owns the
// draft→ready→running→done/failed/aborted lifecycle + task_spec (WHAT) +
// resource/skill bindings + the dispatch seam (ready → schedules envelope).
//
// S2 polymorphic origin: tasks has NO schedule_id. The link to schedules is
// via `schedules WHERE origin_type='task' AND origin_id=task.id` (02's
// findSchedulesByOrigin), maintained at the app level here (cascade-reap on
// delete/abort). The dispatch seam creates the schedules envelope(s):
//   simple (subunits.length < 2) → 1 schedule (origin_role='primary',
//     status='queued', config=materializeTaskSpecToConfig). Runs the task's
//     workflow_ref directly (skips coordinator-ws, ADR-0009).
//   composite (subunits.length >= 2) → 1 coordinator schedule
//     (origin_role='coordinator', status='queued', config=materialize with
//     workflow_chain[0].workflow_ref=composition-task). The N subunit
//     schedules (origin_role='subunit') are created at RUNTIME by
//     TaskDispatchService.dispatchChildSchedule (pause-resume bridge), not here.
//
// Concurrency: spec-field / PUT use TaskDAO.updateWithVersion (optimistic
// locking, 409 on stale version → agent re-GET + retry, v2-D12). The autosave
// seam (04) writes only name+updated_at via updateAutosave (no version bump,
// SG8) — separate concern, not here.

import { randomUUID } from "crypto"
import type Database from "better-sqlite3"
import {
  type TaskSpec,
  type TaskStatus,
  type TaskSpecField,
  type ResourceRef,
  type SubunitSpec,
  type ScheduleStatus,
  type OriginType,
  SPEC_FIELD_UPDATE_EVENT,
  TASK_STATUS_EVENT,
  taskSpecSchema,
  resourceRefSchema,
  subunitSpecSchema,
  integrationGoalSchema,
} from "@octopus/shared"
import {
  TaskDAO,
  ScheduleConfigDAO,
  AgentSessionDAO,
} from "../../db/dao"
import type { TaskRow, ScheduleRow } from "../../db/types"
import type { SSEService } from "../sse"
import { materializeTaskSpecToConfig } from "../scheduler/scheduler-service"

// ── Error Classes ────────────────────────────────────────────────────

export class TaskNotFoundError extends Error {
  constructor(message = "Task not found") {
    super(message)
    this.name = "TaskNotFoundError"
  }
}

export class TaskVersionConflictError extends Error {
  constructor(message = "Task version conflict (stale write)") {
    super(message)
    this.name = "TaskVersionConflictError"
  }
}

export class TaskStatusConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskStatusConflictError"
  }
}

export class TaskSpecFieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskSpecFieldError"
  }
}

// ── Types ────────────────────────────────────────────────────────────

/** A flat task DTO for API responses (JSON columns parsed). */
export interface TaskDTO {
  id: string
  org: string
  name: string
  status: TaskStatus
  task_spec: TaskSpec
  authoring_resources: ResourceRef[]
  resources: ResourceRef[]
  skills: string[]
  project_ids: string[]
  workflow_ref: string | null
  version: number
  source_chat_session_id: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/** Task detail (GET /:id) — task + child schedules via S2 origin lookup. */
export interface TaskDetailDTO extends TaskDTO {
  /** Child schedules dispatched by this task (origin_type='task',
   *  origin_id=task.id). Ordered by created_at ASC (dispatch order:
   *  primary/coordinator first, then subunits). Empty for a draft. */
  children: Array<{
    schedule_id: string
    name: string
    status: string
    origin_role: string | null
    workflow_ref: string | null
  }>
}

export interface CreateTaskInput {
  org: string
  name?: string
  source_chat_session_id?: string | null
}

export interface UpdateTaskInput {
  name?: string
  task_spec?: TaskSpec
  skills?: string[]
  project_ids?: string[]
  resources?: ResourceRef[]
  authoring_resources?: ResourceRef[]
  workflow_ref?: string | null
}

export interface UpdateSpecFieldInput {
  field: TaskSpecField
  value: unknown
}

export interface ListTasksParams {
  status?: TaskStatus
  org?: string
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toDTO(row: TaskRow): TaskDTO {
  return {
    id: row.id,
    org: row.org,
    name: row.name,
    status: row.status as TaskStatus,
    task_spec: parseJSON<TaskSpec>(row.task_spec, { goal: "", ac: [] } as unknown as TaskSpec),
    authoring_resources: parseJSON<ResourceRef[]>(row.authoring_resources, []),
    resources: parseJSON<ResourceRef[]>(row.resources, []),
    skills: parseJSON<string[]>(row.skills, []),
    project_ids: parseJSON<string[]>(row.project_ids, []),
    workflow_ref: row.workflow_ref,
    version: row.version,
    source_chat_session_id: row.source_chat_session_id,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  }
}

/** Validate a spec-field value against the per-field schema (v2-D12). Throws
 *  TaskSpecFieldError on invalid input so the route returns 400, not 500. */
function validateSpecFieldValue(field: TaskSpecField, value: unknown): unknown {
  switch (field) {
    case "goal":
      if (typeof value !== "string" || !value.trim()) {
        throw new TaskSpecFieldError("field 'goal' must be a non-empty string")
      }
      return value
    case "ac":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim())) {
        throw new TaskSpecFieldError("field 'ac' must be an array of non-empty strings")
      }
      return value
    case "subunits":
      if (!Array.isArray(value)) {
        throw new TaskSpecFieldError("field 'subunits' must be an array")
      }
      return value.map((v) => subunitSpecSchema.parse(v))
    case "integration_goal":
      return integrationGoalSchema.parse(value)
    case "resources":
    case "authoring_resources":
      if (!Array.isArray(value)) {
        throw new TaskSpecFieldError(`field '${field}' must be an array`)
      }
      return value.map((v) => resourceRefSchema.parse(v))
    case "skills":
    case "projects":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        throw new TaskSpecFieldError(`field '${field}' must be an array of strings`)
      }
      return value
    default:
      throw new TaskSpecFieldError(`unknown field: ${field as string}`)
  }
}

// ── Service ──────────────────────────────────────────────────────────

export class TasksService {
  private taskDAO: TaskDAO
  private scheduleDAO: ScheduleConfigDAO
  private agentSessionDAO: AgentSessionDAO | null
  private sse: SSEService

  constructor(
    db: Database.Database,
    sse: SSEService,
    agentSessionDAO?: AgentSessionDAO,
  ) {
    this.taskDAO = new TaskDAO(db)
    this.scheduleDAO = new ScheduleConfigDAO(db)
    this.agentSessionDAO = agentSessionDAO ?? null
    this.sse = sse
  }

  // ── Create ────────────────────────────────────────────────────────

  /** POST /api/tasks — explicit draft creation. The autosave seam (04) may
   *  also create a draft implicitly; both paths converge here. SG3: if a
   *  source_chat_session_id is provided, link the session's scope_id to the
   *  new task id (the autosave-seam writer is 04's job; this is the explicit
   *  POST path). */
  createTask(input: CreateTaskInput): TaskDTO {
    const id = randomUUID()
    const now = new Date().toISOString()
    const name = input.name?.trim() || "Untitled task"
    this.taskDAO.insert({
      id,
      org: input.org,
      name,
      status: "draft",
      source_chat_session_id: input.source_chat_session_id ?? null,
      created_at: now,
      updated_at: now,
    })
    // SG3: link the bound chat session's scope_id to the new task id (explicit
    // POST path). The autosave seam (04) does the same for the implicit path.
    if (input.source_chat_session_id && this.agentSessionDAO) {
      try {
        this.agentSessionDAO.updateSession(input.source_chat_session_id, { scope_id: id })
      } catch (err: unknown) {
        console.error(
          "[TasksService] createTask: failed to link session scope_id (non-fatal — task row created):",
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    const row = this.taskDAO.getById(id)
    if (!row) {
      throw new Error(`TasksService.createTask: inserted task ${id} not found`)
    }
    return toDTO(row)
  }

  // ── Read ──────────────────────────────────────────────────────────

  /** GET /api/tasks/:id — task + child schedules (S2 origin lookup). */
  getTask(id: string): TaskDetailDTO {
    const row = this.taskDAO.getById(id)
    if (!row) throw new TaskNotFoundError()
    const dto = toDTO(row)
    const children = this.scheduleDAO
      .findSchedulesByOrigin("task", id)
      .map((s) => ({
        schedule_id: s.id,
        name: s.name,
        status: s.status,
        origin_role: s.origin_role,
        workflow_ref: extractWorkflowRef(s.config),
      }))
    return { ...dto, children }
  }

  /** GET /api/tasks — list active tasks (kanban), filtered by status and/or org. */
  listTasks(params: ListTasksParams = {}): { items: TaskDTO[] } {
    let rows: TaskRow[]
    if (params.status && params.org) {
      // listByStatus doesn't filter by org — filter in memory (small N).
      rows = this.taskDAO.listByStatus(params.status).filter((r) => r.org === params.org)
    } else if (params.status) {
      rows = this.taskDAO.listByStatus(params.status)
    } else if (params.org) {
      rows = this.taskDAO.listByOrg(params.org)
    } else {
      // No filter — union of all active. listByOrg requires an org, so scan
      // all statuses (the kanban shows draft/ready/running/done/failed/aborted).
      rows = (
        ["draft", "ready", "running", "done", "failed", "aborted"] as TaskStatus[]
      ).flatMap((st) => this.taskDAO.listByStatus(st))
    }
    return { items: rows.map(toDTO) }
  }

  // ── Update ([save draft]) ─────────────────────────────────────────

  /** PUT /api/tasks/:id — update with If-Match optimistic locking. Only
   *  draft/ready tasks are editable (a running/done/failed/aborted task is
   *  immutable — the spec is frozen at dispatch time). */
  updateTask(id: string, input: UpdateTaskInput, expectedVersion: number): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (
      existing.status !== "draft" &&
      existing.status !== "ready"
    ) {
      throw new TaskStatusConflictError(
        `Cannot edit task in status '${existing.status}' (only draft/ready are editable)`,
      )
    }
    const fields: Record<string, unknown> = {}
    if (input.name !== undefined) fields.name = input.name
    if (input.task_spec !== undefined) {
      // Validate the full spec via Zod (throws ZodError → route 400).
      fields.task_spec = JSON.stringify(taskSpecSchema.parse(input.task_spec))
    }
    if (input.skills !== undefined) fields.skills = JSON.stringify(input.skills)
    if (input.project_ids !== undefined) fields.project_ids = JSON.stringify(input.project_ids)
    if (input.resources !== undefined) fields.resources = JSON.stringify(input.resources)
    if (input.authoring_resources !== undefined) {
      fields.authoring_resources = JSON.stringify(input.authoring_resources)
    }
    if (input.workflow_ref !== undefined) fields.workflow_ref = input.workflow_ref

    const result = this.taskDAO.updateWithVersion(id, fields, expectedVersion)
    if (result.changes === 0) throw new TaskVersionConflictError()

    const row = this.taskDAO.getById(id)
    if (!row) throw new TaskNotFoundError()
    return toDTO(row)
  }

  // ── spec-field tool endpoint ──────────────────────────────────────

  /** POST /api/tasks/:id/spec-field — the agent `update_task_spec_field`
   *  tool endpoint. Merges a single field into the right column, bumps
   *  version, emits spec_field_update SSE. Returns the new version.
   *  Stale version → 409 → agent re-GET + retry (v2-D12). */
  updateSpecField(id: string, input: UpdateSpecFieldInput): { version: number } {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (
      existing.status !== "draft" &&
      existing.status !== "ready"
    ) {
      throw new TaskStatusConflictError(
        `Cannot edit spec of a task in status '${existing.status}'`,
      )
    }
    const validatedValue = validateSpecFieldValue(input.field, input.value)

    const fields: Record<string, unknown> = {}
    const currentSpec = parseJSON<TaskSpec>(existing.task_spec, {
      goal: "",
      ac: [],
    } as unknown as TaskSpec)

    switch (input.field) {
      case "goal":
      case "ac":
      case "subunits":
      case "integration_goal":
        // Merge into task_spec JSON.
        fields.task_spec = JSON.stringify({ ...currentSpec, [input.field]: validatedValue })
        break
      case "skills":
        fields.skills = JSON.stringify(validatedValue)
        break
      case "projects":
        fields.project_ids = JSON.stringify(validatedValue)
        break
      case "resources":
        fields.resources = JSON.stringify(validatedValue)
        break
      case "authoring_resources":
        fields.authoring_resources = JSON.stringify(validatedValue)
        break
    }

    const result = this.taskDAO.updateWithVersion(id, fields, existing.version)
    if (result.changes === 0) throw new TaskVersionConflictError()

    const updated = this.taskDAO.getById(id)!
    // Emit spec_field_update SSE so the SpecPanel applies the field locally +
    // bumps its tracked version (avoids a subsequent [save] 409, v2-D12).
    this.sse.emit("taskpool", {
      event: SPEC_FIELD_UPDATE_EVENT,
      data: {
        task_id: id,
        field: input.field,
        value: validatedValue,
        version: updated.version,
      },
    })
    return { version: updated.version }
  }

  // ── Dispatch seam (ready → schedules envelope) ───────────────────

  /** POST /api/tasks/:id/ready — draft→ready + dispatch seam. Creates the
   *  schedules envelope (simple=1 primary; composite=1 coordinator). The
   *  task_spec is materialized into the schedule's config via the exported
   *  materializeTaskSpecToConfig (06 later drops task_spec from the output +
   *  injects subunit_count in the body; 03 only calls it). */
  readyTask(id: string): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "draft") {
      throw new TaskStatusConflictError(
        `Cannot ready a task in status '${existing.status}' (only draft→ready)`,
      )
    }

    const taskSpec = parseJSON<TaskSpec>(existing.task_spec, {
      goal: "",
      ac: [],
    } as unknown as TaskSpec)
    const projectIds = parseJSON<string[]>(existing.project_ids, [])
    const skills = parseJSON<string[]>(existing.skills, [])
    const subunits: SubunitSpec[] = taskSpec.subunits ?? []
    // SG9: composite requires subunits.length >= 2 (1-subunit → simple
    // workflow_chain). The materialize body's own threshold (06 changes it) is
    // not relied on here — the dispatch seam decides simple vs composite.
    const isComposite = subunits.length >= 2

    // Materialize the WorkflowConfig for the schedule envelope. The exported
    // function includes task_spec in the output (06 drops it); 03's
    // verification only checks origin_type='task' + status='queued'.
    const config = materializeTaskSpecToConfig(
      taskSpec,
      projectIds,
      existing.org,
      existing.workflow_ref ?? undefined,
      skills,
    )
    const configJson = JSON.stringify(config)
    const now = new Date().toISOString()

    const scheduleId = randomUUID()
    this.scheduleDAO.insertSchedule({
      id: scheduleId,
      org: existing.org,
      name: `task-${id}-${isComposite ? "coordinator" : "primary"}`,
      cron_expression: null,
      timezone: "UTC",
      job_type: "workflow",
      config: configJson,
      status: "queued",
      origin_type: "task",
      origin_id: id,
      origin_role: isComposite ? "coordinator" : "primary",
      created_at: now,
      updated_at: now,
    })

    // Flip the task to 'ready' (dispatch seam created the envelope; the runner
    // claims the schedule and the ScheduleStatusListener mirrors running).
    const result = this.taskDAO.updateWithVersion(id, { status: "ready" }, existing.version)
    if (result.changes === 0) throw new TaskVersionConflictError()

    const row = this.taskDAO.getById(id)!
    return toDTO(row)
  }

  // ── Abort (running → aborted + ws cleanup, v1 G4) ─────────────────

  /** POST /api/tasks/:id/abort — running→aborted. Finds all child schedules
   *  via S2 origin lookup, aborts each in-flight (claimed/running) schedule
   *  (delegating to the G4 cleanup primitive — markStaleExecutionsFailed +
   *  markScheduleWorkspacesCleanedBySchedule + best-effort execution cancel),
   *  and writes tasks.status='aborted' directly. Emits task_status SSE.
   *
   *  The schedule-level abort is best-effort: schedules already terminal
   *  (done/failed/aborted) are skipped. Schedules in queued status are
   *  flipped to aborted (never started, no ws to clean). */
  abortTask(id: string): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "running" && existing.status !== "ready") {
      throw new TaskStatusConflictError(
        `Cannot abort a task in status '${existing.status}' (only ready/running can be aborted)`,
      )
    }

    const now = new Date().toISOString()
    // Find all child schedules via S2 origin lookup + abort each.
    const children = this.scheduleDAO.findSchedulesByOrigin("task", id)
    for (const child of children) {
      this.abortChildSchedule(child, now)
    }

    // Write tasks.status='aborted' directly (no version bump — status change
    // is a system event, not a spec edit; mirrors the ScheduleStatusListener
    // pattern so the spec-field tool's optimistic concurrency is unaffected).
    this.taskDAO
      .getDb()
      .prepare(
        "UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run("aborted", now, now, id)

    // Emit task_status SSE so the kanban moves the card to aborted instantly.
    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: id, status: "aborted" },
    })

    const row = this.taskDAO.getById(id)!
    return toDTO(row)
  }

  /** Abort a single child schedule. claimed/running → aborted + G4 ws cleanup
   *  (markStaleExecutionsFailed releases the unique active index;
   *  markScheduleWorkspacesCleanedBySchedule marks in-flight ws as cleaned).
   *  queued → aborted (never started). Terminal → skip (idempotent). */
  private abortChildSchedule(child: ScheduleRow, now: string): void {
    const status = child.status as ScheduleStatus
    if (status === "done" || status === "failed" || status === "aborted") return
    if (status === "queued" || status === "draft") {
      this.scheduleDAO.updateSchedule(child.id, { status: "aborted", claimed_at: null })
      return
    }
    // claimed / running — full G4 cleanup.
    this.scheduleDAO.transaction(() => {
      this.scheduleDAO.updateSchedule(child.id, {
        status: "aborted",
        claimed_at: null,
      })
      this.scheduleDAO.markScheduleWorkspacesCleanedBySchedule(child.id, now)
    })
    // Mark in-flight schedule_executions failed (releases the partial unique
    // index idx_sched_execs_unique_active so the schedule can be re-dispatched).
    try {
      this.scheduleDAO
        .getDb()
        .prepare(
          "UPDATE schedule_executions SET status = 'failed', error_summary = ?, completed_at = ? WHERE schedule_id = ? AND status IN ('triggered', 'running')",
        )
        .run(`Aborted by task owner at ${now}`, now, child.id)
    } catch (err: unknown) {
      console.error(
        `[TasksService] abortChildSchedule: failed to mark executions failed for ${child.id} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
    // Best-effort: cancel the running workflow execution. Dynamic import to
    // avoid a static dependency cycle with execution-service-registry (mirrors
    // SchedulerService.abortJob). A missing/gone workspace must NOT block the
    // abort — the DB state above is already terminal.
    this.cancelRunningExecution(child.id).catch((err: unknown) => {
      console.error(
        `[TasksService] abortChildSchedule: cancel execution failed for ${child.id} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    })
  }

  private async cancelRunningExecution(scheduleId: string): Promise<void> {
    const exec = this.scheduleDAO.findActiveExecutions(scheduleId)[0]
    if (!exec) return
    const runDAO = this.scheduleDAO // same db handle; use a minimal lookup
    const row = (
      runDAO.getDb().prepare(
        "SELECT execution_id, workspace_id FROM schedule_executions WHERE id = ?",
      ).get(exec.id) as { execution_id: string | null; workspace_id: string | null } | undefined
    )
    if (!row?.execution_id || !row?.workspace_id) return
    try {
      const { getExecutionService } = await import("../execution-service-registry")
      const registry = getExecutionService(row.workspace_id)
      if (registry) {
        await registry.service.cancel(row.execution_id)
      }
    } catch {
      // non-fatal — DB state is already terminal
    }
  }

  // ── Delete (soft-delete + cascade-reap schedules) ──────────────────

  /** DELETE /api/tasks/:id — soft-delete (discard draft/ready). Cascade-reaps
   *  all child schedules via S2 origin lookup (R-INT: origin_id has no FK, so
   *  app-level integrity is the only guard against orphans). Only draft/ready
   *  tasks are discardable; a running task must be aborted first. */
  deleteTask(id: string): { ok: true } {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status === "running") {
      throw new TaskStatusConflictError(
        "Cannot delete a running task — abort it first",
      )
    }
    // Cascade-reap: soft-delete all child schedules (origin_type='task').
    const children = this.scheduleDAO.findSchedulesByOrigin("task", id)
    for (const child of children) {
      this.scheduleDAO.softDelete(child.id)
    }
    this.taskDAO.softDelete(id)
    return { ok: true }
  }
}

/** Extract workflow_ref from a schedule's config JSON (for the children[]
 * drill-down view). Returns null if the config is malformed or has no
 * workflow_chain (defensive — a corrupted config must not break GET /:id). */
function extractWorkflowRef(configJson: string): string | null {
  const config = parseJSON<{ workflow_chain?: Array<{ workflow_ref?: string }> }>(configJson, {})
  return config.workflow_chain?.[0]?.workflow_ref ?? null
}
