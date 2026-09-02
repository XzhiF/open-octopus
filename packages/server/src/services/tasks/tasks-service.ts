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
import fs from "fs"
import path from "path"
import type Database from "better-sqlite3"
import {
  type TaskSpec,
  type TaskStatus,
  type TaskSpecField,
  type ResourceRef,
  type SubunitSpec,
  type ScheduleStatus,
  type OriginType,
  type ArtifactIndexEntry,
  SPEC_FIELD_UPDATE_EVENT,
  TASK_ARTIFACTS_UPDATE_EVENT,
  TASK_STATUS_EVENT,
  TASK_TRIGGER_EVENT,
  PHASE_STATUS_UPDATE_EVENT,
  type TaskPhaseStatus,
  taskSpecSchema,
  validateSpecFieldValue,
  TaskSpecFieldError,
} from "@octopus/shared"
import {
  TaskDAO,
  ScheduleConfigDAO,
  ScheduleRunDAO,
  AgentSessionDAO,
  AcceptanceDAO,
} from "../../db/dao"
import type { TaskRow, ScheduleRow, ScheduleExecutionRow } from "../../db/types"
import type { SSEService } from "../sse"
// task-phase-redesign (ticket 07): the acceptance API and the GET /:id view read
// state THROUGH ticket 03's pure derivation — never a re-implementation of its
// matrix (K3 派生不存, 唯一真相).
import { deriveTaskView, type TaskView, type TaskPhaseView, type DeriveExecutionInput } from "./derive-task-view"
import { materializeTaskSpecToConfig } from "../scheduler/scheduler-service"
import type { TaskV4PhaseConfig } from "../scheduler/scheduler-service"
// task-phase-redesign (ticket 05): STATIC registry access for dispatchPhaseRound.
// Cycle-free: execution-service-registry's closure (execution/workspace/workflow/
// builtin-workflow/sse/observability/dao/resource-registry) never imports
// tasks-service (verified 2026-09-03 — its importers are index/routes/clone/
// scheduler-service/task-ws-name only). The dynamic form used by
// cancelRunningExecution defeats vi.mock (ticket 05 harness finding), so the
// dispatch path deliberately avoids it.
import { getExecutionService } from "../execution-service-registry"
import { TaskHomeService } from "./task-home-service"
import type { ProjectRef } from "./task-home-service"
// task-phase-redesign (ticket 06): the one-way artifact loop (K9/K10/K16).
import { seedPhaseToWorkspace, collectFromWorkspace, batchRelPath, resolvePhaseSpecDir, emitPhaseAwaitingReview, isV4TaskSpec } from "./task-artifact-sync"
// task-phase-redesign (ticket 08): the archiving orchestrator (K11 归并面).
import { createTaskArchiver, type TaskArchiver, type ArchiveReport } from "./archiving-service"
import { PluginMaterializer } from "./plugin-materializer"
// 06: re-export so the route's classifyError instanceof check matches throws
// from TaskHomeService.readArtifactContent without a second class declaration.
export { ArtifactAccessError } from "./task-home-service"
import { getResourceRegistry } from "../resource-registry"
import { WorkspaceGit } from "../workspace-git"
import { BuiltInWorkflowService } from "../builtin-workflow"
// task-workflow-handoff (ADR-0013): shared resolver for bind/ready/view.
import { resolveWorkflowRef, isWorkflowRefResolvable } from "./workflow-ref-resolver"
import type { WorkflowResolverDeps } from "./workflow-ref-resolver"
// task-workflow-presets (T5): template resolver for required inputs check.
import { resolveInputValues, parseWorkflowInputDefs } from "../scheduler/template-resolver"

/** Default task name when the caller provides none. NOT user-owned — the
 *  autosave seam (routes/clone/autosave.ts) may still adopt a smart title
 *  while the name equals this. A user rename (header/POST) makes the name
 *  user-owned and freezes it against autosave. */
export const DEFAULT_TASK_NAME = "Untitled task"
import {
  setSpecNotice,
  getSpecNotice,
} from "./spec-notice-store"

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

// 05 (SW-BP3): the server re-exports shared's canonical TaskSpecFieldError so
// the route's `instanceof` check stays a single-class match whether the throw
// comes from the shared validateSpecFieldValue (the 9 shared fields incl.
// `decisions`) or from the server-side goal_confirmed/ac_confirmed validation
// below. Do not declare a separate server class — two classes would let a
// shared-thrown 400 fall through to 500.
export { TaskSpecFieldError }

/** 04 (SW-BP9): thrown by {@link TasksService.updateTask} when a PUT attempts to
 *  change `skill_groups` or `task_type` (locked at creation per ADR-0012). The
 *  route maps it to 409 so the UI can show "locked" without a stale-version
 *  retry storm. Do NOT reuse TaskStatusConflictError for this — it's not a
 *  status conflict, it's an immutability contract (clearer message + intent). */
export class TaskLockViolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskLockViolationError"
  }
}

/** 05 (D18): thrown by {@link TasksService.readyTask} when a v3 task's
 *  confirmation gate fails (goal empty / ac<1 / goal_confirmed!==true / an ac
 *  item not in ac_confirmed). Carries the `missing` list so the route can
 *  return 409 + a missing-items payload (US6: the user sees exactly what to
 *  confirm before enqueue). */
export class TaskReadyGateError extends Error {
  constructor(
    message: string,
    public missing: string[],
  ) {
    super(message)
    this.name = "TaskReadyGateError"
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
  /** v39 board enrichment (root schedule join): parked('draft')/armed('queued')
   *  /'claimed'/'running' root status — lets the kanban render the
   *  「已排队 · … 触发」 badge while the task is mirrored 'running'. */
  schedule_status?: string | null
  /** v39 — root schedule's one-shot due time (ISO). Null = parked/immediate. */
  scheduled_at?: string | null
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
    /** v39 — one-shot due time for this schedule row (root rows carry the
     *  trigger; children created at runtime keep it null until due-set). */
    scheduled_at: string | null
    /** Task board 弹窗优化 (2026-08-29): the schedule's workspace (schedules.
     *  workspace_id FK) — null until the runner provisions one. Together with
     *  execution_ref.execution_id this is the deep-link pair for
     *  /workspaces/{ws}?tab=detail&execId={exec}. */
    workspace_id: string | null
    /** Compact summary of the LATEST schedule_executions row (triggered_at
     *  DESC), or null before the first run. agent_output/token_usage are NOT
     *  inlined (can be large) — the modal fetches them on demand via
     *  GET /api/scheduler/jobs/{schedule_id}/executions/{id}. */
    execution_ref: {
      id: string
      status: string
      execution_id: string | null
      /** Per-run workspace (schedule_executions.workspace_id) — the precise
       *  deep-link target while/after a run. */
      workspace_id: string | null
      triggered_at: string
      completed_at: string | null
      duration_ms: number | null
      error_summary: string | null
    } | null
  }>
  /** task-phase-redesign (ticket 07, spec API table 「GET /:id 增 phases 视图」):
   *  deriveTaskView's output embedded VERBATIM (no field renaming, no re-derivation).
   *  v4: `{ taskStatus: <derived>, isV4: true, phaseViews: [...] }`; non-v4:
   *  `{ taskStatus: <persisted mirror>, isV4: false, phaseViews: [] }` — the
   *  field is ALWAYS present so 票 11/12 can render one code path. */
  derived: TaskView
}

// ── Acceptance (task-phase-redesign ticket 07 — 验收 Gate K6/K7) ─────

/** Body of POST /api/tasks/:id/acceptance (spec API table). Indices are
 *  1-based, matching TaskPhase.index / executions.phase_index. */
export interface AcceptanceInput {
  phase_index: number
  round_index: number
  decision: "accepted" | "rejected"
  /** K7: 打回必填反馈文本（route 的 zod 拦空）；accepted 时忽略。 */
  feedback?: string
}

/** What the caller (票 12 dialog) must do next:
 *  - "dispatched"               a new round is already running (advance or retry)
 *  - "archiving"                last phase accepted — the task is in 归档 (票 08)
 *  - "awaiting_manual_trigger"  accepted with autoAdvance=false — parked at the
 *                               human gate (K6/US11), nothing was started. */
export type AcceptanceNextAction = "dispatched" | "archiving" | "awaiting_manual_trigger"

/** Round identity that {@link TasksService.acceptance} actually dispatched
 *  (present iff next_action === "dispatched"). */
export interface AcceptanceDispatch {
  schedule_id: string
  execution_id: string
  workspace_id: string
  phase_index: number
  round_index: number
}

export interface AcceptanceResult {
  /** Fresh detail view (children + `derived`) AFTER the decision was applied. */
  task: TaskDetailDTO
  next_action: AcceptanceNextAction
  dispatch?: AcceptanceDispatch
  /** The ledger row this call appended (traceability handle for the UI). */
  acceptance_id: string
}

export interface CreateTaskInput {
  org: string
  name?: string
  source_chat_session_id?: string | null
  // ── task-authoring v3 (ticket 04, D13/D15) ──
  /** Template selected on the template page. Present ⇒ v3 two-phase-flow task
   *  (home created, skill_groups materialized, ready-gate applies). Absent ⇒
   *  legacy/v2 create (no home, no gate — backward compat with the existing
   *  tasks-routes.test.ts POST cases). */
  task_type?: "coding" | "generic"
  /** Skill groups chosen at creation then LOCKED (ADR-0012). Default []. NOT
   *  written into authoring_resources (D4 — that would trigger the augmenter's
   *  full-text injection, double-loading skills already in the per-task plugin
   *  dir). The "default" group is an empty marker (D17) — not materialized. */
  skill_groups?: string[]
  /** Coding-template preset (D13): org + projects only (skills belong to
   *  workflow.requires, not the preset). preset.org overrides the top-level org
   *  when present (the template page is the source of the authoring context). */
  preset?: { org?: string; projects?: string[] }
}

export interface UpdateTaskInput {
  name?: string
  /** RAW (unparsed) task_spec from the PUT body. The service validates
   *  (taskSpecSchema.parse) AND applies the SW-BP9 lock (reject skill_groups /
   *  task_type changes) AND merge-preserves locked fields when the body omits
   *  them — a route-side parse would default absent skill_groups→[] and clobber
   *  the locked value (SW-BP2). Other fields (skills/project_ids/resources) stay
   *  route-parsed; only task_spec is service-owned for the lock+merge logic. */
  task_spec?: unknown
  skills?: string[]
  project_ids?: string[]
  resources?: ResourceRef[]
  authoring_resources?: ResourceRef[]
  workflow_ref?: string | null
}

export interface UpdateSpecFieldInput {
  field: ServerSpecField
  value: unknown
  /** 05 (SW-BP4): who is setting this field. `"user"` (direct SpecPanel edit)
   *  → the service records an @@spec_updated notice so the agent reconciles on
   *  its next chat turn (the clone send path delivers + clears it). `"agent"`
   *  (the default — also when omitted, AC5) does NOT set a notice, so the agent
   *  never sees its own edit echoed back as a user override. */
  source?: "user" | "agent"
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

/** Server-side spec-field set: the shared bindable fields (9 as of v3, +11 with
 *  ticket 07's `phases` — via {@link validateSpecFieldValue}) PLUS the two v3
 *  confirmation gates
 *  `goal_confirmed` / `ac_confirmed` (D18). The latter live in taskSpecSchema
 *  (storage — ticket 01) but are intentionally NOT in the shared
 *  TaskSpecFieldSchema enum (spec line 94 only adds `decisions` there); their
 *  value validation is ticket 05's lane, server-side. */
export type ServerSpecField = TaskSpecField | "goal_confirmed" | "ac_confirmed"

/** Validate a spec-field value. Delegates to the shared canonical
 *  {@link validateSpecFieldValue} for the shared fields (incl. `decisions`,
 *  SW-BP3, and ticket 07's `phases`) so the contract stays single-sourced, and validates the two
 *  confirmation gates server-side (boolean / string[]). Throws
 *  {@link TaskSpecFieldError} on invalid input so the route returns 400. */
function validateServerSpecField(field: ServerSpecField, value: unknown): unknown {
  switch (field) {
    case "goal_confirmed":
      if (typeof value !== "boolean") {
        throw new TaskSpecFieldError("field 'goal_confirmed' must be a boolean")
      }
      return value
    case "ac_confirmed":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim())) {
        throw new TaskSpecFieldError("field 'ac_confirmed' must be an array of non-empty strings")
      }
      return value
    default:
      // Shared field (incl. decisions) — canonical validator in shared.
      return validateSpecFieldValue(field, value)
  }
}

// ── Service ──────────────────────────────────────────────────────────

export class TasksService {
  /** ticket 08: the shared handle (the archiver is built lazily against it —
   *  same DAO-per-handle pattern as the constructor below). */
  private db: Database.Database
  private taskDAO: TaskDAO
  private scheduleDAO: ScheduleConfigDAO
  /** 弹窗优化: latest-run summary per child schedule (schedule_executions). */
  private runDAO: ScheduleRunDAO
  private agentSessionDAO: AgentSessionDAO | null
  private sse: SSEService
  /** 04 — home + plugin materialization (per-task plugin dir, ADR-0010). Injected
   *  so tests use a temp baseDir + temp ResourceManager; production omits them and
   *  the materializer is lazily resolved against the global ResourceManager singleton
   *  (so a test that never hits the v3 create path doesn't construct the global RM). */
  private taskHomeService: TaskHomeService
  private pluginMaterializer: PluginMaterializer | null
  /** task-workflow-handoff (ADR-0013): workflow_ref resolver dependency. Injected
   *  so tests can stub the builtin branch (a stub map, not the real
   *  ResourceManager); production injects the global BuiltInWorkflowService.
   *  Optional: when null, only the task-home branch of the resolution set is
   *  checked — backward-compatible with ad-hoc callers that don't wire it. */
  private builtInWorkflowService: BuiltInWorkflowService | null
  /** task-phase-redesign (ticket 07): the append-only 验收 ledger (schema v40).
   *  Constructed from the same handle as the other DAOs — no new ctor param
   *  (SW-BP15 discipline: tail-appended params only). */
  private acceptanceDAO: AcceptanceDAO

  /** v39: late-bound hook to SchedulerEngine.wake() (engine is constructed
   *  AFTER this service in index.ts — setter injection, same precedent as
   *  schedulerService.setCallbacks). Called by triggerTask for sub-second
   *  claim pickup. Optional: tests/ad-hoc callers without wiring just fall
   *  back to the 60s auxiliary tick. */
  private wakeScheduler?: () => void

  /** task-phase-redesign (ticket 07 → 票 08): late-bound archiving orchestrator.
   *  `acceptance` on the LAST phase flips the persisted status to 'archiving'
   *  and calls this hook; the orchestrator (ADR 顺延 / CONTEXT append / commit /
   *  PR → done, 票 08) is wired from index.ts and owns its own failure semantics
   *  (a failed archive leaves the task parked in 'archiving', retryable — K3/US15).
   *  Unwired (tests, ad-hoc embedders) ⇒ the status flip alone stands. */
  private archivingHook?: (taskId: string) => void | Promise<void>

  setWakeScheduler(fn: () => void): void {
    this.wakeScheduler = fn
  }

  setArchivingHook(fn: (taskId: string) => void | Promise<void>): void {
    this.archivingHook = fn
  }

  constructor(
    db: Database.Database,
    sse: SSEService,
    agentSessionDAO?: AgentSessionDAO,
    // SW-BP15: tail-appended, never reorder the existing params (would break the
    // 22 tasks-routes + tasks-v3-gates callers that pass only db/sse/agentDAO).
    taskHomeService?: TaskHomeService,
    pluginMaterializer?: PluginMaterializer,
    // task-workflow-handoff (ADR-0013): tail-appended so existing callers are
    // undisturbed. When omitted, the resolver's built-in branch is null (only
    // task-home branch checked). index.ts passes the real BuiltInWorkflowService.
    builtInWorkflowService?: BuiltInWorkflowService | null,
  ) {
    this.db = db
    this.taskDAO = new TaskDAO(db)
    this.scheduleDAO = new ScheduleConfigDAO(db)
    this.runDAO = new ScheduleRunDAO(db)
    this.agentSessionDAO = agentSessionDAO ?? null
    this.sse = sse
    this.taskHomeService = taskHomeService ?? new TaskHomeService()
    this.pluginMaterializer = pluginMaterializer ?? null
    this.builtInWorkflowService = builtInWorkflowService ?? null
    this.acceptanceDAO = new AcceptanceDAO(db)
  }

  /** Build the resolver deps for a given taskId (ADR-0013). Shared by the
   *  bind-fail-fast (updateSpecField), the ready-gate upgrade, and the view
   *  endpoint (GET /:id/workflow-ref). */
  private resolverDeps(taskId: string): WorkflowResolverDeps {
    return {
      builtIn: this.builtInWorkflowService,
      taskHome: this.taskHomeService,
      taskId,
    }
  }

  /** Lazily resolve the PluginMaterializer against the global ResourceManager
   *  singleton. Only called on the v3 create path (task_type set + non-empty
   *  non-default skill_groups); tests inject their own materializer so this path
   *  is never hit in the test suite. The static import of getResourceRegistry
   *  does NOT construct the singleton — only the `.get()` call here does, and
   *  that runs only when no materializer was injected (the production index.ts
   *  injects one, so this is a defensive fallback for ad-hoc callers). */
  private resolveMaterializer(): PluginMaterializer {
    if (this.pluginMaterializer) return this.pluginMaterializer
    this.pluginMaterializer = new PluginMaterializer(getResourceRegistry().get())
    return this.pluginMaterializer
  }

  /** Resolve project names to ProjectRef[] with filesystem paths via
   *  WorkspaceGit (repos/index.md lookup). Unresolvable names get
   *  { name, path: undefined } so they still appear in context.md. */
  private resolveProjectRefs(org: string, names: string[]): ProjectRef[] {
    if (!org || names.length === 0) return []
    const git = new WorkspaceGit()
    return names.map((name) => {
      try {
        const resolved = git.resolveRepoPath(org, name)
        return { name, path: resolved }
      } catch {
        return { name }
      }
    })
  }

  // ── Create ────────────────────────────────────────────────────────

  /** POST /api/tasks — explicit draft creation. The autosave seam (04) may
   *  also create a draft implicitly; both paths converge here. SG3: if a
   *  source_chat_session_id is provided, link the session's scope_id to the
   *  new task id (the autosave-seam writer is 04's job; this is the explicit
   *  POST path).
   *
   *  04 (D1/D5/D13/D15): when `task_type` is present (v3 two-phase flow), the
   *  task gets a home dir (`~/.octopus/tasks/{id}/`) with a materialized skills/
   *  plugin directory for the selected skill groups (ADR-0010). skill_groups +
   *  task_type persist into task_spec (D4: NOT authoring_resources, which would
   *  double-inject). preset.org/projects → tasks.org/project_ids (D13 coding
   *  template: only org+projects). When task_type is absent, the legacy/v2
   *  create path is unchanged (no home, no gate — backward compat). */
  createTask(input: CreateTaskInput): TaskDTO {
    const id = randomUUID()
    const now = new Date().toISOString()
    const name = input.name?.trim() || DEFAULT_TASK_NAME
    const isV3 = !!input.task_type

    // 04 (D13): preset.org overrides the top-level org (the template page is the
    // source of the authoring context). preset.projects → project_ids.
    const org = input.preset?.org ?? input.org
    const projectIds = input.preset?.projects ?? []

    // 04 (D4): task_type + skill_groups live in task_spec, NOT authoring_resources.
    // goal/ac start empty (the authoring chat fills them via spec-field). The raw
    // JSON is stored without taskSpecSchema.parse here (goal="" / ac=[] would fail
    // the schema's min(1) — validation happens on PUT [save draft], by which time
    // the user has filled them in).
    const taskSpecObj: Record<string, unknown> = { goal: "", ac: [] }
    if (isV3) {
      taskSpecObj.task_type = input.task_type
      taskSpecObj.skill_groups = input.skill_groups ?? []
    }

    this.taskDAO.insert({
      id,
      org,
      name,
      status: "draft",
      source_chat_session_id: input.source_chat_session_id ?? null,
      task_spec: JSON.stringify(taskSpecObj),
      project_ids: JSON.stringify(projectIds),
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

    // 04 (ADR-0010/D1): v3 task → create home + materialize skill groups into
    // {home}/skills/ as junctions/symlinks (or copy fallback). The "default"
    // group is an empty marker (D17) — the materializer skips it, so no skills
    // are linked (shared skills are already exposed via plugin #1).
    if (isV3) {
      const groups = input.skill_groups ?? []
      // Pass org + resolved project paths + skill groups to createHome so
      // context.md is populated from the start (not empty until the first
      // chat turn or a subsequent updateTask).
      const projectRefs = this.resolveProjectRefs(org, projectIds)
      const home = this.taskHomeService.createHome(id, { org, projects: projectRefs, skillGroups: groups })
      if (groups.length > 0) {
        try {
          this.resolveMaterializer().materializeGroups(home, groups)
        } catch (err: unknown) {
          // Non-fatal: the task row + home exist; the session can still proceed.
          // A materialization failure (e.g. all skills missing) must not block
          // task creation — the user can retry via a re-PUT (idempotent).
          console.error(
            `[TasksService] createTask: materializeGroups failed for ${id} (non-fatal — home created):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }

    const row = this.taskDAO.getById(id)
    if (!row) {
      throw new Error(`TasksService.createTask: inserted task ${id} not found`)
    }
    // 06: the POST body may carry goal/ac — overwrite the baseline spec.json
    // (written empty by createHome) with the real task_spec.
    this.writeSpecSnapshot(id)
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
        scheduled_at: s.scheduled_at ?? null,
        workspace_id: s.workspace_id ?? null,
        execution_ref: this.latestExecutionRef(s.id),
      }))
    const [root] = this.scheduleDAO.findRootSchedulesByTaskIds([id])
    const enrichedDto: TaskDTO = root
      ? { ...dto, schedule_status: root.status, scheduled_at: root.scheduled_at }
      : dto
    return { ...enrichedDto, children, derived: this.deriveView(row) }
  }

  /** task-phase-redesign (ticket 07): gather the three facts deriveTaskView
   *  needs and hand off — this service adds NO state logic of its own (K3).
   *
   *  Round executions are scoped through the task's SCHEDULES (S2 polymorphic
   *  origin → schedule_executions.execution_id, written by BOTH round paths:
   *  WorkflowExecutor.execute:458 for the first trigger and
   *  dispatchPhaseRound for advances/retries). Why not `tasks.workspace_id`:
   *  the ws is the execution's location, not its ownership — an out-of-band ws
   *  deletion would then blind the derivation (rounds invisible ⇒ the human
   *  could never accept/advance again), while the ledger says otherwise. The
   *  phase_index IS NOT NULL filter keeps child loop/swarm executions (and all
   *  v3/generic rows) out; derive ignores anything untagged anyway. */
  private deriveView(row: TaskRow): TaskView {
    const executions: DeriveExecutionInput[] = this.taskDAO
      .getDb()
      .prepare(
        `SELECT e.id, e.status, e.phase_index, e.round_index, e.created_at
           FROM executions e
          WHERE e.phase_index IS NOT NULL
            AND e.id IN (
              SELECT se.execution_id
                FROM schedule_executions se
                JOIN schedules s ON s.id = se.schedule_id
               WHERE s.origin_type = 'task' AND s.origin_id = ?
                 AND se.execution_id IS NOT NULL
            )
          ORDER BY e.created_at ASC`,
      )
      .all(row.id) as DeriveExecutionInput[]
    return deriveTaskView(
      { id: row.id, status: row.status, task_spec: row.task_spec },
      executions,
      this.acceptanceDAO.listByTask(row.id),
    )
  }

  /** Compact latest-run summary for a child schedule (listExecutions is
   *  triggered_at DESC). Null when the schedule never ran (ready/parked).
   *  Deliberately excludes agent_output/token_usage — fetch those via the
   *  scheduler executions endpoint on demand (弹窗优化 2026-08-29). */
  private latestExecutionRef(scheduleId: string): TaskDetailDTO["children"][number]["execution_ref"] {
    const { data } = this.runDAO.listExecutions(scheduleId, { page: 1, limit: 1 })
    const row: ScheduleExecutionRow | undefined = data[0]
    if (!row) return null
    return {
      id: row.id,
      status: row.status,
      execution_id: row.execution_id ?? null,
      workspace_id: row.workspace_id ?? null,
      triggered_at: row.triggered_at,
      completed_at: row.completed_at ?? null,
      duration_ms: row.duration_ms ?? null,
      error_summary: row.error_summary ?? null,
    }
  }

  /** GET /api/tasks/:id/artifacts — the artifact index (ticket 06, US7).
   *  Validates the task exists (→ 404 via {@link TaskNotFoundError}) then
   *  delegates to {@link TaskHomeService.readArtifacts}, which returns [] for
   *  a missing index and [] + warn for corrupted JSON (SW-BP12). The
   *  task-exists check runs FIRST so a missing task is a 404, not a silent []
   *  (a [] response means "task has no artifacts yet", which is wrong for a
   *  task that doesn't exist). */
  listArtifacts(taskId: string): ArtifactIndexEntry[] {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    return this.taskHomeService.readArtifacts(taskId)
  }

  /** GET /api/tasks/:id/artifacts/content?path= — full artifact content with
   *  whitelist (ticket 06, US7 / AC2/AC3/AC4). Validates the task exists (→
   *  404 via {@link TaskNotFoundError}) BEFORE the whitelist so a missing task
   *  is 404 (not a misleading 403/400 from the path check). Delegates the
   *  whitelist + read to {@link TaskHomeService.readArtifactContent}, which
   *  throws {@link ArtifactAccessError} (FORBIDDEN→403 / NOT_FOUND→404). The
   *  route validates the `path` query param is a non-empty string (→ 400)
   *  before calling this — so this method receives a non-empty path. */
  readArtifactContent(
    taskId: string,
    requestedPath: string,
  ): { path: string; content: string } {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    return this.taskHomeService.readArtifactContent(taskId, requestedPath)
  }

  /** GET /api/tasks/:id/workflow-ref — view the bound workflow's content + source
   *  (ADR-0013, US5 / AC8). Returns `{ ref, content, source }` on hit. When the
   *  task has no bound ref (tasks.workflow_ref NULL/empty), returns
   *  `{ ref: null, content: null, source: null }` so the SpecPanel can render a
   *  degraded state (the user sees "未绑定工作流"). When a ref is bound but
   *  unresolvable (e.g. the builtin was uninstalled between bind and view),
   *  throws {@link TaskSpecFieldError} (→ 400 via classifyError). The task-exist
   *  check runs FIRST so a missing task is a 404 (not a misleading 400/empty). */
  viewWorkflowRef(taskId: string): { ref: string | null; content: string | null; source: string | null } {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    const ref = row.workflow_ref?.trim() ?? ""
    if (!ref) {
      return { ref: null, content: null, source: null }
    }
    const resolution = resolveWorkflowRef(ref, this.resolverDeps(taskId))
    if (!resolution) {
      throw new TaskSpecFieldError(
        `workflow not resolvable: '${ref}' (was bound but no longer in the resolution set)`,
      )
    }
    return { ref: resolution.ref, content: resolution.content, source: resolution.source }
  }

  /** GET /api/tasks — list active tasks (kanban), filtered by status and/or org. */
  listTasks(params: ListTasksParams = {}): { items: TaskDTO[] } {    let rows: TaskRow[]
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
      // ticket 07: the two v4 states (awaiting_review / archiving) join the
      // scan — v3 rows never carry them, so the union is a pure superset of the
      // previous list (a v4 task would otherwise vanish from the unfiltered
      // board between rounds).
      rows = (
        [
          "draft", "ready", "running", "awaiting_review", "archiving",
          "done", "failed", "aborted",
        ] as TaskStatus[]
      ).flatMap((st) => this.taskDAO.listByStatus(st))
    }
    return { items: this.enrichRootSchedule(rows.map(toDTO)) }
  }

  /** v39 board enrichment: attach the root schedule's status + due time to
   *  task DTOs with ONE batched query (a task has at most one live root —
   *  readyTask is draft-only). Backward compatible: fields stay undefined when
   *  no root row exists (draft tasks). */
  private enrichRootSchedule(dtos: TaskDTO[]): TaskDTO[] {
    if (dtos.length === 0) return dtos
    const roots = this.scheduleDAO.findRootSchedulesByTaskIds(dtos.map((d) => d.id))
    if (roots.length === 0) return dtos
    const byId = new Map(roots.map((r) => [r.origin_id, r]))
    return dtos.map((d) => {
      const root = byId.get(d.id)
      return root ? { ...d, schedule_status: root.status, scheduled_at: root.scheduled_at } : d
    })
  }

  // ── Update ([save draft]) ─────────────────────────────────────────

  /** PUT /api/tasks/:id — update with If-Match optimistic locking. Only
   *  draft/ready tasks are editable (a running/done/failed/aborted task is
   *  immutable — the spec is frozen at dispatch time). */
  updateTask(id: string, input: UpdateTaskInput, expectedVersion: number): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (!this.isSpecEditable(existing)) {
      throw new TaskStatusConflictError(
        `Cannot edit task in status '${existing.status}' (v3: only draft/ready are editable; v4: until done/archiving/aborted — K16)`,
      )
    }
    const fields: Record<string, unknown> = {}
    if (input.name !== undefined) fields.name = input.name
    if (input.task_spec !== undefined) {
      // 04 (SW-BP9): skill_groups / task_type are LOCKED at creation (ADR-0012).
      // A PUT that attempts to change them → 409 (TaskLockViolationError). The
      // check runs on the RAW body values BEFORE taskSpecSchema.parse — parse
      // would default absent skill_groups→[] and mask an explicit change as
      // "same as default". After the check, the locked fields are MERGE-PRESERVED:
      // a PUT that omits them (the UI only saves goal/ac) keeps the existing
      // values rather than clobbering to the schema default (SW-BP2).
      const rawSpec = input.task_spec as Record<string, unknown> | null
      if (rawSpec && typeof rawSpec === "object") {
        const existingSpec = parseJSON<TaskSpec>(existing.task_spec, {
          goal: "",
          ac: [],
        } as unknown as TaskSpec)
        // task_type lock: present + differs → 409.
        if (
          "task_type" in rawSpec &&
          rawSpec.task_type !== (existingSpec as Record<string, unknown>).task_type
        ) {
          throw new TaskLockViolationError(
            "task_type is locked at task creation and cannot be changed (SW-BP9)",
          )
        }
        // skill_groups lock: present + differs → 409. Compare via sorted JSON so
        // order-insensitive (["a","b"] == ["b","a"] — the user re-ordering the
        // locked selection is not a violation, only the set matters).
        if ("skill_groups" in rawSpec) {
          const exGroups = ((existingSpec as Record<string, unknown>).skill_groups ?? []) as string[]
          const inGroups = (rawSpec.skill_groups ?? []) as string[]
          const sameSet =
            [...exGroups].sort().join("\n") === [...inGroups].sort().join("\n")
          if (!sameSet) {
            throw new TaskLockViolationError(
              "skill_groups are locked at task creation and cannot be changed (SW-BP9)",
            )
          }
        }
        // Validate the full spec via Zod (throws ZodError → route 400).
        const parsed = taskSpecSchema.parse(rawSpec)
        // Merge-preserve: if the body omitted the locked fields, restore them
        // from the existing row (parse defaults absent skill_groups→[] and
        // task_type→undefined, which would silently clobber the locked values).
        if (!("task_type" in rawSpec)) {
          parsed.task_type = (existingSpec as Record<string, unknown>).task_type as
            | "coding" | "generic" | undefined
        }
        if (!("skill_groups" in rawSpec)) {
          parsed.skill_groups =
            ((existingSpec as Record<string, unknown>).skill_groups as string[] | undefined) ?? []
        }
        // K16/M2 belt (cycle-2 review ①): for a v4 task, `format` and the
        // phase ledger are LOCKED like task_type/skill_groups. The K16 edit
        // window lets a whole-spec PUT land mid-life; stripping format would
        // silently drop the task back into v3 mirror semantics, and emptying
        // phases bricks the card forever (derive can never yield
        // awaiting_review without a phase ledger). Absent → merge-preserve;
        // present-but-different format → 409. (phases:[] already 400s via
        // taskPhaseSchema min(1).)
        if (isV4TaskSpec(existing.task_spec)) {
          if ("format" in rawSpec && rawSpec.format !== "v4") {
            throw new TaskLockViolationError(
              "a v4 task cannot change task_spec.format (K13 fork discriminator is creation-locked)",
            )
          }
          if (!("format" in rawSpec)) {
            parsed.format = "v4"
          }
          if (!("phases" in rawSpec)) {
            parsed.phases = (existingSpec as Record<string, unknown>).phases as TaskSpec["phases"]
          }
        }
        fields.task_spec = JSON.stringify(parsed)
      } else {
        // Non-object task_spec (null / wrong type) → let Zod reject it as 400.
        fields.task_spec = JSON.stringify(taskSpecSchema.parse(input.task_spec))
      }
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

    // 04 (bugfix 2026-08-21): a manual title rename (PUT {name}) is user-owned —
    // sync it to the bound task-author session title. The autosave seam writes
    // session.title → tasks.name at turn-end; keeping the two equal makes that a
    // no-op, so the header rename survives the next chat turn. Best-effort,
    // non-fatal (most tasks are not bound to a session).
    if (input.name !== undefined && input.name !== existing.name) {
      const linked = existing.source_chat_session_id
      if (linked && this.agentSessionDAO) {
        try {
          this.agentSessionDAO.updateSession(linked, { title: input.name })
        } catch (err: unknown) {
          // eslint-disable-next-line no-console
          console.error(
            '[TasksService] updateTask: failed to sync session title (non-fatal — task renamed):',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }

    // 05 — reverse context msg (SPIKE S1, v2-D7). [保存草稿] → set a
    // transient, in-memory notice keyed by task_id. The task-author clone
    // chat send path reads it on the next turn and passes it to
    // CloneRuntime.chat as `specUpdateNotice` → system-prompt append so the
    // agent sees the user's spec override. PUSH model (v2-D7): the notice is
    // delivered once, then cleared by the send path. Acceptable to lose on
    // server restart (transient UX nudge, not a source of truth). Kept out
    // of the DB on purpose — 06 owns schema.ts, and a transient column would
    // collide with the concurrent schema work. Lists the changed field names
    // (values can be large JSON; the agent re-GETs to reconcile).
    const changedFields = (Object.keys(input) as Array<keyof UpdateTaskInput>)
      .filter((k) => input[k] !== undefined)
    if (changedFields.length > 0) {
      setSpecNotice(id, `@@spec_updated: ${changedFields.join(", ")}`)
    }

    // Context-affecting fields changed → refresh context.md so the agent
    // sees the latest org/projects/skill_groups when it re-reads the file.
    // The specUpdateNotice above already tells the agent "something changed";
    // the rules file instructs it to re-read context.md on @@context_updated.
    const contextFields = changedFields.filter((f) =>
      f === 'project_ids' || f === 'task_spec' || f === 'skills'
    )
    if (contextFields.length > 0) {
      try {
        const row = this.taskDAO.getById(id)
        if (row) {
          const ctxSpec = row.task_spec
            ? JSON.parse(row.task_spec) as { skill_groups?: string[] }
            : null
          const groups = ctxSpec?.skill_groups ?? []
          const projectIds: string[] = row.project_ids
            ? JSON.parse(row.project_ids) as string[]
            : []
          const projectRefs = this.resolveProjectRefs(row.org, projectIds)
          this.taskHomeService.writeContextFile(id, row.org, projectRefs, groups)
          // Add context_updated to the notice so the agent knows to re-read
          const existing = getSpecNotice(id) ?? ''
          setSpecNotice(id, `${existing}\n@@context_updated: ${contextFields.join(", ")} — 请重新读取 context.md`.trim())
        }
      } catch (err: unknown) {
        // Non-fatal — context.md stays stale; agent misses the update.
        console.error(
          '[TasksService] writeContextFile on updateTask failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    const row = this.taskDAO.getById(id)
    if (!row) throw new TaskNotFoundError()
    // 06: task_spec may have changed (or the name for the spec.json header) —
    // keep the structured goal/ac snapshot current.
    this.writeSpecSnapshot(id)
    return toDTO(row)
  }

  // ── spec-field tool endpoint ──────────────────────────────────────

  /** POST /api/tasks/:id/spec-field — the agent `update_task_spec_field`
   *  tool endpoint AND the user-direct-edit path (05, SW-BP4). Merges a single
   *  field into the right column, bumps version, emits spec_field_update SSE.
   *  `source="user"` → setSpecNotice so the agent sees @@spec_updated on its
   *  next chat turn (the clone send path delivers + clears it); `source="agent"`
   *  (default) does NOT, so the agent never echoes its own edit back. Returns
   *  the new version. Stale version → 409 → agent re-GET + retry (v2-D12). */
  updateSpecField(id: string, input: UpdateSpecFieldInput): { version: number } {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (!this.isSpecEditable(existing)) {
      throw new TaskStatusConflictError(
        `Cannot edit spec of a task in status '${existing.status}'`,
      )
    }
    const validatedValue = validateServerSpecField(input.field, input.value)

    // task-workflow-handoff (ADR-0013): fail-fast pre-check on bind. The
    // resolver's resolution set = installed built-ins ∪ task-home workflows/.
    // A bind that can't resolve is REJECTED up-front (400 via TaskSpecFieldError)
    // so the authoring agent corrects in the same turn — the ready-gate upgrade
    // (below) is the second line of defense at enqueue.
    if (input.field === "workflow_ref") {
      const ref = validatedValue as string
      if (!isWorkflowRefResolvable(ref, this.resolverDeps(id))) {
        throw new TaskSpecFieldError(
          `workflow not resolvable: '${ref}' (not an installed built-in and not found in task home workflows/)`,
        )
      }
    }

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
      case "decisions":
      case "goal_confirmed":
      case "ac_confirmed":
      case "phases":
        // Merge into task_spec JSON (all v3 confirmation/decision fields +
        // the original goal/ac/subunits/integration_goal live in task_spec).
        // ticket 07: `phases` too — WHOLE-ARRAY PUT (the value validated by
        // shared's taskPhaseSchema replaces the list; per-phase patching is
        // deliberately not defined, K1).
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
      case "workflow_ref":
        // ADR-0013: workflow_ref lives as a TOP-LEVEL column (tasks.workflow_ref)
        // — same pattern as skills/projects/resources. NOT stored in task_spec.
        fields.workflow_ref = validatedValue
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
    // D19 (SW-BP8): companion task_artifacts_update on the same taskpool
    // stream — spec-field activity correlates with artifact production (the
    // agent writes artifacts.json to the home dir directly on disk, so this
    // event is the server's observable trigger). The OutputViewer re-fetches
    // GET /api/tasks/:id/artifacts; no polling.
    this.sse.emit("taskpool", {
      event: TASK_ARTIFACTS_UPDATE_EVENT,
      data: { task_id: id },
    })

    // 05 (SW-BP4): user-direct-edit → transient @@spec_updated notice so the
    // agent reconciles on its next chat turn. Same store the [保存草稿] path
    // (updateTask) writes to; the clone send path (clone/index.ts) reads +
    // clears it. Agent source MUST NOT set it, or the agent would see its own
    // edit echoed back as a user override. One field name in the notice (values
    // can be large JSON; the agent re-GETs to reconcile — mirrors updateTask).
    if (input.source === "user") {
      setSpecNotice(id, `@@spec_updated: ${input.field}`)
    }

    // Context-affecting field changed → refresh context.md (always, regardless
    // of source — the file is the source of truth for the agent's on-demand
    // read). For user-source, also append @@context_updated to the notice.
    if (input.field === "projects" || input.field === "skills") {
      try {
        const row = this.taskDAO.getById(id)
        if (row) {
          const ctxSpec = row.task_spec
            ? JSON.parse(row.task_spec) as { skill_groups?: string[] }
            : null
          const groups = ctxSpec?.skill_groups ?? []
          const projectIds: string[] = row.project_ids
            ? JSON.parse(row.project_ids) as string[]
            : []
          const projectRefs = this.resolveProjectRefs(row.org, projectIds)
          this.taskHomeService.writeContextFile(id, row.org, projectRefs, groups)
          if (input.source === "user") {
            const existing = getSpecNotice(id) ?? ''
            setSpecNotice(id, `${existing}\n@@context_updated: ${input.field} — 请重新读取 context.md`.trim())
          }
        }
      } catch (err: unknown) {
        // Non-fatal
        console.error(
          '[TasksService] writeContextFile on updateSpecField failed (non-fatal):',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // 06: every spec-field write (any field, any source) refreshes the
    // structured goal/ac snapshot (spec.json) the task-author agent reads.
    this.writeSpecSnapshot(id)

    return { version: updated.version }
  }

  /** 06 — refresh `{home}/spec.json` from the current tasks row. The
   *  task-author agent reads this structured snapshot for goal/ac instead of
   *  curling the API. Best-effort, non-fatal: legacy/v2 tasks have no home dir
   *  (writeSpecFile is a silent no-op). Called on every spec write (create /
   *  PUT / spec-field) so the file always reflects the current task_spec. */
  private writeSpecSnapshot(id: string): void {
    try {
      const row = this.taskDAO.getById(id)
      if (!row) return
      const spec = parseJSON<Record<string, unknown>>(row.task_spec, {})
      this.taskHomeService.writeSpecFile(id, {
        version: row.version,
        spec,
        updated_at: row.updated_at,
      })
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error(
        `[TasksService] writeSpecFile for ${id} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── Dispatch seam (ready → schedules envelope) ───────────────────

  /** task-phase-redesign (ticket 04, K13): the v4 ready-gate over the phase
   *  contract. For each phase (1-based index `i`, array order):
   *    ① specPath file EXISTS — relative paths resolve under the task home
   *       (ADR-0011: home is the spec authority), absolute paths verbatim
   *       ⇒ miss: `phase:<i>:spec-missing`
   *    ② workflow_ref resolves against the SAME resolution set as v3
   *       (installed built-ins ∪ task-home workflows/, ADR-0013)
   *       ⇒ miss: `phase:<i>:workflow-ref`
   *    ③ the resolved workflow's required inputs are non-empty AFTER the v4
   *       placeholder vocabulary resolves (${goal}/${ac}/${phase.slug}/
   *       ${phase.spec_dir}/${task.home}/${task_artifacts_dir}); unknown or
   *       empty-resolving placeholders surface as `phase:<i>:input:<key>`
   *       too (never a 500 — v3 AC3 discipline inherited).
   *  Checks ① and ② run independently so the UI sees every defect at once;
   *  ③ only runs when ② hit (no workflow content to parse otherwise). A phase
   *  that passes all checks yields a {@link TaskV4PhaseConfig} for the
   *  materializer envelope. Empty/missing phases ⇒ single `phase:0:no-phases`.
   *  Returns the deduped missing list + resolved phases (throws nothing —
   *  readyTask turns a non-empty missing list into TaskReadyGateError). */
  private gateV4Phases(
    taskId: string,
    taskSpec: TaskSpec,
  ): { missing: string[]; phases: TaskV4PhaseConfig[] } {
    const missing: string[] = []
    const phases = taskSpec.phases ?? []
    if (phases.length < 1) {
      return { missing: ["phase:0:no-phases"], phases: [] }
    }
    const homeDir = this.taskHomeService.homePath(taskId)
    const taskArtifactsDir = this.taskHomeService.artifactsDir(taskId)
    const resolved: TaskV4PhaseConfig[] = []
    phases.forEach((p, idx) => {
      const i = idx + 1
      // ① spec file exists (relative ⇒ under the task home)
      const absSpec = path.isAbsolute(p.specPath) ? p.specPath : path.join(homeDir, p.specPath)
      const specOk = fs.existsSync(absSpec) && fs.statSync(absSpec).isFile()
      if (!specOk) missing.push(`phase:${i}:spec-missing`)
      // ② workflow_ref resolvable (single resolve serves ③'s content too —
      // same pattern as the v3 gate's review fix 2026-08-27)
      const ref = (p.workflowRef ?? "").trim()
      const resolution = ref ? resolveWorkflowRef(ref, this.resolverDeps(taskId)) : null
      if (!resolution) {
        missing.push(`phase:${i}:workflow-ref`)
        return
      }
      // ③ required inputs non-empty after v4 placeholder resolution
      const inputDefs = parseWorkflowInputDefs(resolution.content)
      const { values, unresolved } = resolveInputValues(
        p.inputValues,
        taskSpec.goal,
        taskSpec.ac,
        {
          phaseSlug: p.slug,
          phaseSpecDir: path.dirname(absSpec),
          taskHome: homeDir,
          taskArtifactsDir,
        },
      )
      for (const key of unresolved) missing.push(`phase:${i}:input:${key}`)
      for (const def of inputDefs) {
        if (def.required && !values[def.name]?.trim()) {
          missing.push(`phase:${i}:input:${def.name}`)
        }
      }
      if (specOk) {
        resolved.push({
          index: i,
          name: p.name,
          slug: p.slug,
          specPath: absSpec,
          specDir: path.dirname(absSpec),
          workflowRef: ref,
          inputValues: values,
        })
      }
    })
    // Dedupe — an unresolved placeholder on a required input can hit both the
    // `input:<key>` (unresolved) and `input:<name>` (empty-required) paths
    // (mirrors the v3 branch).
    return { missing: Array.from(new Set(missing)), phases: resolved }
  }

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

    // task-phase-redesign (ticket 04, K13): format-branched gate. A v4 spec
    // (format === "v4") checks the PHASE contract instead of the v3
    // goal/ac/confirmations flow: phases≥1 ∧ per-phase spec file exists (under
    // the task home) ∧ per-phase workflow_ref resolves against the same
    // resolution set as v3 (ADR-0013) ∧ required inputs non-empty after the v4
    // placeholder vocabulary resolves. Missing keys carry the `phase:<i>:<why>`
    // format so the UI can point at the offending phase. The v3/legacy branch
    // below is untouched (AC2 — tasks-v3-gates.test.ts passes unmodified).
    let v4Phases: TaskV4PhaseConfig[] | undefined
    if (taskSpec.format === "v4") {
      const { missing, phases } = this.gateV4Phases(id, taskSpec)
      if (missing.length > 0) {
        throw new TaskReadyGateError(
          `Task not ready: missing ${missing.join(", ")}`,
          missing,
        )
      }
      v4Phases = phases
    } else if (taskSpec.task_type !== undefined) {
      // 05 (D18, US6): confirmation gate. A v3 task (one that went through the
      // two-phase flow → task_type set) may NOT be enqueued until its intent is
      // fully confirmed: goal non-empty ∧ ac≥1 ∧ goal_confirmed===true ∧ every ac
      // item listed in ac_confirmed. UI temp state is lost on modal close, so the
      // gate must be server-side. Legacy/v2 tasks (no task_type) predate the
      // confirmation flow and keep the existing no-gate behavior — this preserves
      // the v2 ready cases in tasks-routes.test.ts. On failure, return the
      // missing-items list so the UI shows exactly what to confirm (409 + JSON).
      const missing: string[] = []
      if (!taskSpec.goal || !taskSpec.goal.trim()) missing.push("goal")
      if (!taskSpec.ac || taskSpec.ac.length < 1) missing.push("ac")
      if (taskSpec.goal_confirmed !== true) missing.push("goal_confirmed")
      const acConfirmed = taskSpec.ac_confirmed ?? []
      const unconfirmedAc = (taskSpec.ac ?? []).filter((a) => !acConfirmed.includes(a))
      if (unconfirmedAc.length > 0) missing.push("ac_confirmed")
      // 08 (gate, 2026-08-23 — option A): a SIMPLE v3 task (subunits < 2)
      // materializes workflow_chain[0].workflow_ref straight from tasks.workflow_ref
      // via materializeTaskSpecToConfig (`workflow_ref ?? ''` — scheduler-service.ts:
      // 239). An empty ref fails at RUNTIME with "Workflow not found: " (EngineFactory
      // resolveWorkflowWithSnapshot has no default fallback) AFTER the runner has
      // claimed the schedule + provisioned a workspace + created an execution — a
      // doomed task that burns a claim slot. Gate it here so enqueue is REJECTED
      // up-front with a clear missing-items message ("先绑定工作流再入队"). Composite
      // tasks (subunits >= 2) materialize to the BUILT-IN 'composition-task' ref and
      // need no task-level workflow_ref — excluded from this check.
      //
      // task-workflow-handoff (ADR-0013, S3): gate upgrade from "non-empty" to
      // "resolvable against the resolution set" (installed built-ins ∪ task-home
      // workflows/). A non-empty but UNRESOLVABLE ref is treated the same as
      // empty — added to missing. The resolver is the same one bind-fail-fast
      // uses (single source of truth, three call sites).
      const subunits = taskSpec.subunits ?? []
      if (subunits.length < 2) {
        const ref = existing.workflow_ref?.trim() ?? ""
        // Single resolve (review fix 2026-08-27): the old code walked the ref
        // twice (isWorkflowRefResolvable + resolveWorkflowRef). One call — null
        // ⇒ unresolvable (→ missing workflow_ref); hit ⇒ content for the
        // required-inputs check.
        const resolution = ref ? resolveWorkflowRef(ref, this.resolverDeps(id)) : null
        if (!resolution) {
          missing.push("workflow_ref")
        } else {
          // task-workflow-presets (T5): required inputs check against the
          // RESOLVED input_values (after ${goal}/${ac} substitution). Keys whose
          // value has an unknown/empty placeholder also surface as missing
          // (input:<name>), never a 500.
          const inputDefs = parseWorkflowInputDefs(resolution.content)
          const { values, unresolved } = resolveInputValues(
            taskSpec.input_values,
            taskSpec.goal,
            taskSpec.ac,
          )
          for (const key of unresolved) missing.push(`input:${key}`)
          for (const def of inputDefs) {
            if (def.required && !values[def.name]?.trim()) {
              missing.push(`input:${def.name}`)
            }
          }
        }
      }
      if (missing.length > 0) {
        // Dedupe — an unresolved placeholder on a required input can hit both
        // the `input:<key>` (unresolved) and `input:<name>` (empty-required)
        // paths with the same key.
        const uniqueMissing = Array.from(new Set(missing))
        throw new TaskReadyGateError(
          `Task not ready: missing ${uniqueMissing.join(", ")}`,
          uniqueMissing,
        )
      }
    }

    const projectIds = parseJSON<string[]>(existing.project_ids, [])
    const skills = parseJSON<string[]>(existing.skills, [])
    // SG7 (ticket 07): pass the task's resources column (workspace-scope) to
    // materialize so it propagates into config.requires alongside subunit
    // resources. The materialize body UNIONs both + dedupes.
    const resources = parseJSON<ResourceRef[]>(existing.resources, [])
    const subunits: SubunitSpec[] = taskSpec.subunits ?? []
    // SG9: composite requires subunits.length >= 2 (1-subunit → simple
    // workflow_chain). The materialize body's own threshold (06 changes it) is
    // not relied on here — the dispatch seam decides simple vs composite.
    const isComposite = subunits.length >= 2

    // Materialize the WorkflowConfig for the schedule envelope. The exported
    // function includes task_spec in the output (06 drops it); 03's
    // verification checks origin_type='task' (v39: envelope is parked 'draft',
    // not 'queued' — see insertSchedule below).
    // Ticket 08 (D14): inject $vars.task_artifacts_dir = homePath(id)/artifacts
    // for v3 tasks (task_type set — went through the two-phase flow → home
    // created at task creation). v2/legacy tasks (no task_type) skip injection
    // (AC4 backward compat — no home exists, the key is omitted not errored).
    // task-workflow-handoff (ADR-0013): same pattern for task_workflows_dir —
    // the WorkflowExecutor uses it post-createFromSpec to copy agent-authored
    // workflow YAMLs from {home}/workflows/ into the execution ws workflows/.
    // v4 tasks carry a home too (the gate resolves phase spec files against it),
    // so the management-key injection applies to both branches.
    const isV3 = taskSpec.task_type !== undefined || taskSpec.format === "v4"
    const taskArtifactsDir = isV3 ? this.taskHomeService.artifactsDir(id) : undefined
    const taskWorkflowsDir = isV3 ? this.taskHomeService.workflowsDir(id) : undefined
    const config = materializeTaskSpecToConfig(
      taskSpec,
      projectIds,
      existing.org,
      existing.workflow_ref ?? undefined,
      skills,
      resources,
      taskArtifactsDir,
      taskWorkflowsDir,
      // ticket 04: v4 only — per-phase gate resolution embedded into the
      // envelope config (undefined ⇒ the v3/generic path is byte-identical).
      v4Phases,
    )
    const configJson = JSON.stringify(config)
    const now = new Date().toISOString()

    const scheduleId = randomUUID()
    // v39 MANUAL TRIGGER: the envelope is created PARKED ('draft'), not 'queued'
    // — enqueue no longer auto-runs. checkQueuedTasks only claims 'queued' rows,
    // and TaskScheduleStatusListener does not mirror 'draft', so the task
    // correctly stays 'ready'. The explicit POST /:id/trigger flips it to
    // 'queued' (+ scheduled_at due time) for immediate or one-shot timed runs.
    this.scheduleDAO.insertSchedule({
      id: scheduleId,
      org: existing.org,
      name: `task-${id}-${isComposite ? "coordinator" : "primary"}`,
      cron_expression: null,
      timezone: "UTC",
      job_type: "workflow",
      config: configJson,
      status: "draft",
      scheduled_at: null,
      origin_type: "task",
      origin_id: id,
      origin_role: isComposite ? "coordinator" : "primary",
      created_at: now,
      updated_at: now,
    })

    // Flip the task to 'ready' (dispatch seam created the PARKED envelope; an
    // explicit trigger arms it, then the runner claims + ScheduleStatusListener
    // mirrors running).
    const result = this.taskDAO.updateWithVersion(id, { status: "ready" }, existing.version)
    if (result.changes === 0) throw new TaskVersionConflictError()

    const row = this.taskDAO.getById(id)!
    return toDTO(row)
  }

  // ── Trigger (v39 — manual / one-shot time trigger of a parked envelope) ────

  /** POST /api/tasks/:id/trigger — arms the parked (draft) root envelope:
   *  draft → queued with `scheduled_at = at ?? now`. `at` absent/past =
   *  immediate (next wake/tick); future = one-shot timed run (the poller's
   *  due-filter holds it until due).
   *
   *  SAME-TASK MUTEX (v39 final semantics): one task instance at a time.
   *  Enforced structurally — a task has exactly one root envelope (readyTask
   *  is draft-only), and trigger requires tasks.status='ready', so a queued
   *  or running task cannot be re-armed; the guarded draft→queued flip closes
   *  the race window. Different tasks may run concurrently (bounded by the
   *  existing MAX_PARALLEL_WORKSPACES cap). */
  triggerTask(id: string, at?: string): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "ready") {
      throw new TaskStatusConflictError(
        `只有已入队(ready)的任务可以触发 (当前状态: '${existing.status}')`,
      )
    }

    const roots = this.scheduleDAO
      .findSchedulesByOrigin("task", id)
      .filter((r) => r.origin_role === "primary" || r.origin_role === "coordinator")
    const parked = roots.find((r) => r.status === "draft")
    if (!parked) {
      if (roots.some((r) => r.status === "queued")) {
        throw new TaskStatusConflictError("任务已触发，处于排队状态")
      }
      if (roots.some((r) => r.status === "claimed" || r.status === "running")) {
        throw new TaskStatusConflictError("任务正在执行中")
      }
      throw new TaskStatusConflictError("未找到已入队的执行计划，请重新入队")
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const dueAt = at ?? nowIso

    const flipped = this.scheduleDAO.claimParkedTaskSchedule(parked.id, dueAt)
    if (flipped.changes === 0) {
      throw new TaskStatusConflictError("触发状态已变化，请刷新重试")
    }

    // Mirror the queued→running transition the listener would emit (we flipped
    // the schedule directly, bypassing the engine's emit path). Status write is
    // a system event — no version bump (abortTask pattern).
    this.taskDAO
      .getDb()
      .prepare("UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND deleted_at IS NULL")
      .run("running", nowIso, id)

    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: id, status: "running", schedule_id: parked.id, origin_type: "task" },
    })
    this.sse.emit("taskpool", {
      event: TASK_TRIGGER_EVENT,
      data: { task_id: id, action: at ? "scheduled" : "triggered", scheduled_at: at ?? null },
    })

    // Sub-second pickup — don't wait for the 60s auxiliary tick.
    this.wakeScheduler?.()

    const row = this.taskDAO.getById(id)!
    return toDTO(row)
  }

  /** POST /api/tasks/:id/trigger/cancel — withdraw an armed-but-not-started
   *  one-shot (queued + unclaimed + scheduled_at in the future) back to parked
   *  draft; the task returns to 'ready'. If the poller already claimed/due-ran
   *  it (guarded UPDATE changes===0) → 409 conflict. */
  cancelTaskTrigger(id: string): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "running" && existing.status !== "ready") {
      throw new TaskStatusConflictError(
        `Cannot cancel trigger for a task in status '${existing.status}'`,
      )
    }
    const root = this.scheduleDAO
      .findSchedulesByOrigin("task", id)
      .find(
        (r) =>
          (r.origin_role === "primary" || r.origin_role === "coordinator") &&
          r.status === "queued",
      )
    if (!root) throw new TaskStatusConflictError("没有可取消的定时触发")

    const nowIso = new Date().toISOString()
    const flipped = this.scheduleDAO.cancelTriggeredTaskSchedule(root.id, nowIso)
    if (flipped.changes === 0) {
      throw new TaskStatusConflictError("定时触发已开始执行或不存在，无法取消")
    }

    // Back to parked semantics: the task is ready again (no run in flight).
    this.taskDAO
      .getDb()
      .prepare("UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND deleted_at IS NULL")
      .run("ready", nowIso, id)

    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: id, status: "ready", schedule_id: root.id, origin_type: "task" },
    })
    this.sse.emit("taskpool", {
      event: TASK_TRIGGER_EVENT,
      data: { task_id: id, action: "cancelled", scheduled_at: null },
    })

    const row = this.taskDAO.getById(id)!
    return toDTO(row)
  }

  // ── Dispatch phase/round (ticket 05 — v4 一 task 一 ws / 一 task 一信封) ──

  /** task-phase-redesign (ticket 05, K4/K5/K6): start ONE round execution of a
   *  v4 task under the EXISTING envelope, on the task's BOUND workspace. The
   *  first phase/round goes through the unchanged trigger→claim→execute path
   *  (ticket 04 pre-loads chain[0]=phase1; WorkflowExecutor first-builds +
   *  writes the tasks.workspace_id binding). Everything later — phase advance
   *  (auto_advance) and 打回 retry — calls THIS method (票 07 owns the
   *  acceptance endpoint that drives it).
   *
   *  Shape (照 WorkflowExecutor.triggerChildStep 的同 ws 复用写法):
   *    ① reuse the envelope (K5 — no new schedule row; it flips done/failed →
   *       claimed with chain[0] rewritten to the target phase + `_phase_index`/
   *       `_round_index` management-key stamps so a crash-recovery re-claim
   *       re-tags identically); feedback (K7 打回文本) rides along as the
   *       `feedback` input value — the fix-feedback-rN.md FILE is 票 08's seed
   *       step, not this dispatch's;
   *    ② insert a fresh schedule_executions slot: the partial unique index
   *       idx_sched_execs_unique_active (schedule_id WHERE status IN
   *       ('triggered','running')) is the structural serialization gate (K5 —
   *       零额外并发代码). A collision ⇒ explainable TaskStatusConflictError
   *       (AC2), never a silent queue-behind;
   *    ③ service.create + start on the bound ws (zero git involvement ⇒ the
   *       worktree/branch established at first build is inherited verbatim —
   *       phase/round 不换支, 票03清单#4);
   *    ④ tag the executions row phase_index/round_index (K4 — deriveTaskView
   *       与验收账本按 (phase,round) 直读该打标行);
   *    ⑤ register a terminal callback that RELEASES the active slot + flips
   *       the envelope back to done/failed — without it no next round could
   *       ever dispatch. Task-status derivation (awaiting_review 等) is 票 07's
   *       deriveTaskView wiring, deliberately NOT mirrored here (K3: 派生不存).
   *
   *  Errors: unknown task → TaskNotFoundError; non-v4 spec / missing envelope /
   *  unknown phase index / no bound ws / unavailable ws / active-slot conflict
   *  → TaskStatusConflictError with a self-explanatory message. */
  async dispatchPhaseRound(
    taskId: string,
    phaseIdx: number,
    roundIdx: number,
    feedback?: string,
  ): Promise<{ scheduleId: string; schedExecId: string; executionId: string; workspaceId: string }> {
    const task = this.taskDAO.getById(taskId)
    if (!task) throw new TaskNotFoundError()
    if (!Number.isInteger(phaseIdx) || phaseIdx < 1 || !Number.isInteger(roundIdx) || roundIdx < 1) {
      throw new TaskStatusConflictError(
        `非法 phase/round: phase=${phaseIdx}, round=${roundIdx}（均为 ≥1 整数）`,
      )
    }
    const spec = parseJSON<{ format?: string }>(task.task_spec, {})
    if (spec.format !== "v4") {
      throw new TaskStatusConflictError("dispatchPhaseRound 仅适用于 v4 任务（task_spec.format==='v4'）")
    }

    const envelope = this.scheduleDAO
      .findSchedulesByOrigin("task", taskId)
      .find((r) => r.origin_role === "primary")
    if (!envelope) {
      throw new TaskStatusConflictError("未找到任务的执行信封（K5 一封套）— 请先入队并触发首 phase")
    }
    const config = parseJSON<Record<string, unknown>>(envelope.config, {})
    const phases = (config.phases ?? []) as TaskV4PhaseConfig[]
    const phase = phases.find((p) => p.index === phaseIdx)
    if (!phase) {
      throw new TaskStatusConflictError(`phase ${phaseIdx} 不在信封已解析的 phases[] 中（共 ${phases.length} 项）`)
    }
    const workspaceId = task.workspace_id
    if (!workspaceId) {
      throw new TaskStatusConflictError(
        "任务 workspace 尚未创建 — 首执行请走 trigger（draft→claim→execute 负责首建 + 绑定 tasks.workspace_id）",
      )
    }

    const now = new Date()
    const nowIso = now.toISOString()

    // ② active slot — the unique index serializes rounds structurally (K5/AC2).
    const schedExecId = randomUUID()
    try {
      this.runDAO.insertTriggeredExecution(
        schedExecId, envelope.id, "manual", nowIso, "+00:00", envelope.timezone, "task-dispatch",
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      throw new TaskStatusConflictError(
        `同一信封已有进行中的执行 — active 唯一索引拒绝并发派发（同一 task 串行，终态后再试）: ${message}`,
      )
    }

    // ① envelope rewrite: chain[0] := target phase (feedback + recovery stamps).
    // All values are strings by construction (phase.inputValues is the gate's
    // resolved Record<string,string>; feedback + stamps stringify to string) —
    // ExecutionService.start is typed Record<string,string>.
    const stepInputValues: Record<string, string> = {
      ...phase.inputValues,
      ...(feedback && feedback.trim() ? { feedback } : {}),
      _phase_index: String(phaseIdx),
      _round_index: String(roundIdx),
    }
    const nextConfig = {
      ...config,
      workflow_chain: [{ workflow_ref: phase.workflowRef, input_values: stepInputValues }],
    }
    this.scheduleDAO.updateSchedule(envelope.id, {
      config: JSON.stringify(nextConfig),
      status: "claimed",
      claimed_at: nowIso,
      scheduled_at: null,
    })

    // ③ start on the BOUND ws — static getExecutionService import (see header).
    const releaseSlotFailed = (reason: string): void => {
      this.runDAO.markExecutionFailed(schedExecId, reason, ["triggered", "running"])
      this.scheduleDAO.updateSchedule(envelope.id, { status: "failed", claimed_at: null })
    }
    let registry: ReturnType<typeof getExecutionService>
    try {
      registry = getExecutionService(workspaceId)
    } catch (err: unknown) {
      // Registry not initialized (ad-hoc/embedded callers) — same shape as an
      // unavailable ws.
      const message = err instanceof Error ? err.message : String(err)
      releaseSlotFailed(`ExecutionService 不可用: ${message}`)
      throw new TaskStatusConflictError(`ExecutionService 不可用: ${message}`)
    }
    if (!registry) {
      releaseSlotFailed(`workspace ${workspaceId} 不可用（行缺失或路径失效）`)
      throw new TaskStatusConflictError(`任务绑定的 workspace 不可用: ${workspaceId}`)
    }

    // task-phase-redesign (ticket 06, K9/K16): v4 seed 下行 — 开跑前把本 phase
    // 批次目录 {home}/.scratch/<date>/<slug>/ 物理拷贝进 ws 同构相对位（home 覆盖
    // ws 同名；同 copyTaskWorkflowsToWs 先例，非致命 — 瞬时 fs 错误不该烧掉
    // dispatch slot，执行侧缺输入由 wf 自己报错）。每个 round 都 seed ⇒ 运行期
    // 对 home spec 的编辑在下一 round 生效（K16 冻结策略）。
    try {
      const rel = batchRelPath(this.taskHomeService.homePath(taskId), phase.specDir)
      if (rel) {
        const seeded = seedPhaseToWorkspace(phase.specDir, registry.wsPath, rel)
        if (seeded > 0) {
          console.log(
            `[TasksService] seeded ${seeded} artifact file(s) into ws ${registry.wsPath}/${rel} (phase ${phaseIdx} round ${roundIdx})`,
          )
        }
      }
    } catch (err: unknown) {
      console.error(
        `[TasksService] phase-round seed failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }

    let execution: { id: string }
    try {
      execution = registry.service.create(workspaceId, {
        workflow_ref: phase.workflowRef,
        triggered_by: "scheduler",
        input_values: stepInputValues,
        initial_var_pool: {
          "schedule.id": envelope.id,
          "schedule.name": envelope.name,
          "schedule.triggered_at": nowIso,
          "execution.trigger_type": "phase_round",
        },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      releaseSlotFailed(`execution create failed: ${message}`)
      throw new TaskStatusConflictError(`round 执行创建失败: ${message}`)
    }

    this.runDAO.updateExecutionWorkspace(schedExecId, workspaceId)
    this.runDAO.updateExecutionLinkId(schedExecId, execution.id)
    this.runDAO.markExecutionRunning(schedExecId)

    // ④ tag the executions row (K4). Raw UPDATE on the shared handle (same
    // system-event pattern as the status writes above).
    this.taskDAO
      .getDb()
      .prepare("UPDATE executions SET phase_index = ?, round_index = ?, updated_at = ? WHERE id = ?")
      .run(phaseIdx, roundIdx, nowIso, execution.id)

    // ⑤ ws association — record the ESTABLISHED branch suffix (per-task
    // constant by K5; the dispatch never touches git, 票03清单#4).
    const lastSuffix = this.scheduleDAO
      .getDb()
      .prepare(
        "SELECT branch_suffix FROM schedule_workspaces WHERE schedule_id = ? AND branch_suffix IS NOT NULL AND branch_suffix != '' ORDER BY started_at DESC LIMIT 1",
      )
      .get(envelope.id) as { branch_suffix: string } | undefined
    const schedWsId = randomUUID()
    this.scheduleDAO.insertScheduleWorkspace({
      id: schedWsId,
      schedule_id: envelope.id,
      workspace_id: workspaceId,
      status: "running",
      branch_suffix: lastSuffix?.branch_suffix ?? "",
      started_at: nowIso,
    })

    // ⑥ terminal callback — releases the active slot so the NEXT round can
    // dispatch (and the stale-claimed sweep can recover a crashed round).
    const triggeredAt = now.getTime()
    registry.service.registerExternalCallbacks(
      {
        onComplete: ((engineFinalStatus?: string) => {
          this.finalizePhaseRoundExecution({
            schedExecId, schedWsId, executionId: execution.id,
            scheduleId: envelope.id, workspaceId, triggeredAt, engineFinalStatus,
            // ticket 06: collect 上行 needs the task + phase to locate the batch dir.
            taskId, phaseIdx,
          })
        }) as unknown as (finalStatus?: string) => void,
      } as never,
      execution.id,
    )

    registry.service.start(execution.id, stepInputValues).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[TasksService] dispatchPhaseRound start failed`, {
        executionId: execution.id, scheduleId: envelope.id, error: message,
      })
      this.runDAO.markExecutionFailed(schedExecId, message, ["triggered", "running"])
      registry.service.clearExternalCallbacks(execution.id)
    })

    // Board badge: the envelope re-entered in-flight (it was done/failed).
    this.sse.emit("taskpool", {
      event: "schedule_status",
      data: { schedule_id: envelope.id, status: "claimed", phase_index: phaseIdx, round_index: roundIdx },
    })

    return { scheduleId: envelope.id, schedExecId, executionId: execution.id, workspaceId }
  }

  /** Mirror of WorkflowExecutor.handleChainComplete's FINALIZE subset for a
   *  dispatchPhaseRound-started execution (the chain/parent-resume machinery
   *  does not apply — a phase/round run is a single root execution per phase).
   *  Status resolution follows the goal-task-dev lesson verbatim: prefer the
   *  persisted terminal status, fall back to the engine's in-flight report. */
  private finalizePhaseRoundExecution(opts: {
    schedExecId: string
    schedWsId: string
    executionId: string
    scheduleId: string
    workspaceId: string
    triggeredAt: number
    engineFinalStatus?: string
    taskId: string
    phaseIdx: number
  }): void {
    try {
      const FINAL_STATUSES = new Set(["completed", "completed_with_failures", "failed", "cancelled", "rejected"])
      const dbRow = this.taskDAO
        .getDb()
        .prepare("SELECT status, round_index FROM executions WHERE id = ?")
        .get(opts.executionId) as { status: string; round_index: number | null } | undefined
      const status = dbRow && FINAL_STATUSES.has(dbRow.status)
        ? dbRow.status
        : (opts.engineFinalStatus ?? dbRow?.status ?? "completed")
      const ok = status === "completed"
      const durationMs = Date.now() - opts.triggeredAt
      const nowIso = new Date().toISOString()

      // Terminal slot → the active unique index releases for the next round.
      this.runDAO.markExecutionCompleteWithDuration(
        opts.schedExecId, ok ? "completed" : "failed", durationMs,
        ok ? undefined : `phase-round execution ${status}`,
      )
      this.scheduleDAO.updateScheduleWorkspaceStatus(opts.schedWsId, {
        status: ok ? "completed" : "failed",
        execution_id: opts.executionId,
        completed_at: nowIso,
      })
      this.scheduleDAO.updateSchedule(opts.scheduleId, {
        status: ok ? "done" : "failed",
        claimed_at: null,
      })
      this.sse.emit("taskpool", {
        event: "schedule_status",
        data: { schedule_id: opts.scheduleId, status: ok ? "done" : "failed" },
      })
      // P3 (review): terminal on a v4 tagged round = the round awaits its
      // human decision — fire phase_status_update BEFORE collect (the
      // transition is about the execution, not file flow). After slot release
      // so a racing re-dispatch can't observe awaiting_review mid-slot.
      emitPhaseAwaitingReview(
        (c, p) => this.sse.emit(c, p),
        opts.taskId,
        opts.phaseIdx,
        dbRow?.round_index ?? 1,
      )
      // task-phase-redesign (ticket 06, K9): v4 collect 上行 — 回收 ws 批次目录中
      // 执行侧改过/新增的文件回 task home（spec*.md home 权威不回流覆盖；issues/
      // 报告 ws 权威按 mtime 上行），有回收则 emit task_artifacts_update(taskId)。
      // 独立 try：collect 失败只降级为「看板产物区晚一帧」，绝不吞掉上面的 slot
      // 释放，也不能跳过下面的回调清理。
      try {
        this.collectPhaseRoundArtifacts(opts.taskId, opts.scheduleId, opts.phaseIdx, opts.workspaceId)
      } catch (err: unknown) {
        console.error(
          `[TasksService] phase-round collect failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        )
      }
      // Callback cleanup — non-fatal (the ws registry may be gone; the engine
      // ignores stale callbacks after terminal anyway).
      try {
        getExecutionService(opts.workspaceId)?.service.clearExternalCallbacks(opts.executionId)
      } catch { /* registry unavailable — non-fatal */ }
    } catch (err: unknown) {
      console.error(
        `[TasksService] finalizePhaseRoundExecution failed for ${opts.schedExecId} (non-fatal — stale sweep backstops):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** ticket 06 collect 上行 (dispatchPhaseRound 路径的终态镜像；首触/claim 路径
   *  的对应挂在 WorkflowExecutor.handleChainComplete — 两处都以 v4 打标为前提).
   *  Reads the phase's materialized specDir (票04 信封) from the envelope, mirrors
   *  `{ws}/{relBatchPath}` back into home and emits TASK_ARTIFACTS_UPDATE_EVENT
   *  only when something actually flowed (unchanged round ⇒ no SSE noise; the
   *  seed/collect mtime discipline makes re-collection idempotent). ws registry
   *  gone (out-of-band deletion) ⇒ nothing to recover — home already holds the
   *  last collected state (AC4 防丢兜底). */
  private collectPhaseRoundArtifacts(
    taskId: string,
    scheduleId: string,
    phaseIdx: number,
    workspaceId: string,
  ): void {
    const specDir = resolvePhaseSpecDir(this.scheduleDAO.findById(scheduleId)?.config ?? "", phaseIdx)
    if (!specDir) return
    const rel = batchRelPath(this.taskHomeService.homePath(taskId), specDir)
    if (!rel) return
    const wsPath = getExecutionService(workspaceId)?.wsPath
    if (!wsPath) return
    const collected = collectFromWorkspace(path.join(wsPath, rel), specDir)
    if (collected.length === 0) return
    console.log(
      `[TasksService] collected ${collected.length} artifact file(s) from ws back to home (task ${taskId}, phase ${phaseIdx})`,
    )
    this.sse.emit("taskpool", {
      event: TASK_ARTIFACTS_UPDATE_EVENT,
      data: { task_id: taskId },
    })
  }

  // ── Acceptance gate (task-phase-redesign ticket 07 — K3/K6/K7) ─────

  /** POST /api/tasks/:id/acceptance — the human 验收 decision on one phase round.
   *
   *  Validation reads the DERIVED state (票 03's deriveTaskView is the single
   *  truth — this method re-implements none of the matrix): the target phase
   *  must be in 'awaiting_review' and `round_index` must be exactly its
   *  awaitingRound, else 409 (AC4). A (phase,round) that already carries a
   *  ledger row is refused as well — the append-only table CAN hold duplicates
   *  by design, but a round gets one human decision (idempotency belt for the
   *  spec-R2 concurrent POST/PUT window).
   *
   *  Effects (K6/K7), all after the ledger append:
   *    accepted ∧ i<n ∧ autoAdvance(默认开) → dispatchPhaseRound(i+1, 1)
   *    accepted ∧ i=n                        → persisted 'archiving' + 票 08 hook
   *    accepted ∧ autoAdvance=false          → nothing starts (awaiting_manual_trigger)
   *    rejected                              → `fix-feedback-r{N}.md` written into
   *                                            the phase's batch dir (home) +
   *                                            dispatchPhaseRound(i, R+1) where
   *                                            R+1 = 该 phase 账本 rejected 行数 + 1
   *
   *  Persisted-status normalization: the SG2 listener mirrors the FIRST round's
   *  terminal transition onto tasks.status ('done'/'failed'), and dispatch
   *  never touches it — so after acceptance we realign the row with what the
   *  human just authorized ('running' when a round started, 'ready' when the
   *  task parks at the manual gate). Without this a v4 task could not be
   *  aborted after acceptance (abortTask only accepts ready/running). K3 is
   *  NOT violated: these are the states the derivation itself reports for the
   *  post-decision world, written at a *human decision* point — never a mirror
   *  of a machine transition.
   *
   *  The ledger write is intentionally NOT rolled back when the dispatch then
   *  fails (ws gone / slot busy → TaskStatusConflictError → 409): the decision
   *  is historical fact; the phase derives to 'pending' and the retry is a
   *  human action (K6 重试永远人工发起). */
  async acceptance(taskId: string, input: AcceptanceInput): Promise<AcceptanceResult> {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    const spec = parseJSON<TaskSpec>(row.task_spec, { goal: "", ac: [] } as unknown as TaskSpec)
    if (spec.format !== "v4") {
      throw new TaskStatusConflictError("验收仅适用于 v4 任务（task_spec.format === 'v4'）")
    }

    const view = this.deriveView(row)
    const pos = view.phaseViews.findIndex((p) => p.index === input.phase_index)
    const pv = pos >= 0 ? view.phaseViews[pos] : undefined
    if (!pv) {
      throw new TaskStatusConflictError(
        `phase ${input.phase_index} 不在任务 phases[] 中（共 ${view.phaseViews.length} 个）`,
      )
    }
    if (this.acceptanceDAO.listByRound(taskId, pv.index, input.round_index).length > 0) {
      throw new TaskStatusConflictError(
        `phase ${pv.index} round ${input.round_index} 已验收，不可重复提交（账本 append-only，一次决定）`,
      )
    }
    if (pv.status !== "awaiting_review" || pv.awaitingRound !== input.round_index) {
      throw new TaskStatusConflictError(
        `phase ${pv.index} 当前派生态 '${pv.status}'` +
          (pv.awaitingRound !== null ? `（待验收轮 ${pv.awaitingRound}）` : "（无待验收轮）") +
          `，与请求 round ${input.round_index} 不匹配`,
      )
    }

    // 位置而非 index+1 —— phases[] 的 index 由作者给（spec-r2 重写过编号也合法），
    // 「下一个 phase」是数组意义上的下一项，末项 = i=n（K6）。
    const isLast = pos === view.phaseViews.length - 1
    const nextPhaseIndex = isLast ? null : view.phaseViews[pos + 1].index
    const acceptanceId = randomUUID()
    const feedback = (input.feedback ?? "").trim()
    this.acceptanceDAO.insert({
      id: acceptanceId,
      task_id: taskId,
      phase_index: pv.index,
      round_index: input.round_index,
      decision: input.decision,
      feedback: input.decision === "rejected" ? feedback : null,
    })

    let dispatch: AcceptanceDispatch | undefined
    let next_action: AcceptanceNextAction

    if (input.decision === "rejected") {
      // K7: 反馈产物化进 phase 批次目录（下一 round 的 seed 会把它带进 ws，
      // 与 input_values.feedback 双通道；N = 被打回的那一轮）。
      this.writeFixFeedbackArtifact(taskId, pv.index, pv.name, pv.slug, input.round_index, feedback)
      // 轮号规则（票 07）: 同一 phase 的 rejected 行数 + 1 —— 打完一轮长一轮。
      const rejectedCount = this.acceptanceDAO
        .listByPhase(taskId, pv.index)
        .filter((r) => r.decision === "rejected").length
      const nextRound = rejectedCount + 1
      const d = await this.dispatchPhaseRound(taskId, pv.index, nextRound, feedback)
      dispatch = {
        schedule_id: d.scheduleId,
        execution_id: d.executionId,
        workspace_id: d.workspaceId,
        phase_index: pv.index,
        round_index: nextRound,
      }
      next_action = "dispatched"
      this.setPersistedTaskStatus(taskId, "running")
      this.emitPhaseStatus(taskId, pv.index, "running", nextRound)
    } else {
      // accepted — 人的放行先落帧（UI 立刻把该 phase 变绿）。
      this.emitPhaseStatus(taskId, pv.index, "accepted", input.round_index)
      if (isLast) {
        next_action = "archiving"
        this.beginArchiving(taskId)
      } else if (nextPhaseIndex !== null && spec.autoAdvance !== false) {
        const d = await this.dispatchPhaseRound(taskId, nextPhaseIndex, 1)
        dispatch = {
          schedule_id: d.scheduleId,
          execution_id: d.executionId,
          workspace_id: d.workspaceId,
          phase_index: nextPhaseIndex,
          round_index: 1,
        }
        next_action = "dispatched"
        this.setPersistedTaskStatus(taskId, "running")
        this.emitPhaseStatus(taskId, nextPhaseIndex, "running", 1)
      } else {
        // K6/US11: 每个 phase 都停在人的 gate，下一 phase 等人工起。
        next_action = "awaiting_manual_trigger"
        this.setPersistedTaskStatus(taskId, "ready")
      }
    }

    return { task: this.getTask(taskId), next_action, ...(dispatch ? { dispatch } : {}), acceptance_id: acceptanceId }
  }

  /** Flip the persisted status into 'archiving' and hand off to 票 08.
   *  done is 票 08's exclusive writer (K3: 归档全绿才算 done) — this method only
   *  states the task + starts the orchestration: an explicitly-set hook wins
   *  (票 07 harness / embedders), otherwise the BUILT-IN archiver runs the K11
   *  归并面 (ADR 顺延 / 术语 append / commit+push+PR → endArchiving=done).
   *  Fire-and-forget: a failed archive leaves the task parked in 'archiving',
   *  retryable via POST /:id/archive/retry (K3/US15). */
  private beginArchiving(taskId: string): void {
    this.setPersistedTaskStatus(taskId, "archiving")
    if (this.archivingHook) {
      try {
        const maybe = this.archivingHook(taskId)
        if (maybe && typeof (maybe as Promise<void>).then === "function") {
          void (maybe as Promise<void>).catch((err: unknown) => {
            console.error(
              `[TasksService] archiving hook failed for ${taskId} (task parked in 'archiving', retry=POST /:id/archive/retry):`,
              err instanceof Error ? err.message : String(err),
            )
          })
        }
      } catch (err: unknown) {
        console.error(
          `[TasksService] archiving hook threw for ${taskId} (non-fatal — status already 'archiving'):`,
          err instanceof Error ? err.message : String(err),
        )
      }
      return
    }
    void this.startArchiveRun(taskId)
  }

  // ── Archiving 编排 (ticket 08 — K11 归档面 / 幂等续跑) ──────────────

  private archiver: TaskArchiver | null = null
  /** taskId → the LATEST started run (observable seam for tests/UI — 202 is
   *  fire-and-forget, the promise is the only join point). */
  private archiveRuns = new Map<string, Promise<ArchiveReport>>()
  /** Guards against two concurrent runs on the same task (a double retry POST
   *  would otherwise race the same worktrees). Set while a run is in flight. */
  private runningArchives = new Set<string>()

  /** 票 08: the built-in archiver, lazily assembled against THIS service's
   *  db handle + task-home dir (endArchiving is injected as the sole 'done'
   *  writer — the archiver itself never touches tasks.status). */
  private getArchiver(): TaskArchiver {
    if (!this.archiver) {
      this.archiver = createTaskArchiver({
        db: this.db,
        taskHomeService: this.taskHomeService,
        onComplete: (taskId) => this.endArchiving(taskId),
      })
    }
    return this.archiver
  }

  /** Start one orchestration run. archiveTask resolves with the report
   *  (never rejects for per-project git failures — those land IN the report);
   *  precondition throws (task gone / non-v4) are converted to a failed
   *  report here so the fire-and-forget path can never produce an
   *  unhandled rejection. */
  private startArchiveRun(taskId: string): Promise<ArchiveReport> {
    if (this.runningArchives.has(taskId)) {
      const inFlight = this.archiveRuns.get(taskId)
      if (inFlight) return inFlight
    }
    this.runningArchives.add(taskId)
    const p = this.getArchiver()
      .archiveTask(taskId)
      .catch((err: unknown): ArchiveReport => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[TasksService] archiving run failed for ${taskId} (task parked in 'archiving', retry=POST /:id/archive/retry):`,
          message,
        )
        return { taskId, date: "", ok: false, projects: [], unattributedAdrs: [], unattributedNotes: 0, error: message }
      })
      .finally(() => this.runningArchives.delete(taskId))
    this.archiveRuns.set(taskId, p)
    return p
  }

  /** The promise of the most recent archiving run for this task (null = none
   *  started through this process). Await seam for 202 callers/tests. */
  awaitArchiving(taskId: string): Promise<ArchiveReport> | null {
    return this.archiveRuns.get(taskId) ?? null
  }

  /** POST /api/tasks/:id/archive/retry — project 粒度幂等续跑 (K11/US15).
   *  ONLY the persisted 'archiving' state is retryable (409 otherwise; 404
   *  unknown). Validates synchronously, then fires the run WITHOUT awaiting
   *  (the route answers 202; completion flips the task to done asynchronously).
   *  A retry while a run is still in flight reuses that run (idempotent). */
  retryArchive(taskId: string): TaskDTO {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    if (row.status !== "archiving") {
      throw new TaskStatusConflictError(
        `只有归档中(archiving)的任务可以重试归档 (当前状态: '${row.status}')`,
      )
    }
    const spec = parseJSON<{ format?: string }>(row.task_spec, {})
    if (spec.format !== "v4") {
      throw new TaskStatusConflictError("归档重试仅适用于 v4 任务（task_spec.format === 'v4'）")
    }
    void this.startArchiveRun(taskId)
    const fresh = this.taskDAO.getById(taskId) ?? row
    return toDTO(fresh)
  }

  /** 票 08: ALL projects green → 'done' (the task's only archive-completion
   *  writer; K3 归档全绿才算 done). Sets completed_at and emits task_status
   *  so the board card leaves 「归档中」. Belt: only fires from 'archiving' —
   *  an out-of-band abort meanwhile is never resurrected. */
  private endArchiving(taskId: string): void {
    const row = this.taskDAO.getById(taskId)
    if (!row || row.status !== "archiving") return
    const nowIso = new Date().toISOString()
    this.taskDAO
      .getDb()
      .prepare("UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run("done", nowIso, nowIso, taskId)
    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: taskId, status: "done" },
    })
    console.log(`[TasksService] task ${taskId} archived → done (ws retention exemption lifted)`)
  }

  /** POST /api/tasks/:id/advance — 票 07 移交裁决 (US11/auto_advance=false 的
   *  人工起下一 phase；also covers 「上 phase 已 accepted 但派发失败」 — both
   *  observably = 前序 phase accepted ∧ 下一 phase pending in the derived view).
   *  ONLY v4 tasks; ONLY when such a (predecessor-accepted ∧ pending) phase
   *  pair exists — every other world (phase 1 未触发、running、awaiting_review、
   *  archiving、全 accepted) → 409. Dispatches round 1 of the first such phase
   *  on the bound ws; triggerTask is untouched (K6 首 phase 仍人工触发)。 */
  async advancePhase(taskId: string): Promise<{
    task: TaskDetailDTO
    next_action: "dispatched"
    dispatch: AcceptanceDispatch
  }> {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    const spec = parseJSON<TaskSpec>(row.task_spec, { goal: "", ac: [] } as unknown as TaskSpec)
    if (spec.format !== "v4") {
      throw new TaskStatusConflictError("advance 仅适用于 v4 任务（task_spec.format === 'v4'）")
    }
    const view = this.deriveView(row)
    let target: TaskPhaseView | null = null
    for (let pos = 1; pos < view.phaseViews.length; pos++) {
      const prev = view.phaseViews[pos - 1]
      const cur = view.phaseViews[pos]
      if (prev.status === "accepted" && cur.status === "pending") {
        target = cur
        break
      }
    }
    if (!target) {
      throw new TaskStatusConflictError(
        "无可推进的 phase — 需存在「前序 phase 已 accepted ∧ 该 phase 仍 pending」" +
          `（当前: ${view.phaseViews.map((p) => `phase${p.index}=${p.status}`).join(", ") || "无 phases"}）`,
      )
    }
    const d = await this.dispatchPhaseRound(taskId, target.index, 1)
    this.setPersistedTaskStatus(taskId, "running")
    this.emitPhaseStatus(taskId, target.index, "running", 1)
    return {
      task: this.getTask(taskId),
      next_action: "dispatched",
      dispatch: {
        schedule_id: d.scheduleId,
        execution_id: d.executionId,
        workspace_id: d.workspaceId,
        phase_index: target.index,
        round_index: 1,
      },
    }
  }

  /** 票 07: feedback 产物化 — `{home}/.scratch/<date>/<slug>/fix-feedback-r{N}.md`
   *  (K7/K10). The batch dir comes from the envelope's materialized specDir
   *  (票 04), falling back to the home-relative specPath dirname; if neither is
   *  resolvable the write is skipped with a warning — the `feedback` input
   *  value still reaches the round (dispatchPhaseRound), so the failure
   *  degrades the traceability artifact, never the retry itself. */
  private writeFixFeedbackArtifact(
    taskId: string,
    phaseIndex: number,
    phaseName: string,
    slug: string,
    roundIndex: number,
    feedback: string,
  ): void {
    const specDir = this.phaseSpecDir(taskId, phaseIndex)
    if (!specDir) {
      console.warn(
        `[TasksService] acceptance: cannot resolve phase ${phaseIndex} spec dir for task ${taskId} — fix-feedback-r${roundIndex}.md skipped`,
      )
      return
    }
    const file = path.join(specDir, `fix-feedback-r${roundIndex}.md`)
    const body =
      `# 打回反馈 · Round ${roundIndex} — ${phaseName} (phase ${phaseIndex}, ${slug})\n\n` +
      `- task: ${taskId}\n` +
      `- decided_at: ${new Date().toISOString()}\n\n` +
      `## 反馈\n\n${feedback}\n`
    try {
      fs.mkdirSync(specDir, { recursive: true })
      fs.writeFileSync(file, body, "utf-8")
    } catch (err: unknown) {
      console.error(
        `[TasksService] acceptance: writing ${file} failed (non-fatal — feedback still dispatched):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** The phase's absolute batch dir (home mirror of the ws `.scratch/<date>/
   *  <slug>/`, K10): envelope specDir first (it is what seed/collect use), then
   *  the raw task_spec's home-relative specPath dirname. */
  private phaseSpecDir(taskId: string, phaseIndex: number): string | null {
    const env = this.scheduleDAO
      .findSchedulesByOrigin("task", taskId)
      .find((r) => r.origin_role === "primary")
    const cfg = parseJSON<{ phases?: TaskV4PhaseConfig[] }>(env?.config ?? "", {})
    const fromEnvelope = cfg.phases?.find((p) => p.index === phaseIndex)?.specDir
    if (fromEnvelope) return fromEnvelope
    const task = this.taskDAO.getById(taskId)
    if (!task) return null
    const spec = parseJSON<TaskSpec>(task.task_spec, { goal: "", ac: [] } as unknown as TaskSpec)
    const p = (spec.phases ?? []).find((x) => x.index === phaseIndex)
    if (!p) return null
    const abs = path.isAbsolute(p.specPath) ? p.specPath : path.join(this.taskHomeService.homePath(taskId), p.specPath)
    return path.dirname(abs)
  }

  private emitPhaseStatus(
    taskId: string,
    phaseIndex: number,
    status: TaskPhaseStatus,
    roundIndex: number,
  ): void {
    this.sse.emit("taskpool", {
      event: PHASE_STATUS_UPDATE_EVENT,
      data: { task_id: taskId, phase_index: phaseIndex, status, round_index: roundIndex },
    })
  }

  /** K16 (task-phase-redesign): the spec edit window. v3 keeps the original
   *  discipline (draft/ready only — byte-stable, K13). A v4 task's spec stays
   *  editable through its whole working life: the review-gate spec-field PUT
   *  (round-2 spec, propagation writes per D14, autoAdvance toggle) is part of
   *  the flow, and an edit during a running round takes effect at the NEXT
   *  seed (K16: 隔离即冻结 — seed is a one-way snapshot, no lock needed).
   *  Frozen only at human-decided terminal states: done / aborted / archiving
   *  (归档中 spec 已定稿，改动应走 archive/retry 后的另案). */
  private isSpecEditable(existing: TaskRow): boolean {
    if (existing.status === "draft" || existing.status === "ready") return true
    if (!isV4TaskSpec(existing.task_spec)) return false
    return (
      existing.status !== "done" &&
      existing.status !== "aborted" &&
      existing.status !== "archiving"
    )
  }

  /** System-event status write (no version bump — the optimistic lock tracks
   *  spec edits, mirrors triggerTask/abortTask/TaskScheduleStatusListener).
   *  Idempotent fast-path: same value → no UPDATE, no SSE (no board flicker on
   *  re-derivation of an unchanged state). */
  private setPersistedTaskStatus(taskId: string, status: TaskStatus): void {
    const row = this.taskDAO.getById(taskId)
    if (!row || row.status === status) return
    const nowIso = new Date().toISOString()
    this.taskDAO
      .getDb()
      .prepare(
        "UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND deleted_at IS NULL",
      )
      .run(status, nowIso, taskId)
    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: taskId, status },
    })
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
   *  queued → aborted (never started). Terminal → skip (idempotent).
   *
   *  task-phase-redesign (ticket 05, 票03清单#6) — 'cleaned' semantics under ws
   *  REUSE: the marker closes the schedule_workspaces ASSOCIATION (that run's
   *  slot), NOT the workspace. The v4 task's ws is the round-打回 scene — it
   *  stays bound (tasks.workspace_id is deliberately untouched here) and stays
   *  on disk, so a later dispatchPhaseRound resumes on the same worktree/branch
   *  with all evidence intact. Nothing may delete a bound ws while the task is
   *  not 'done': enforceRetention exempts it (WorkflowExecutor, K12), and 'done'
   *  never arrives via abort — the binding outlives every non-archived state. */
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
   *  tasks are discardable; a running task must be aborted first.
   *
   *  04 (AC5/ADR-0011/SW-BP14): a DRAFT task's home dir (`~/.octopus/tasks/{id}/`)
   *  is reaped on delete (no orphan dirs). reapHome does NOT follow junctions/
   *  symlinks inside skills/ — a link to a registry skill source must not drag
   *  that source into the void. A non-draft task (ready/done/failed/aborted)
   *  PRESERVES its home (artifacts are the record of what ran; kept until a
   *  future hard-delete). Idempotent on a missing home (v2 tasks have none). */
  deleteTask(id: string): { ok: true } {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status === "running") {
      throw new TaskStatusConflictError(
        "Cannot delete a running task — abort it first",
      )
    }
    // 04 (AC5): draft → reap home (non-draft preserved). Done BEFORE the
    // soft-delete so a reap failure (locked file, etc.) doesn't leave the row
    // soft-deleted while the home lingers — the row stays active for a retry.
    if (existing.status === "draft") {
      try {
        this.taskHomeService.reapHome(id)
      } catch (err: unknown) {
        console.error(
          `[TasksService] deleteTask: reapHome failed for ${id} (non-fatal — task soft-deleted):`,
          err instanceof Error ? err.message : String(err),
        )
      }
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
