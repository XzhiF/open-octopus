// packages/server/src/services/tasks/tasks-service.ts
//
// TasksService — first-class `tasks` domain (v2-D1). Owns the
// draft→ready→running→done/failed/aborted lifecycle + task_spec (WHAT) +
// resource/skill bindings.
//
// ADR-0021 票03: a task owns its WHEN. There is no schedule row for a task — not one
// per task, not one per round. `tasks.trigger_*` is the due time, a run is an
// `executions` row carrying task_id, and the built-in task-lifecycle job
// (task-lifecycle-service.ts) is the only thing in the system that turns one into the
// other. What remains here is authoring, the read model, and the thin verbs
// (ready / trigger / cancel / abort / reopen / delete) that delegate launching.
//
// What this file used to do instead: readyTask pre-created a private `schedules` row
// per task (the "envelope" — origin_type='task', parked status='draft') and triggering
// meant flipping that row; its config doubled as the frozen phase binding AND the
// "which round runs now" cursor; composite subunits were child schedules created at
// runtime. That is the coupling this ticket removes, and why 周期触发 was structurally
// impossible: a task could only run when its envelope said so.
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
  type ArtifactIndexEntry,
  SPEC_FIELD_UPDATE_EVENT,
  TASK_ARTIFACTS_UPDATE_EVENT,
  TASK_STATUS_EVENT,
  TASK_TRIGGER_EVENT,
  TASK_EXECUTION_EVENT,
  PHASE_STATUS_UPDATE_EVENT,
  type Task,
  type TriggerMode,
  TriggerModeSchema,
  type TaskExecutionBadge,
  type TaskPhaseStatus,
  taskSpecSchema,
  TERMINAL_EXECUTION_STATUSES,
  validateSpecFieldValue,
  TaskSpecFieldError,
} from "@octopus/shared"
import {
  TaskDAO,
  AgentSessionDAO,
  AcceptanceDAO,
} from "../../db/dao"
import type { TaskRow, ExecutionRow } from "../../db/types"
import type { SSEService } from "../sse"
// task-phase-redesign (ticket 07): the acceptance API and the GET /:id view read
// state THROUGH ticket 03's pure derivation — never a re-implementation of its
// matrix (K3 派生不存, 唯一真相).
import { deriveTaskView, type TaskView, type TaskPhaseView, type DeriveExecutionInput } from "./derive-task-view"
import {
  buildTaskLaunchConfig,
  resolveV4Phases,
  type TaskV4PhaseConfig,
} from "./task-materialize"
// trigger-prebuild (2026-09-08): 与 WorkflowExecutor 共享的命名/复合判定纯函数。
import { isCompositeWorkflowConfig } from "../scheduler/ws-launch"
import { TaskLifecycleService, TaskLifecycleError, type ArmOptions } from "./task-lifecycle-service"
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
import type { BatchTreeEntry } from "./task-home-service"
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
// repo-sync / trigger-prebuild (2026-09-08): 类型注入（构造器尾参），运行时实例
// 由 index.ts 装配 — type-only import 避免 services 图新增环。
import type { RepoSyncService } from "./repo-sync-service"
import type { WorkspaceService } from "../workspace"
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

/** phase-handoff-chaining (ticket 01): 内置注入键名单源 — accepted→下一 phase 首轮
 *  materialized input_values 里的键（K3）。值 = 已 accepted 前序 phase 的
 *  handoff.md home 绝对路径，换行连接，空 ⇒ 键不出现。matt-spec-dev.yaml 的
 *  inputs/哨兵/vars 与 task-author SKILL 均按此字面对齐——rename 从这改起，
 *  测试侧保留字面量以钉住 wire 契约。 */
export const PREV_HANDOFF_PATHS_KEY = "prev_handoff_paths"

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
/**
 * The wire shape of a task is shared's `Task` — trigger columns (`trigger_mode` /
 * `next_fire_at` / …) and the current-instance badge (`execution`) on it. It used to be a
 * local duplicate carrying `schedule_status` + `scheduled_at` read off the private
 * envelope row; 票05 deletes the copy rather than maintaining two lists of the same
 * columns, because the copy is exactly how a DTO drifts back toward the thing it was
 * supposed to stop modelling.
 */
export type TaskDTO = Task

/** Task detail (GET /:id) — task + its run history. */
export interface TaskDetailDTO extends TaskDTO {
  /** Every root execution of this task, newest first — the run history that replaced
   *  children[], which listed the schedule rows standing for the same runs one
   *  indirection further away. Empty for a draft. The deep-link pair stays
   *  (workspace_id, id) → /workspaces/{ws}?tab=detail&execId={exec}. */
  executions: TaskExecutionBadge[]
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
  /** ADR-0018 打回二分路由（rejected 时生效）：
   *  - "rerun"（缺省）— 重跑 phase 绑定流 + feedback 注入（matt-spec-dev 绑定时
   *    即「修订重跑」：流内 spec 再审段就地更新 ws spec.md，collect 回流终态）。
   *  - "fix" — 轻量修复：chain override built-in/task-fix，输入由 server 合成
   *    （phase_spec_dir/feedback_path/task_artifacts_dir），起草期无需绑定 task-fix。
   *  override 只进 workflow_chain（K16 phases[] 冻结不破），仅作用本轮。 */
  next_flow?: "fix" | "rerun"
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
  // ── task-phase-redesign 契约修复 (POST 直建 v4) ──
  /** RAW initial task_spec (same service-owned-validation discipline as PUT /
   *  SW-BP9). Present → `taskSpecSchema.parse` (ZodError → 400); absent → the
   *  v3/v2 baseline `{goal:"",ac:[]}` (NOT parsed — byte-compat with the legacy
   *  tasks-routes tests). `{format:"v4"}` here creates a v4 draft directly:
   *  home + manifest.json snapshot carry the flag from the start (SKILL §1's POST
   *  recipe, previously silently dropped by the route). */
  task_spec?: unknown
  /** Top-level project ids (SKILL §1 recipe). When present wins over
   *  preset.projects; both land in the tasks.project_ids column. */
  project_ids?: string[]
  /** Creation-time column bindings (SKILL §1 sends these explicitly; the route
   *  parses with zod like the PUT path). Absent → DAO defaults ("[]"). */
  skills?: string[]
  resources?: ResourceRef[]
  authoring_resources?: ResourceRef[]
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

/** An instance row that is over. Single source with the latch/meter (ADR-0021). */
const TERMINAL_INSTANCES = new Set<string>(TERMINAL_EXECUTION_STATUSES)

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
    // A stored value outside the enum is impossible via the API, but a hand-edited row
    // must not crash the board — fall back to 'manual', the one mode the built-in job
    // never scans (fail-closed: an unreadable trigger never fires a round on its own).
    trigger_mode: TriggerModeSchema.safeParse(row.trigger_mode).success
      ? (row.trigger_mode as TriggerMode)
      : "manual",
    trigger_at: row.trigger_at,
    cron_expression: row.cron_expression,
    cron_timezone: row.cron_timezone,
    trigger_enabled: row.trigger_enabled === 1,
    next_fire_at: row.next_fire_at,
    last_fired_at: row.last_fired_at,
    execution: null,
  }
}

/** The one-line reason a run is red. Sourced from the row's var pool under `error`,
 *  which every failure writer now fills (setLaunchStatus's error opt, retireLaunch, and
 *  finalize lifting the engine's failed-node error) — surfaced only on a terminal-failure
 *  row so a green run can never show a stale key. */
function errorSummaryOf(row: ExecutionRow): string | null {
  if (row.status !== "failed" && row.status !== "aborted" && row.status !== "completed_with_failures") {
    return null
  }
  const v = parseJSON<Record<string, unknown>>(row.var_pool, {})
  return typeof v.error === "string" && v.error.trim() ? v.error : null
}

/** The task's current instance, projected for the DTO. Kept as a pure function of the
 *  row so list and detail cannot drift into two different badge shapes.
 *
 *  `children` is passed only by the read models that loaded the fan-out (detail / run
 *  history) — the board's badge deliberately carries none, and `undefined` vs `[]` says
 *  which of the two loaded, so the UI never renders "no subunits" for a list row. */
function toExecutionBadge(row: ExecutionRow, children?: ExecutionRow[]): TaskExecutionBadge {
  return {
    id: row.id,
    status: row.status,
    workflow_ref: row.workflow_ref,
    // The subunit's label (a child run's name IS which arm it is) — 票05's replacement
    // for reading `schedules.origin_role`.
    name: row.name ?? null,
    phase_index: row.phase_index ?? null,
    round_index: row.round_index ?? null,
    workspace_id: row.workspace_id,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
    error_summary: errorSummaryOf(row),
    ...(children ? { children: children.map((c) => toExecutionBadge(c)) } : {}),
  }
}

/** Group a task's child runs under the root that dispatched them (one pass, so the read
 *  model stays one query for the fan-out instead of one per root). */
function groupChildren(children: ExecutionRow[]): Map<string, ExecutionRow[]> {
  const by = new Map<string, ExecutionRow[]>()
  for (const c of children) {
    const list = by.get(c.parent_id)
    if (list) list.push(c)
    else by.set(c.parent_id, [c])
  }
  return by
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
  /** ADR-0021 票03: the ONLY way this domain starts, stops or watches a run. Built on
   *  the same handle as everything else here (no new ctor param — SW-BP15), and it is
   *  the task-domain half of the built-in job: the scheduler reaches the same object
   *  through the handler registered in index.ts. */
  private lifecycle: TaskLifecycleService
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

  /** repo-sync (2026-09-08): v4 draft 创建/项目变更时把选中项目主 clone 强制
   *  对齐 origin 默认分支的进程内状态机（A3 触发点 + B2 trigger 预建前的
   *  waitUntilIdle）。未注入 = 特性关（22 个既有测试构造零改动）。 */
  private repoSyncService: RepoSyncService | null
  /** trigger-prebuild (2026-09-08): 「触发执行」当场同步建 workspace+worktree
   *  （失败 409 弹回）。未注入 = 预建关，executor 首建兜底仍在（行为同日以前）。 */
  private workspaceService: WorkspaceService | null

  /** task-phase-redesign (ticket 07 → 票 08): late-bound archiving orchestrator.
   *  `acceptance` on the LAST phase flips the persisted status to 'archiving'
   *  and calls this hook; the orchestrator (ADR 顺延 / CONTEXT append / commit /
   *  PR → done, 票 08) is wired from index.ts and owns its own failure semantics
   *  (a failed archive leaves the task parked in 'archiving', retryable — K3/US15).
   *  Unwired (tests, ad-hoc embedders) ⇒ the status flip alone stands. */
  private archivingHook?: (taskId: string) => void | Promise<void>

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
    // repo-sync / trigger-prebuild (2026-09-08): 两个尾参，SW-BP15 纪律 —— 缺省
    // null 即特性关，既有 caller 一字不动。
    repoSyncService?: RepoSyncService | null,
    workspaceService?: WorkspaceService | null,
  ) {
    this.db = db
    this.taskDAO = new TaskDAO(db)
    this.agentSessionDAO = agentSessionDAO ?? null
    this.sse = sse
    this.taskHomeService = taskHomeService ?? new TaskHomeService()
    this.pluginMaterializer = pluginMaterializer ?? null
    this.builtInWorkflowService = builtInWorkflowService ?? null
    this.acceptanceDAO = new AcceptanceDAO(db)
    this.repoSyncService = repoSyncService ?? null
    this.workspaceService = workspaceService ?? null
    this.lifecycle = new TaskLifecycleService({
      db,
      sse,
      workspaceService: workspaceService ?? null,
      builtInWorkflows: builtInWorkflowService ?? null,
      taskHomeService: this.taskHomeService,
    })
  }

  /** ADR-0021: the launch machinery, exposed for the acceptance route + 票04's composite
   *  child pickup. Everything task-shaped that RUNS goes through this one object. */
  get taskLifecycle(): TaskLifecycleService {
    return this.lifecycle
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
   *  create path is unchanged (no home, no gate — backward compat).
   *
   *  契约修复 (v4 直建): `task_spec` present → validated via taskSpecSchema and
   *  used as the initial spec (ZodError → 400). `format:"v4"` now also triggers
   *  home creation (v4's gate/seed/snapshot all resolve specPath relative to the
   *  home — a homeless v4 draft is a dead end), even without task_type. Absent
   *  task_spec → the old unparsed baseline, byte-identical to pre-v4 behavior. */
  createTask(input: CreateTaskInput): TaskDTO {
    const id = randomUUID()
    const now = new Date().toISOString()
    const name = input.name?.trim() || DEFAULT_TASK_NAME
    const isV3 = !!input.task_type

    // 04 (D13): preset.org overrides the top-level org (the template page is the
    // source of the authoring context). preset.projects → project_ids (the
    // top-level project_ids field, SKILL §1, wins when present).
    const org = input.preset?.org ?? input.org
    const projectIds = input.project_ids ?? input.preset?.projects ?? []

    // 04 (D4): task_type + skill_groups live in task_spec, NOT authoring_resources.
    // Baseline goal/ac start empty (the authoring chat fills them via spec-field);
    // the baseline is stored WITHOUT taskSpecSchema.parse (goal="" / ac=[] would
    // fail the schema's min(1) — validation happens on PUT [save draft], by which
    // time the user has filled them in). A body-provided task_spec IS parsed —
    // same ZodError→400 discipline as updateTask (a v4 draft {format:"v4"} parses
    // clean because goal/ac are optional since ticket 01).
    let taskSpecObj: Record<string, unknown>
    if (input.task_spec !== undefined) {
      taskSpecObj = taskSpecSchema.parse(input.task_spec) as Record<string, unknown>
    } else {
      taskSpecObj = { goal: "", ac: [] }
    }
    if (isV3) {
      // task_type/skill_groups injection wins over the body (creation-locked
      // fields are server-owned; SW-BP9 rejects any later tampering).
      taskSpecObj.task_type = input.task_type
      taskSpecObj.skill_groups = input.skill_groups ?? []
    }
    const isV4 = taskSpecObj.format === "v4"

    this.taskDAO.insert({
      id,
      org,
      name,
      status: "draft",
      source_chat_session_id: input.source_chat_session_id ?? null,
      task_spec: JSON.stringify(taskSpecObj),
      project_ids: JSON.stringify(projectIds),
      ...(input.skills !== undefined ? { skills: JSON.stringify(input.skills) } : {}),
      ...(input.resources !== undefined ? { resources: JSON.stringify(input.resources) } : {}),
      ...(input.authoring_resources !== undefined
        ? { authoring_resources: JSON.stringify(input.authoring_resources) }
        : {}),
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
    // 契约修复: a v4 draft (format:"v4", with or without task_type) also gets a
    // home — gateV4Phases resolves relative specPaths against it, context.md is
    // the domain-reading routing table, and the manifest.json snapshot must exist.
    // Without task_type there are no skill groups → materialize is skipped (the
    // matt skill family arrives via the clone plugin layer, ticket 11/K15).
    if (isV3 || isV4) {
      const groups = input.skill_groups ?? []
      // Pass org + resolved project paths + skill groups to createHome so
      // context.md is populated from the start (not empty until the first
      // chat turn or a subsequent updateTask).
      const projectRefs = this.resolveProjectRefs(org, projectIds)
      const home = this.taskHomeService.createHome(id, { org, projects: projectRefs, skillGroups: groups })
      // repo-sync (2026-09-08, 特性A): v4 draft 创建即异步把选中项目的主 clone
      // 强制对齐 origin/<main|master> 最新（镜像语义，fire-and-forget — 绝不影响
      // 本次 HTTP 返回）。用户不变量：agent 分析读的就是这些路径，创建后它们必须
      // 尽快变新；完成/失败经 project_sync SSE 反馈（task-modal toast）。
      if (isV4 && projectIds.length > 0) {
        this.repoSyncService?.syncProjectsForTask(id, org, projectIds)
      }
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
    // 06: the POST body may carry spec fields — overwrite the baseline
    // manifest.json (written empty by createHome) with the real task_spec.
    this.writeManifestSnapshot(id)
    return toDTO(row)
  }

  // ── Read ──────────────────────────────────────────────────────────

  /** GET /api/tasks/:id — the task, its run history, and the derived phase view. */
  getTask(id: string): TaskDetailDTO {
    const row = this.taskDAO.getById(id)
    if (!row) throw new TaskNotFoundError()
    const history = this.lifecycle.history(id)
    const byParent = groupChildren(this.lifecycle.childRuns(id))
    const badge = (root: ExecutionRow) => toExecutionBadge(root, byParent.get(root.id) ?? [])
    const dto: TaskDTO = { ...toDTO(row), execution: history[0] ? badge(history[0]) : null }
    return {
      ...dto,
      executions: history.map(badge),
      derived: this.deriveView(row),
    }
  }

  /** task-phase-redesign (ticket 07): gather the three facts deriveTaskView
   *  needs and hand off — this service adds NO state logic of its own (K3).
   *
   *  Round executions are scoped by executions.task_id — the row IS the run, so there
   *  is nothing to join through (pre-票03 this walked schedules.origin_id →
   *  schedule_executions.execution_id, and the comment there argued at length why
   *  tasks.workspace_id was the wrong key; both objections dissolve once the launch
   *  carries its own task id: it is neither a location nor an indirection). The
   *  phase_index IS NOT NULL filter keeps child loop/swarm executions (and all
   *  v3/generic rows) out; derive ignores anything untagged anyway. */
  private deriveView(row: TaskRow): TaskView {
    const executions: DeriveExecutionInput[] = this.taskDAO
      .getDb()
      .prepare(
        `SELECT e.id, e.status, e.workflow_ref, e.phase_index, e.round_index, e.created_at
           FROM executions e
          WHERE e.task_id = ?
            AND e.parent_id = '0'
            AND e.phase_index IS NOT NULL
          ORDER BY e.created_at ASC`,
      )
      .all(row.id) as DeriveExecutionInput[]
    return deriveTaskView(
      { id: row.id, status: row.status, task_spec: row.task_spec },
      executions,
      this.acceptanceDAO.listByTask(row.id),
    )
  }

  /**
   * GET /api/tasks/:id/executions — the task's run history, newest first (票03/票05).
   * One row per run (a v4 round, or the composite coordinator), with the (phase, round)
   * coordinates the acceptance ledger reads and the workspace to deep-link into. This
   * replaced children[], which listed the envelope rows standing for the same runs.
   *
   * `current` is the row the board's badge shows: the newest ROOT. It is not inferred
   * from time here — the history is already ordered by the same key the latch and the
   * badge read, so index 0 is the answer.
   */
  listRunHistory(id: string, limit = 50): Array<TaskExecutionBadge & { current: boolean }> {
    const row = this.taskDAO.getById(id)
    if (!row) throw new TaskNotFoundError()
    const history = this.lifecycle.history(id, limit)
    const byParent = groupChildren(this.lifecycle.childRuns(id))
    const currentId = history.length > 0 ? history[0].id : null
    // `error_summary` is on the badge now (票05): the board's badge and the history list
    // are the same projection of the same row, and an error field that only the history
    // endpoint had is how the board ended up showing red with nothing to say about it.
    return history.map((e) => ({
      ...toExecutionBadge(e, byParent.get(e.id) ?? []),
      current: e.id === currentId,
    }))
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

  /** GET /api/tasks/:id/home-file?path= — 契约修复 (v4 batch spec 审阅面). Read a
   *  `.scratch/**.md` file relative to the task home (the per-phase spec.md the
   *  kanban opens). Task-exists check FIRST (→404 — also the guard against a
   *  garbage id materializing a stray home on the write side). Path whitelist /
   *  escape / suffix guards live in TaskHomeService (→403/404 via
   *  ArtifactAccessError, same classification as artifacts/content). */
  readHomeFile(
    taskId: string,
    requestedPath: string,
  ): { path: string; content: string } {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    return this.taskHomeService.readHomeFile(taskId, requestedPath)
  }

  /** GET /api/tasks/:id/home-file?path=<dir>&list=1 — ADR-0018 batch-file
   *  listing (spec family + feedback/report + issues under a `.scratch/` dir).
   *  Read side: same edit-window freedom as read (guard is the dir-mode home
   *  whitelist — `.scratch/**`, `.md` only, depth ≤2). */
  listHomeDir(taskId: string, requestedDir: string): Array<{ path: string; mtime: string; bytes: number }> {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    return this.taskHomeService.listHomeDir(taskId, requestedDir)
  }

  /** GET /api/tasks/:id/batch-tree — draft-artifact visibility (#53): disk-direct
   *  scan of `.scratch/` batch dirs, decoupled from phases[] ("落盘即现").
   *  Read-only, no edit-window gate (mirrors listHomeDir). Unknown task → 404
   *  BEFORE any fs action (no stray homes); missing `.scratch/` → `[]` — an
   *  empty tree is the normal drafting state, deliberately NOT a 404. */
  batchTree(taskId: string): BatchTreeEntry[] {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    return this.taskHomeService.batchTree(taskId)
  }

  /** PUT /api/tasks/:id/home-file — 契约修复 (v4 batch spec 编辑/骨架). Editable
   *  window = the SAME predicate as spec editing (isSpecEditable: v3 draft/ready,
   *  v4 until done/aborted/archiving — K16; editing a running round's spec lands
   *  in the NEXT round's seed, the frozen envelope is untouched). After a successful
   *  write: ① a transient @@spec_updated notice so the authoring agent re-reads
   *  instead of overwriting the user's hand-edit next turn (SW-BP4 idiom);
   *  ② task_artifacts_update SSE (D19 reuse — the OutputViewer refreshes;
   *  `.scratch` files are not indexed, the event is a benign nudge). No version
   *  bump: the file is not the task row (write-vs-write is last-writer-wins,
   *  reconciled by the agent's re-read discipline). */
  writeHomeFile(
    taskId: string,
    requestedPath: string,
    content: string,
  ): { path: string; bytes: number } {
    const row = this.taskDAO.getById(taskId)
    if (!row) throw new TaskNotFoundError()
    if (!this.isSpecEditable(row)) {
      throw new TaskStatusConflictError(
        `Cannot edit batch files of a task in status '${row.status}'`,
      )
    }
    const result = this.taskHomeService.writeHomeFile(taskId, requestedPath, content)
    setSpecNotice(taskId, `@@spec_updated: spec.md ${requestedPath} — 用户经看板 UI 修改了该文件，写前请重新读取`)
    this.sse.emit("taskpool", {
      event: TASK_ARTIFACTS_UPDATE_EVENT,
      data: { task_id: taskId },
    })
    return result
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
    return { items: this.attachInstances(rows) }
  }

  /** Attach each task's current instance with ONE batched query (a task has at most one
   *  LIVE root by the latch, but the newest root may well be a finished round — which is
   *  what the card shows: 「上一轮 completed」, not an empty badge). Pre-票03 this joined
   *  the root schedule row instead; the row it read was a stand-in for exactly this. */
  private attachInstances(rows: TaskRow[]): TaskDTO[] {
    const dtos = rows.map(toDTO)
    if (dtos.length === 0) return dtos
    const byId = new Map(
      this.lifecycle.latestInstances(rows.map((r) => r.id)).map((e) => [e.task_id as string, e]),
    )
    return dtos.map((d) => {
      const inst = byId.get(d.id)
      return inst ? { ...d, execution: toExecutionBadge(inst) } : d
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
            ? JSON.parse(row.task_spec) as { skill_groups?: string[]; format?: string }
            : null
          const groups = ctxSpec?.skill_groups ?? []
          const projectIds: string[] = row.project_ids
            ? JSON.parse(row.project_ids) as string[]
            : []
          // repo-sync (2026-09-08, 特性A): 首次 PUT 锁定 project_ids 也触发镜像
          // 同步（TemplatePicker 之外的选择路径），仅 v4。
          if (ctxSpec?.format === "v4" && changedFields.includes("project_ids") && projectIds.length > 0) {
            this.repoSyncService?.syncProjectsForTask(id, row.org, projectIds)
          }
          const projectRefs = this.resolveProjectRefs(row.org, projectIds)
          this.taskHomeService.writeContextFile(id, row.org, projectRefs, groups,
            this.repoSyncService?.freshnessNotes(id, projectIds))
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
    // 06: task_spec may have changed — keep the structured manifest.json
    // snapshot current.
    this.writeManifestSnapshot(id)
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
    // 契约修复: set when the phases write below stamps the v4 flag (an agent may
    // write phases onto an autosave-created shell that carries neither format nor
    // task_type — without the stamp such a row falls through BOTH gate branches
    // in readyTask into the legacy no-gate path).
    let v4FormatStamped = false

    switch (input.field) {
      case "goal":
      case "ac":
      case "subunits":
      case "integration_goal":
      case "decisions":
      case "goal_confirmed":
      case "ac_confirmed":
        // Merge into task_spec JSON (all v3 confirmation/decision fields +
        // the original goal/ac/subunits/integration_goal live in task_spec).
        fields.task_spec = JSON.stringify({ ...currentSpec, [input.field]: validatedValue })
        break
      case "phases": {
        // ticket 07: `phases` too — WHOLE-ARRAY PUT (the value validated by
        // shared's taskPhaseSchema replaces the list; per-phase patching is
        // deliberately not defined, K1). The flag is only stamped upward (v3→v4),
        // never removed — v4 创建锁 on the PUT path is the downgrade gate.
        const merged: Record<string, unknown> = { ...currentSpec, phases: validatedValue }
        if (currentSpec.format !== "v4") {
          merged.format = "v4"
          v4FormatStamped = true
        }
        fields.task_spec = JSON.stringify(merged)
        break
      }
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

    // 契约修复: if the v4 flag was stamped by this phases write, the row may still
    // be a homeless autosave shell — the v4 gate/seed resolve relative specPaths
    // against the home, so backfill it best-effort (non-fatal, mirrors createTask's
    // materialize-failure handling). The writeManifestSnapshot at the end of
    // this function re-stamps the empty manifest.json baseline createHome just
    // wrote.
    if (v4FormatStamped) {
      try {
        if (!fs.existsSync(this.taskHomeService.homePath(id))) {
          const backfillProjects = parseJSON<string[]>(updated.project_ids, [])
          const backfillRefs = this.resolveProjectRefs(updated.org, backfillProjects)
          this.taskHomeService.createHome(id, {
            org: updated.org,
            projects: backfillRefs,
            skillGroups: [],
          })
          // repo-sync: 无家壳补建时项目已存在 → 同步一并补触发（与 createTask 同语义）。
          if (backfillProjects.length > 0) {
            this.repoSyncService?.syncProjectsForTask(id, updated.org, backfillProjects)
          }
        }
      } catch (err: unknown) {
        console.error(
          `[TasksService] updateSpecField: v4 home backfill failed for ${id} (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // Context-affecting field changed → refresh context.md (always, regardless
    // of source — the file is the source of truth for the agent's on-demand
    // read). For user-source, also append @@context_updated to the notice.
    if (input.field === "projects" || input.field === "skills") {
      try {
        const row = this.taskDAO.getById(id)
        if (row) {
          const ctxSpec = row.task_spec
            ? JSON.parse(row.task_spec) as { skill_groups?: string[]; format?: string }
            : null
          const groups = ctxSpec?.skill_groups ?? []
          const projectIds: string[] = row.project_ids
            ? JSON.parse(row.project_ids) as string[]
            : []
          // repo-sync (2026-09-08, 特性A): agent/用户经 spec-field 写 projects →
          // v4 触发镜像同步；本轮写 context.md 时顺带注入已有新鲜度快照。
          if (input.field === "projects" && ctxSpec?.format === "v4" && projectIds.length > 0) {
            this.repoSyncService?.syncProjectsForTask(id, row.org, projectIds)
          }
          const projectRefs = this.resolveProjectRefs(row.org, projectIds)
          this.taskHomeService.writeContextFile(id, row.org, projectRefs, groups,
            this.repoSyncService?.freshnessNotes(id, projectIds))
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
    // structured task_spec snapshot (manifest.json) the task-author agent reads.
    this.writeManifestSnapshot(id)

    return { version: updated.version }
  }

  /** 06 — refresh `{home}/manifest.json` from the current tasks row. The
   *  task-author agent reads this structured snapshot (format / phases 绑定 /
   *  decisions / …) instead of curling the API. v4 specs get the v3-only
   *  schema-default keys filtered on the write side. Best-effort, non-fatal:
   *  legacy/v2 tasks have no home dir (writeManifestFile is a silent no-op).
   *  Called on every spec write (create / PUT / spec-field) so the file always
   *  reflects the current task_spec. */
  private writeManifestSnapshot(id: string): void {
    try {
      const row = this.taskDAO.getById(id)
      if (!row) return
      const spec = parseJSON<Record<string, unknown>>(row.task_spec, {})
      this.taskHomeService.writeManifestFile(id, {
        version: row.version,
        spec,
        updated_at: row.updated_at,
        format: typeof spec.format === "string" ? spec.format : undefined,
      })
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.error(
        `[TasksService] writeManifestFile for ${id} failed (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ── Dispatch seam (ready → schedules envelope) ───────────────────

  /** task-phase-redesign (ticket 04, K13): the v4 ready-gate over the phase
   *  contract. For each phase (1-based index `i`, array order):
   *    ① specPath file EXISTS — relative paths resolve under the task home
   *       (ADR-0011 home register + ADR-0018: home holds the draft baseline /
   *       last collected final state), absolute paths verbatim
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
    return resolveV4Phases({
      taskSpec,
      homeDir: this.taskHomeService.homePath(taskId),
      taskArtifactsDir: this.taskHomeService.artifactsDir(taskId),
      resolveRef: (ref) => resolveWorkflowRef(ref, this.resolverDeps(taskId)),
    })
  }

  /**
   * POST /api/tasks/:id/ready — draft→ready, gated on the contract.
   *
   * 票03: this is a CHECK + a status write, nothing else. It used to also materialize a
   * WorkflowConfig and insert a parked `schedules` row (the envelope) whose config then
   * had to serve as the runtime definition for every later round — which is why editing
   * a spec after enqueue did nothing, why 周期触发 was impossible, and why "重新入队"
   * existed at all. The launch plan is materialized per launch by the task-lifecycle job
   * instead, so the only durable effect of enqueueing is the status.
   *
   * The gate itself is unchanged: v4 checks the phase contract (spec file, resolvable
   * ref, satisfied required inputs) plus the project-repo preflight; v3 checks
   * goal/ac/confirmations and the bound workflow_ref. A miss is a 409 with the missing
   * keys, never a half-enqueued task.
   */
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
      // B1 项目仓库预检（入列前确定, 2026-09-08）：每个选中项目必须能经
      // repos/index.md 解析到本地 clone —— 这是 trigger 预建 worktree 的
      // 前置条件；解析不动的项目在入队时就以 `project:<name>` 挡住（清单
      // 第 5 行 ✗），而不是等触发执行/runner claim 才炸。project_ids 为空
      // → vacuous 通过（composite 子单元各自带项目在 dispatch 校验）。
      const gateProjects = parseJSON<string[]>(existing.project_ids, [])
      if (gateProjects.length > 0) {
        const git = new WorkspaceGit()
        for (const name of gateProjects) {
          try {
            git.resolveRepoPath(existing.org ?? "", name)
          } catch {
            missing.push(`project:${name}`)
          }
        }
      }
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

    // Nothing is created here. Enqueue asserts the contract and moves the status;
    // WHEN it runs (if at all) is the task's own trigger_* columns, and the run itself
    // is armed by the built-in job from those.
    // Flip the task to 'ready'. Nothing else happens: an explicit trigger (or the job,
    // for a task carrying a due cursor) is what creates a run from here on.
    const result = this.taskDAO.updateWithVersion(id, { status: "ready" }, existing.version)
    if (result.changes === 0) throw new TaskVersionConflictError()

    const row = this.taskDAO.getById(id)!
    return toDTO(row)
  }

  // ── Reopen (ready → draft) ───────────────────────────────────────────────

  /** POST /api/tasks/:id/reopen — the enqueue undo. A ready task whose run has NOT
   *  started goes back to 'draft' and becomes editable again (K16 freeze lifted).
   *  票03: 「还没开始」 used to be read off the envelope's status ('draft'/'queued' and
   *  not 'claimed'); now it is one fact — the task has no instance row that is armed or
   *  running. Once a round exists, reopen is refused and abort is the way back, exactly
   *  as before; the difference is there is no row to reap on the way out (nothing was
   *  created), so reopen cannot leak an orphan definition — the failure mode that
   *  needed the orphan reaper in the first place.
   *
   *  Status write is a system event (direct UPDATE, no version bump) so the authoring
   *  agent's optimistic concurrency is unaffected. Synchronous = atomic w.r.t. the job's
   *  claim loop on this event loop. */
  reopenTask(id: string): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "ready") {
      throw new TaskStatusConflictError(
        `Cannot reopen a task in status '${existing.status}' (only ready→draft)`,
      )
    }

    const inst = this.lifecycle.currentInstance(id)
    if (inst && !TERMINAL_INSTANCES.has(inst.status)) {
      throw new TaskStatusConflictError(
        "任务已进入排队领取/执行，无法退回草稿 — 请改用中止",
      )
    }
    // A finished round leaves its row behind as history: reopen only unlocks the spec.

    const nowIso = new Date().toISOString()
    const flipped = this.taskDAO
      .getDb()
      .prepare("UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND status = 'ready' AND deleted_at IS NULL")
      .run("draft", nowIso, id)
    if (flipped.changes === 0) {
      throw new TaskStatusConflictError("任务状态已变化，请刷新后重试")
    }

    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: id, status: "draft" },
    })

    const row = this.taskDAO.getById(id)!
    return toDTO(row)
  }

  // ── Trigger / cancel (票03: write the task's own WHEN, then let the job run it) ──

  /**
   * POST /api/tasks/:id/trigger — run this task now (`at` absent/past) or arm it for
   * `at` (one-shot). `at` in the future arms `tasks.trigger_at` and starts nothing: the
   * built-in job picks it up on its next round, sub-second after a wake.
   *
   * SAME-TASK MUTEX: now a DB constraint instead of a convention. `armTask` inserts the
   * instance row, and `ux_exec_task_active` refuses a second live one, so a double click,
   * a retry, or the job and a human racing all get the same 「已有实例」 answer. The
   * pre-票03 version of that guarantee was this method flipping a parked row and eight
   * call sites guarding it.
   *
   * 预建 (trigger-prebuild 2026-09-08) is preserved and moved: the workspace is prepared
   * synchronously here, so a task that CANNOT get a worktree 409s to the user who pressed
   * the button instead of failing a minute later inside a cron tick. */
  async triggerTask(id: string, at?: string): Promise<TaskDTO> {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "ready") {
      throw new TaskStatusConflictError(
        `只有已入队(ready)的任务可以触发 (当前状态: '${existing.status}')`,
      )
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const dueAt = at ? new Date(at) : now
    const immediate = Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= now.getTime()

    if (immediate) {
      try {
        await this.armNow(id)
      } catch (err: unknown) {
        throw this.asConflict(err)
      }
    } else {
      // Timed: disarm any stale cursor and arm the task's own one-shot due time. The
      // status stays 'ready' — a scheduled task has not started, and the badge reads the
      // due cursor, not a mirrored status.
      this.taskDAO.armOnce(id, dueAt.toISOString())
      this.sse.emit("taskpool", {
        event: TASK_TRIGGER_EVENT,
        data: { task_id: id, action: "scheduled", next_fire_at: dueAt.toISOString() },
      })
    }

    const row = this.taskDAO.getById(id)!
    return this.attachInstances([row])[0] ?? toDTO(row)
  }

  /** The production entry point kept as a distinct name for the route (the
   *  预建 behavior is now unconditional inside triggerTask). */
  async triggerTaskWithPrebuild(id: string, at?: string): Promise<TaskDTO> {
    return this.triggerTask(id, at)
  }

  /** POST /api/tasks/:id/trigger/cancel — withdraw an armed one-shot that has not
   *  started. 票03: two things to take back, in this order — the queued instance if the
   *  job already armed one (retired only while still 'pending'; if the engine started,
   *  the caller must abort), then the due cursor itself. */
  cancelTaskTrigger(id: string): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "running" && existing.status !== "ready") {
      throw new TaskStatusConflictError(
        `Cannot cancel trigger for a task in status '${existing.status}'`,
      )
    }
    const hasPendingFire = existing.trigger_mode === "once" && !!existing.next_fire_at

    const inst = this.lifecycle.currentInstance(id)
    const armedButNotStarted = !!inst && inst.status === "pending"
    if (inst && !armedButNotStarted && !TERMINAL_INSTANCES.has(inst.status)) {
      throw new TaskStatusConflictError("定时触发已开始执行，无法取消 — 请改用中止")
    }
    if (armedButNotStarted) {
      this.lifecycle.abortTask(id)
    } else if (!hasPendingFire && !armedButNotStarted) {
      throw new TaskStatusConflictError("没有可取消的定时触发")
    }

    this.taskDAO.disarmTrigger(id)
    // Back to a plain enqueued task with no run in flight.
    this.taskDAO
      .getDb()
      .prepare("UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL WHERE id = ? AND deleted_at IS NULL")
      .run("ready", new Date().toISOString(), id)

    this.sse.emit("taskpool", {
      event: TASK_TRIGGER_EVENT,
      data: { task_id: id, action: "cancelled", next_fire_at: null },
    })

    const row = this.taskDAO.getById(id)!
    return this.attachInstances([row])[0] ?? toDTO(row)
  }

  /**
   * Set / clear this task's RECURRING trigger. Body of POST /:id/trigger/schedule.
   *
   * This is the capability the envelope made impossible: a cron expression used to have
   * to live on a private `schedules` row (with a cron_expression there, the pump would
   * have treated the task as one of its own jobs and the whole 入队/触发 state machine
   * would fight it), so 周期触发 was not merely unimplemented — it had nowhere to be
   * stored. Now it is three columns on the task and one cursor.
   *
   * Validation is deliberately minimal and non-destructive: an unparseable expression is
   * refused BEFORE anything is written (no half-armed schedule), and the cursor is
   * computed here so the job's scan never has to parse cron at all — it reads one column
   * and compares it to the clock.
   */
  setCronTrigger(id: string, cron: string | null, timezone?: string): void {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (cron === null || cron.trim() === "") {
      this.taskDAO.disarmTrigger(id)
      this.sse.emit("taskpool", {
        event: TASK_TRIGGER_EVENT,
        data: { task_id: id, action: "unscheduled", next_fire_at: null },
      })
      return
    }
    const next = TaskLifecycleService.nextCronFireAt(cron, timezone || "Asia/Shanghai")
    if (!next) throw new TaskStatusConflictError(`cron 表达式无法解析: ${cron}`)
    this.taskDAO.armCron(id, cron, timezone || "Asia/Shanghai", next)
    this.sse.emit("taskpool", {
      event: TASK_TRIGGER_EVENT,
      data: { task_id: id, action: "scheduled", next_fire_at: next },
    })
  }

  /** Pause / resume a task's own triggers (the master switch on the card, and the
   *  built-in job's row is a separate switch for the whole system). */
  setTriggerEnabled(id: string, enabled: boolean): void {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    this.taskDAO.setTriggerEnabled(id, enabled)
    this.sse.emit("taskpool", {
      event: TASK_TRIGGER_EVENT,
      data: { task_id: id, action: enabled ? "resumed" : "paused", next_fire_at: existing.next_fire_at },
    })
  }

  /** A single task's list-row shape (trigger columns + current instance) — what the
   *  trigger/schedule endpoints return so the caller re-reads one number instead of the
   *  whole detail payload. */
  getTaskSummary(id: string): TaskDTO {
    const row = this.taskDAO.getById(id)
    if (!row) throw new TaskNotFoundError()
    return this.attachInstances([row])[0]
  }

  /** Arm + launch through the job, then wake it so the claim does not wait for the cron
   *  minute. A trigger that cannot arm (契约已破 / ws 建不出来) surfaces as the 409 the
   *  user needs, not as a task stuck in 排队中. */
  private async armNow(id: string): Promise<void> {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    // Mirror-safety: an in-flight repo sync must finish before a worktree is cut from
    // main (same discipline as the pre-票03 预建 path, 45s wait then proceed).
    if (isV4TaskSpec(existing.task_spec)) {
      await this.repoSyncService?.waitUntilIdle(id, 45_000)
    }
    this.lifecycle.armAndLaunch(id, { triggeredBy: "manual" })
  }

  /** TaskLifecycleError → the conflict the route already knows how to render. The
   *  reason codes stay distinguishable in the message; the HTTP status is 409 for all
   *  of them because every one of them means 「现在不行」 rather than 「你请求错了」. */
  private asConflict(err: unknown): Error {
    if (err instanceof TaskLifecycleError) return new TaskStatusConflictError(err.message)
    if (err instanceof TaskNotFoundError) return err
    return new TaskStatusConflictError(err instanceof Error ? err.message : String(err))
  }

  // ── Dispatch a phase round (票03: delegate to the built-in job) ─────

  /**
   * Start ONE round of a v4 task: phase `phaseIdx`, round `roundIdx`.
   *
   * Ticket 05 built this as the exception to the rule that only the pump starts work —
   * it rewrote the envelope's chain[0], grabbed an active `schedule_executions` slot,
   * created an execution on the bound ws, tagged it (phase, round) and registered a
   * terminal callback that released the slot. All five of those jobs now belong to the
   * task-lifecycle job, which is also what starts the FIRST round, so this is a one-line
   * delegation and 首触/后续轮 are finally the same code path (they used to differ in
   * exactly the ways that caused bugs: crash re-claim, collect, retention exemption).
   *
   * Kept as a named method because the acceptance/advance paths and 票04's composite
   * resume all call it, and its error contract is theirs: TaskLifecycleError → 409.
   */
  async dispatchPhaseRound(
    taskId: string,
    phaseIdx: number,
    roundIdx: number,
    feedback?: string,
    opts?: {
      workflowRefOverride?: string
      inputOverride?: Record<string, string>
      prevHandoffPaths?: string[]
    },
  ): Promise<{ executionId: string; workspaceId: string }> {
    const arm: ArmOptions = {
      phaseIndex: phaseIdx,
      roundIndex: roundIdx,
      feedback,
      workflowRefOverride: opts?.workflowRefOverride,
      inputOverride: opts?.inputOverride,
      prevHandoffPaths: opts?.prevHandoffPaths,
      triggeredBy: "task-dispatch",
    }
    try {
      const executionId = this.lifecycle.armAndLaunch(taskId, arm)
      // currentInstance is the row we just armed (the latch guarantees it is the newest
      // root), so this is a read-back for the caller's deep link, not a lookup by time.
      const inst = this.lifecycle.currentInstance(taskId)
      return { executionId, workspaceId: inst?.workspace_id ?? "" }
    } catch (err: unknown) {
      throw this.asConflict(err)
    }
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
   *  Persisted-status normalization (票03 rewrite): the task-lifecycle job leaves a v4
   *  card at 'running' when a round ends (K3 — 待验收 is derived, not stored), so after
   *  acceptance we realign the row with what the human just authorized: 'running' when a
   *  round started, 'ready' when the task parks at the manual gate. Without this a v4
   *  task could not be aborted after acceptance (abortTask only accepts ready/running).
   *  K3 is NOT violated: these are the states the derivation itself reports for the
   *  post-decision world, written at a *human decision* point — never a mirror of a
   *  machine transition. (Pre-票03 the same realignment existed because the SG2 listener
   *  had mirrored 'done' off the envelope's first terminal transition; that writer is
   *  gone, and so is the leftover it created.)
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
    // An accepted decision on a task that can no longer run anything would be a ledger row
    // nobody can execute. The phase matrix cannot catch it: deriveTaskView reads the ROUND
    // rows, so an aborted/archiving card whose last round is unreviewed still derives
    // 'awaiting_review'. Checked here, before the append — the append itself stays
    // unconditional (K6: 决策是历史事实,派发失败不回滚账本,重试永远人工发起); this only
    // rules out the states where a retry is impossible by construction.
    if (row.status !== "ready" && row.status !== "running") {
      throw new TaskStatusConflictError(
        `任务当前状态 '${row.status}' 无法继续推进 phase —— 已中止/已归档的任务请重新入队`,
      )
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
      // ADR-0018 二分路由：缺省 rerun（现行为，绑定流自己再审 spec）；
      // fix = override task-fix + 合成输入（feedback_path 指向上面刚产物化的
      // fix-feedback-r{N}.md，home 绝对位 —— task-fix 直读直写 home）。
      const flow = input.next_flow ?? "rerun"
      // Synthesized fix inputs point at the WS-isomorphic batch dir (seed just
      // copied home → {ws}/{rel}): the fix agent edits/reports IN the ws, and
      // collect flows the final state (incl. an in-place revised spec.md) back
      // to home — the server-maintained loop (ADR-0018), not direct home writes.
      const fixHomeDir = this.taskHomeService.homePath(taskId)
      const fixBatchRel =
        flow === "fix"
          ? (() => {
              const d = this.phaseSpecDir(taskId, pv.index) ?? ""
              const rel = d ? batchRelPath(fixHomeDir, d) : null
              return rel ? rel.split(path.sep).join("/") : d
            })()
          : ""
      const routing =
        flow === "fix"
          ? {
              workflowRefOverride: "built-in/task-fix",
              inputOverride: {
                phase_spec_dir: fixBatchRel,
                feedback_path: path.posix.join(fixBatchRel, `fix-feedback-r${input.round_index}.md`),
                task_artifacts_dir: this.taskHomeService.artifactsDir(taskId),
              },
            }
          : undefined
      const d = await this.dispatchPhaseRound(taskId, pv.index, nextRound, feedback, routing)
      dispatch = {
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
        // 阶段衔接信道 (ticket 01): 刚 accepted 的本 phase 也在前序集内
        // (deriveView 重读账本) — 下 phase 首轮开跑即带 handoff 路径。
        const prevHandoffPaths = this.collectPrevHandoffPaths(row, nextPhaseIndex)
        const d = await this.dispatchPhaseRound(taskId, nextPhaseIndex, 1, undefined, { prevHandoffPaths })
        dispatch = {
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
    // 阶段衔接信道 (ticket 01): 手动推进与 autoAdvance 同注入 (AC4)。
    const prevHandoffPaths = this.collectPrevHandoffPaths(row, target.index)
    const d = await this.dispatchPhaseRound(taskId, target.index, 1, undefined, { prevHandoffPaths })
    this.setPersistedTaskStatus(taskId, "running")
    this.emitPhaseStatus(taskId, target.index, "running", 1)
    return {
      task: this.getTask(taskId),
      next_action: "dispatched",
      dispatch: {
        execution_id: d.executionId,
        workspace_id: d.workspaceId,
        phase_index: target.index,
        round_index: 1,
      },
    }
  }

  /** 票 07: feedback 产物化 — `{home}/.scratch/<date>/<slug>/fix-feedback-r{N}.md`
   *  (K7/K10). The batch dir comes from the task's own phases[] via phaseSpecDir
   *  (票03: the envelope's materialized copy is gone, so there is one source), and if
   *  it is unresolvable the write is skipped with a warning — the `feedback` input
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

  /** phase-handoff-chaining (ticket 01): 阶段衔接信道的 server 半 — every
   *  accepted predecessor's batch-dir `handoff.md` as a home ABSOLUTE path
   *  (K3: 只注路径不注内容). The accepted verdict comes from the single truth
   *  (deriveTaskView via deriveView — re-derived fresh, so a caller that just
   *  appended the acceptance row sees THIS decision too, AC1: 刚 accepted 的
   *  phase i 也是 i+1 的前序). specDirs come from the task's own phases[] via
   *  phaseSpecDir — the same mount seed/collect use, and since the launch plan is
   *  re-derived from task_spec per round (票03), the two cannot disagree about where
   *  a phase's batch lives. Non-files
   *  (目录/断链) and duplicates (两 phase 同 specDir) are silently filtered
   *  alongside missing files (R2: 失败轮缺一角不烧派发).
   *  Result ascending by phase index; empty ⇒ caller omits the key. */
  private collectPrevHandoffPaths(row: TaskRow, targetPhaseIndex: number): string[] {
    const view = this.deriveView(row)
    const seen = new Set<string>()
    return view.phaseViews
      .filter((p) => p.index < targetPhaseIndex && p.status === "accepted")
      .sort((a, b) => a.index - b.index)
      .map((p) => this.phaseSpecDir(row.id, p.index))
      .filter((d): d is string => !!d)
      .map((d) => path.join(d, "handoff.md"))
      .filter((f) => {
        if (seen.has(f)) return false
        try {
          if (!fs.statSync(f).isFile()) return false
        } catch {
          return false
        }
        seen.add(f)
        return true
      })
  }

  /** The phase's absolute batch dir (home mirror of the ws `.scratch/<date>/<slug>/`,
   *  K10), derived from task_spec — which after 票03 is the ONLY place the binding lives
   *  (the envelope used to be consulted first because it held a materialized copy that
   *  seed/collect mounted; that copy is gone, so there is nothing to disagree with). */
  private phaseSpecDir(taskId: string, phaseIndex: number): string | null {
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
   *  spec edits — same discipline as the job's own status mirrors (票03).
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

  /**
   * POST /api/tasks/:id/abort — running→aborted.
   *
   * 票03: 「所有子作业」 used to mean walking findSchedulesByOrigin('task', id) and, per
   * child, flipping schedules.status + marking schedule_workspaces cleaned + failing
   * schedule_executions to release a borrowed UNIQUE index + cancelling execution links
   * captured BEFORE the flips (an ordering bug that let an engine keep running after its
   * row said otherwise — the 2026-09-08 regression this replaces). All of it was
   * bookkeeping for a stand-in object. Now a task's runs ARE executions rows, so abort is
   * one call: engine cancel for live rows, retirement for armed-but-not-started ones, and
   * the latch releases itself.
   *
   * The bound workspace deliberately survives — it is the 打回 scene (round evidence, the
   * worktree on one branch) and the task may be re-triggered. Nothing may delete a bound
   * ws while the task is not 'done' (enforceRetention exempts it, K12), and 'done' never
   * arrives via abort.
   */
  abortTask(id: string): TaskDTO {
    const existing = this.taskDAO.getById(id)
    if (!existing) throw new TaskNotFoundError()
    if (existing.status !== "running" && existing.status !== "ready") {
      throw new TaskStatusConflictError(
        `Cannot abort a task in status '${existing.status}' (only ready/running can be aborted)`,
      )
    }

    const { cancelled, retired } = this.lifecycle.abortTask(id)
    if (cancelled.length + retired.length === 0) {
      // Legitimate (it parks the card) but worth a line: this is the shape of a
      // double-click, or of aborting a task whose timed fire never armed.
      console.log(`[TasksService] abort ${id}: 无在飞实例,仅置为 aborted`)
    }

    const now = new Date().toISOString()
    this.taskDAO
      .getDb()
      .prepare(
        "UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run("aborted", now, now, id)

    this.sse.emit("taskpool", {
      event: TASK_STATUS_EVENT,
      data: { task_id: id, status: "aborted" },
    })

    // repo-sync 内存回收（2026-09-08）：任务中止后快照/watcher 不再有消费者。
    this.repoSyncService?.forget(id)

    const row = this.taskDAO.getById(id)!
    return this.attachInstances([row])[0] ?? toDTO(row)
  }

  /** DELETE /api/tasks/:id — soft-delete (discard draft/ready). 票03: there is nothing
   *  to cascade — a task's runs are executions rows (they stay as history like any other
   *  run) and no private definition row exists to reap, which is precisely why the orphan
   *  reaper could be deleted with this ticket. Only draft/ready tasks are discardable; a
   *  running task must be aborted first.
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
    // 票03: nothing to cascade — a task's runs are executions rows (they outlive it as
    // history, like any other run) and there is no private definition row to reap. That
    // absence is why the orphan reaper dies with this ticket.
    this.taskDAO.softDelete(id)
    return { ok: true }
  }
}
