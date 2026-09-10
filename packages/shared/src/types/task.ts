import { z } from "zod"
import {
  type ResourceRef,
  type TaskSpec,
  subunitSpecSchema,
  integrationGoalSchema,
  resourceRefSchema,
  taskPhaseSchema,
} from "./scheduler-job"

// ── TaskStatus (v2-D2/D14 — first-class task lifecycle) ─────────────
/** draft → ready → running → (done | failed | aborted).
 *  'claimed' is folded into 'running' (claim is a schedule-level detail, not
 *  a task state). Terminal: done | failed | aborted (G2: failed does NOT roll
 *  back; G4: aborted cleans workspace). Soft-deleted drafts/ready carry
 *  deleted_at rather than a status value.
 *
 *  task-phase-redesign v4 (K3, ticket 07): adds 'awaiting_review' (round 到达
 *  终态等人验收 — "失败不是红死状态而是待处理", US8) and 'archiving' (末 phase
 *  验收通过 → 归档编排中, 票 08 是 done 的唯一写者). This is a WIDENING only:
 *  no v3/generic task ever carries the new values (they are written exclusively
 *  by the v4 acceptance path), the DB CHECK (schema v40) has listed them since
 *  ticket 02, and ticket 03's deriveTaskView already produced them as its local
 *  DerivedTaskStatus — widening the shared enum is what makes them legal on the
 *  wire (task_status SSE payload + TaskDTO status typing). 'failed' stays legal
 *  for v3 rows (K13 旧链零破坏); a v4 task never persists 'failed' (K3). */
export const TaskStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "awaiting_review",
  "archiving",
  "done",
  "failed",
  "aborted",
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

// ── TaskSpecField (v2-D12 — the 8 agent-settable fields; v3 adds decisions) ─
/** Fields the `update_task_spec_field` tool / `spec_field_update` SSE carry.
 *  goal/ac/subunits/integration_goal live inside task_spec; skills/projects map
 *  to the tasks.skills / tasks.project_ids columns; resources/authoring_resources
 *  map to the tasks.resources / tasks.authoring_resources columns. The server
 *  routes each field to the right column/blob on write.
 *
 *  task-authoring v3 (ticket 01, SW-BP3): adds `"decisions"` — the adoption
 *  target for MoA suggestion output, persisted into task_spec.decisions. This
 *  closes the orphan-field gap (decisions had a schema home but no settable
 *  field route); ticket 05 wires the server-side binding + the `source` flag.
 *
 *  task-workflow-handoff (ADR-0013): adds `"workflow_ref"` — the HOW binding.
 *  Lives as a top-level tasks.workflow_ref column (same pattern as skills /
 *  projects); the server's updateSpecField routes it there. Included in the
 *  shared enum so the agent tool / SSE / ClientSpecField all agree on the
 *  field name, and the spec_field_update SSE reaches the SpecPanel.
 *
 *  task-phase-redesign v4 (ticket 07): adds `"phases"` — the phase plan
 *  (task_spec.phases[]). Whole-array PUT semantics (the 拆分确认卡 / SKILL 协议
 *  rewrite the entire list; a per-phase patch would need identity rules the
 *  spec explicitly leaves to the author, K1). Same optimistic-lock + SSE chain
 *  as every other field. */
export const TaskSpecFieldSchema = z.enum([
  "projects",
  "skills",
  "goal",
  "ac",
  "subunits",
  "integration_goal",
  "resources",
  "authoring_resources",
  "decisions",
  "workflow_ref",
  "phases",
])
export type TaskSpecField = z.infer<typeof TaskSpecFieldSchema>

// ── spec_field_update SSE payload (v2-D7) ────────────────────────────
/** SSE event name emitted on the "taskpool" channel. The server emits this
 *  when the task-author agent calls the `update_task_spec_field` tool; the
 *  web-app SpecPanel subscribes and applies the field locally + bumps its
 *  tracked version to avoid a subsequent [save] 409. */
export const SPEC_FIELD_UPDATE_EVENT = "spec_field_update" as const

// ── task-authoring-v3 SSE events (D19, SW-BP8) ───────────────────────
/** Emitted on the "taskpool" channel alongside spec_field_update (same
 *  mechanism, D19): signals the task's artifact index may have changed so
 *  the OutputViewer re-fetches GET /api/tasks/:id/artifacts. No polling. */
export const TASK_ARTIFACTS_UPDATE_EVENT = "task_artifacts_update" as const
/** Emitted on the "taskpool" channel when an assist-workflow run changes
 *  phase (start/complete/error). Payload: {task_id, run_id, phase}. */
export const ASSIST_RUN_UPDATE_EVENT = "assist_run_update" as const

export const specFieldUpdatePayloadSchema = z.object({
  task_id: z.string().min(1),
  field: TaskSpecFieldSchema,
  // value shape depends on field: string (goal/ac), string[] (skills/projects),
  // object (integration_goal), ResourceRef[] (resources/authoring_resources),
  // SubunitSpec[] (subunits). Schema must not over-constrain here — the server
  // validates per field against the matching TaskSpec/column schema before
  // merging.
  value: z.unknown(),
  version: z.number().int().nonnegative(),
})
export type SpecFieldUpdatePayload = z.infer<typeof specFieldUpdatePayloadSchema>

// ── Task trigger (ADR-0021 票05 — WHEN a task runs, on the task) ──────
/** How a task is armed. Replaces the v39 envelope, where this information lived on a
 *  private `schedules` row and the values were 'draft'/'queued'/… mirror states:
 *    manual — only a human (or the agent tool) pressing 触发 starts a round; the due
 *             cursor stays NULL, so the built-in job never picks it up.
 *    once   — fire one round at `trigger_at`, then the cursor burns to NULL.
 *    cron   — fire every occurrence of `cron_expression` in `cron_timezone`; after each
 *             finished round the task returns to 'ready' with the cursor advanced, which
 *             is what makes a periodic task structurally possible now (under the
 *             envelope a fired task went terminal and nothing re-armed it). */
export const TriggerModeSchema = z.enum(["manual", "once", "cron"])
export type TriggerMode = z.infer<typeof TriggerModeSchema>

/** One task instance, projected for the wire (the board's badge and the detail's run
 *  history share this shape — one function builds both, so they cannot drift).
 *
 *  A run IS an `executions` row (`task_id` set, `parent_id='0'` for a root); there is no
 *  schedule row behind it. `status` is the execution vocabulary: 'pending' = 排队中
 *  (armed, waiting behind the shared concurrency gate), 'running' = 执行中, a terminal
 *  status = the previous run. */
export interface TaskExecutionBadge {
  id: string
  status: string
  workflow_ref: string
  /** The run's display name (composite subunit label = the subunit's workflow name).
   *  This replaces `schedules.origin_role='subunit'` as the thing that told the UI
   *  "this row is one fan-out arm of the parent": which arm it is comes from the row. */
  name: string | null
  phase_index: number | null
  round_index: number | null
  workspace_id: string
  started_at: string | null
  completed_at: string | null
  created_at: string
  /** Why a red run is red, one line, for the badge + tooltip. Sourced from the row's
   *  var-pool `error` key, which every failure writer now fills (the reap reason, the
   *  start failure, the engine's failed node) — a terminal row with no reason says
   *  NULL, not a stale key. */
  error_summary: string | null
  /** Composite fan-out: this root's child runs (empty for a simple task; omitted where
   *  the read model did not load them — the board's badge carries no children, the
   *  detail/history does). */
  children?: TaskExecutionBadge[]
}

// ── task_execution SSE payload (ADR-0021 票03/票05) ──────────────────
/** Emitted on the "taskpool" channel on every task-instance transition the job performs
 *  (armed / launched / finalized / reaped). 票03 introduced the event with a literal
 *  name; 票05 puts the name + payload on the wire contract so the board can fold it in
 *  instead of waiting for the 10s poll — '排队中' and '执行中' are now different facts,
 *  and a badge that only updates on a poll shows the wrong one for up to 10s. */
export const TASK_EXECUTION_EVENT = "task_execution" as const

export const taskExecutionSsePayloadSchema = z.object({
  task_id: z.string().min(1),
  execution_id: z.string().min(1),
  /** ExecutionStatus vocabulary, not TaskStatus — this is about the RUN. */
  status: z.string().min(1),
  phase_index: z.number().int().nullable().optional(),
  round_index: z.number().int().nullable().optional(),
  /** Set when this run is one arm of a composite fan-out: the dispatching run, and which
   *  subunit it is. The child's identity is `parent_id` + `name` on the row — this is the
   *  same pair on the wire, so the timeline can place an arm without re-fetching. */
  parent_id: z.string().min(1).optional(),
  subunit: z.string().min(1).optional(),
  /** Present on the failure/reap paths only: the same one-liner the badge shows. */
  reason: z.string().optional(),
})
export type TaskExecutionSsePayload = z.infer<typeof taskExecutionSsePayloadSchema>

// ── task_status SSE payload ──────────────────────────────────────────
/** SSE event name emitted when a task's own status column moves (armed→ready,
 *  launch→running, a terminal run→done/failed/aborted, reopen→draft).
 *
 *  Under the envelope this event was the scheduler's status listener reflecting
 *  `schedules.status` onto the task; the payload carried `schedule_id` + an
 *  `origin_type='task'` discriminator to say which world the transition came from.
 *  There is one writer now (the task-lifecycle job / the task routes), so both fields
 *  retired — a task_status event is about a task, full stop. */
export const TASK_STATUS_EVENT = "task_status" as const

export const taskStatusSsePayloadSchema = z.object({
  task_id: z.string().min(1),
  status: TaskStatusSchema,
})
export type TaskStatusSsePayload = z.infer<typeof taskStatusSsePayloadSchema>


// ── project_sync SSE payload (repo-sync 2026-09-08) ──────────────────
/** Emitted on the "taskpool" channel as the task's selected repos are force
 *  synced to origin/<default> (draft 创建异步 pull). One event per project per
 *  status transition; the task modal turns it into a toast (syncing = loading,
 *  ok = success, failed = warning with the stale-code hint). */
export const PROJECT_SYNC_EVENT = "project_sync" as const

export const projectSyncSsePayloadSchema = z.object({
  task_id: z.string().min(1),
  project: z.string().min(1),
  status: z.enum(["syncing", "ok", "failed"]),
  branch: z.string().optional(),
  commit: z.string().optional(),
  error: z.string().optional(),
  at: z.string(),
})
export type ProjectSyncSsePayload = z.infer<typeof projectSyncSsePayloadSchema>

// ── task_trigger SSE payload (ADR-0021 — the task's own trigger changed) ──
/** Emitted on the "taskpool" channel when a task's trigger changes: 触发 now (immediate
 *  or at a future point), 定时 cancelled, cron set/toggled. The kanban subscribes to
 *  refresh the 「排队 · … 触发」 badge without waiting for the 10s poll.
 *
 *  v39 emitted this from the envelope flip (`scheduled_at` was the private schedule's
 *  due column); the cursor is `tasks.next_fire_at` now, so the field follows the column. */
export const TASK_TRIGGER_EVENT = "task_trigger" as const

export const taskTriggerSsePayloadSchema = z.object({
  task_id: z.string().min(1),
  /** The vocabulary is exactly what the server emits — no value here is aspirational:
   *  scheduled (定时/周期已排上, from triggerTask(at) and setCronTrigger) · unscheduled
   *  (cron 撤下) · cancelled (排队中的到期游标被撤回) · paused / resumed (总开关).
   *  An immediate 触发 sends nothing on this event: it arms a row, so the board learns
   *  about it from task_execution + task_status, which is the same pair every other
   *  instance change uses. */
  action: z.enum(["scheduled", "unscheduled", "cancelled", "paused", "resumed"]),
  /** ISO due time of the next fire; null = immediate trigger, cancel, or cron off. */
  next_fire_at: z.string().nullable(),
})
export type TaskTriggerSsePayload = z.infer<typeof taskTriggerSsePayloadSchema>

/** Emitted when a DUE trigger could not be armed at all (deleted phase spec, no workflow
 *  bound, workspace could not be built). The cursor still retires — otherwise a broken
 *  task retries against the concurrency gate every minute — so without this event the
 *  user's only evidence is a server log line and a card that quietly stays 已入队.
 *
 *  Not sent for an in-flight suppression: a skipped fire while the previous round runs is
 *  not a failure, and `task_execution` already narrates the live round. */
export const TASK_TRIGGER_FAILED_EVENT = "task_trigger_failed" as const

export const taskTriggerFailedPayloadSchema = z.object({
  task_id: z.string().min(1),
  /** The arm refusal's own message — the same one-liner discipline as error_summary. */
  reason: z.string().min(1),
  trigger_mode: TriggerModeSchema,
})
export type TaskTriggerFailedSsePayload = z.infer<typeof taskTriggerFailedPayloadSchema>

// ── phase_status_update SSE payload (task-phase-redesign v4, ticket 07) ──
/** Per-phase display status vocabulary on the wire. Structurally identical to
 *  ticket 03's server-local `DerivedPhaseStatus` (derive-task-view.ts) — the
 *  derive function stays dependency-free, so the CONTRACT lives here and the
 *  server's emit site is typed against this schema. */
export const TaskPhaseStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_review",
  "accepted",
])
export type TaskPhaseStatus = z.infer<typeof TaskPhaseStatusSchema>

/** Emitted on the "taskpool" channel when an acceptance decision changes a
 *  phase's derived status (票 07 emits it at the transitions ITS endpoint causes:
 *  accepted → phase 'accepted'; auto_advance dispatch → next phase 'running';
 *  rejected retry → same phase, new round 'running'). A round reaching its
 *  terminal state (→ 'awaiting_review') is NOT emitted here — that transition
 *  belongs to the executor/finalize path (票 06), which folds the board via
 *  `schedule_status` / `task_artifacts_update` instead.
 *
 *  Consumers (票 11 timeline / 票 12 acceptance dialog) treat this as a
 *  "re-derive and re-render" nudge — the authoritative state stays GET /:id's
 *  `derived` view (K3 派生不存, spec R2). */
export const PHASE_STATUS_UPDATE_EVENT = "phase_status_update" as const

export const phaseStatusUpdatePayloadSchema = z.object({
  task_id: z.string().min(1),
  /** 1-based, mirrors TaskPhase.index. */
  phase_index: z.number().int().min(1),
  status: TaskPhaseStatusSchema,
  /** The round the status refers to (≥1; for status='pending' the round that
   *  is about to start). */
  round_index: z.number().int().min(1),
})
export type PhaseStatusUpdatePayload = z.infer<typeof phaseStatusUpdatePayloadSchema>

// ── update_task_spec_field tool (v2-D7) ──────────────────────────────
/** Agent tool name + input schema. The server's tool handler validates input,
 *  merges the field into tasks.task_spec / resources / authoring_resources /
 *  skills / project_ids, bumps version, and emits `spec_field_update` SSE.
 *  Conflict on stale version → 409 → agent re-GET + retry (v2-D12). */
export const UPDATE_TASK_SPEC_FIELD_TOOL_NAME = "update_task_spec_field" as const

export const updateTaskSpecFieldToolSchema = z.object({
  task_id: z.string().min(1),
  field: TaskSpecFieldSchema,
  // See specFieldUpdatePayloadSchema.value — shape varies by field.
  value: z.unknown(),
})
export type UpdateTaskSpecFieldTool = z.infer<typeof updateTaskSpecFieldToolSchema>

// ── spec-field value validation (v3 — shared canonical seam, SW-BP3) ──
/** Error thrown by {@link validateSpecFieldValue} on invalid input. The server
 *  route maps it to HTTP 400 (not 500). Mirrored from the server's local
 *  validator so shared is the single source of truth for per-field validation;
 *  ticket 05 wires the server to this canonical copy. */
export class TaskSpecFieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TaskSpecFieldError"
  }
}

/** Validate a spec-field value against the per-field schema (v2-D12 + v3
 *  `decisions`, SW-BP3). Throws {@link TaskSpecFieldError} on invalid input so
 *  the caller (server route) returns 400. Returns the coerced/validated value.
 *
 *  Why this lives in shared: the spec-field contract is shared (the agent tool,
 *  the SSE payload, and the route all agree on field names + value shapes), so
 *  per-field validation belongs with that contract. The `decisions` branch is
 *  the new adoption path for MoA expert suggestions (D10) — string[] memos
 *  persisted into task_spec.decisions. goal_confirmed/ac_confirmed binding is
 *  ticket 05's lane (server-side source flag + ready gate); this validator
 *  covers the fields whose value shape shared prescribes. */
export function validateSpecFieldValue(field: TaskSpecField, value: unknown): unknown {
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
    case "decisions":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim())) {
        throw new TaskSpecFieldError("field 'decisions' must be an array of non-empty strings")
      }
      return value
    case "phases":
      // task-phase-redesign v4 (ticket 07): the phase plan (task_spec.phases[]).
      // WHOLE-ARRAY PUT semantics — the 拆分确认卡 / task-author SKILL rewrite
      // the entire list (a per-phase patch would need identity rules the spec
      // leaves to the author, K1). Each entry validated against the canonical
      // taskPhaseSchema (index/name/slug path-safety/specPath/workflowRef/
      // inputValues); ≥1 mirrors taskSpecSchema.phases.min(1) so an empty list
      // fails here (400) instead of surfacing later as `phase:0:no-phases`.
      if (!Array.isArray(value) || value.length < 1) {
        throw new TaskSpecFieldError("field 'phases' must be a non-empty array of TaskPhase")
      }
      return value.map((v) => taskPhaseSchema.parse(v))
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
    case "workflow_ref":
      // task-workflow-handoff (ADR-0013): a non-empty string ref. The value is
      // validated as a string here (the shared contract) — resolvable-ness
      // against the installed built-ins / task-home workflows/ is the server's
      // fail-fast concern (WorkflowRefResolver; the route returns 400 on miss).
      if (typeof value !== "string" || !value.trim()) {
        throw new TaskSpecFieldError("field 'workflow_ref' must be a non-empty string")
      }
      return value
    default:
      throw new TaskSpecFieldError(`unknown field: ${field as string}`)
  }
}

// ── task-authoring v3: artifact index + assist-workflow run types (ticket 01) ─
/** One row of a task's artifacts.json index (ADR-0011, D5). The index is the
 *  single source of truth for "what did this task produce". `external: true`
 *  ⇒ `path` is an ABSOLUTE path at the artifact's native location (registered,
 *  not relocated); `false` ⇒ `path` is relative to the task home's artifacts/
 *  dir. ticket 02's TaskHomeService parses/writes entries through this schema;
 *  ticket 06's content route whitelists against it. */
export const artifactIndexEntrySchema = z.object({
  path: z.string().min(1),
  by: z.string().min(1),
  title: z.string(),
  external: z.boolean(),
  updated_at: z.string().min(1),
})
export type ArtifactIndexEntry = z.infer<typeof artifactIndexEntrySchema>

/** One timestamped line of an assist-workflow run's process log (D19, US10). */
export const assistWorkflowLogSchema = z.object({
  t: z.string().min(1),
  icon: z.string(),
  text: z.string(),
})

/** Structured MoA aggregator output (D10, US11). Parsed from the aggregator
 *  node's JSON; when parsing fails the run carries `output_raw` +
 *  `output_parse_error` instead (SW-BP10). */
export const assistWorkflowOutputSchema = z.object({
  ac_candidates: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
})

/** The lifecycle + output shape of one assist-workflow run (D9/D16/D19).
 *  `status` is a permissive string here — the execution-lifecycle vocabulary is
 *  owned by the server/ticket-07 run service; shared only carries the contract
 *  shape (the GET /assist-workflows/:runId response, spec line 126). `logs`
 *  come from the execution's node log; `output*` are the aggregator-parse
 *  triplet with the SW-BP10 fallback. */
export const assistWorkflowRunSchema = z.object({
  run_id: z.string().min(1),
  execution_id: z.string().min(1),
  workspace_id: z.string().min(1),
  template: z.string().min(1),
  status: z.string(),
  logs: z.array(assistWorkflowLogSchema),
  output: assistWorkflowOutputSchema.optional(),
  output_raw: z.string().optional(),
  output_parse_error: z.boolean().optional(),
})
export type AssistWorkflowRun = z.infer<typeof assistWorkflowRunSchema>

// ── Task row (first-class tasks table; v2-D1, S2 polymorphic origin) ─
/** A first-class task row.
 *
 * ADR-0021: this row owns BOTH halves of a task — WHAT (task_spec) and WHEN
 * (trigger_mode / trigger_at / cron_* / next_fire_at). Before it, WHEN had nowhere to
 * live, so each task secretly pre-created a private `schedules` row (the "envelope")
 * and the board read its badge off that row's status; the coupling grew to three
 * written tables, two mirrored state machines and an orphan reaper. The envelope is
 * gone: the built-in `task-lifecycle` job scans `next_fire_at` here, and one run is one
 * `executions` row (`execution` below, `task_id` set directly — no join through the
 * scheduler's tables).
 *
 * `task_spec` is the structured WHAT (D9). `resources` (workspace-scope →
 * workflow.requires at dispatch, v2-D13/SG7) and `authoring_resources`
 * (draft-scope, prompt-injected into the task-author session, v2-D8/D13) are
 * stored as their own JSON columns for query/provisioning convenience.
 * The autosave seam (clone/index.ts:406) writes only name+updated_at and does
 * NOT touch task_spec / resources / version (SG8). */
export interface Task {
  id: string
  org: string
  name: string
  status: TaskStatus
  /** WHAT the task does (D2). Written via the spec-field tool (agent) or
   *  PUT /tasks/:id ([save draft]); never via autosave. */
  task_spec: TaskSpec
  /** draft-scope resources (v2-D8/D13). */
  authoring_resources: ResourceRef[]
  /** workspace-scope resources → workflow.requires at dispatch (v2-D13/SG7). */
  resources: ResourceRef[]
  skills: string[]
  project_ids: string[]
  workflow_ref?: string
  version: number
  /** sessions.scope_id retargets to tasks.id (SG3); this is the back-ref. */
  source_chat_session_id?: string | null
  /** Soft-delete marker (discard draft/ready = soft delete, not status). */
  deleted_at: string | null
  created_at: string
  updated_at: string
  /** Set when status reaches a terminal done/failed/aborted. */
  completed_at?: string | null
  // ── WHEN this task runs (票03 moved these off the envelope onto the task) ──
  /** Default 'manual' — nothing fires unless a human or the agent tool says so. */
  trigger_mode: TriggerMode
  /** One-shot due time (ISO); only meaningful with trigger_mode='once'. */
  trigger_at: string | null
  cron_expression: string | null
  cron_timezone: string
  /** Master switch on this task's triggers (independent of the built-in job's row,
   *  which is the system-wide switch). */
  trigger_enabled: boolean
  /** THE due cursor — what the built-in job scans (`next_fire_at <= now`). NULL = not
   *  armed; a cron task's value advances after each round, a once task's burns to NULL
   *  when it fires. There is exactly one number because there is exactly one cursor. */
  next_fire_at: string | null
  last_fired_at: string | null
  /** The task's current instance (newest root execution) — the board badge. Null for a
   *  task that never ran. Populated by the read model (GET /api/tasks, GET /:id). */
  execution?: TaskExecutionBadge | null
}
