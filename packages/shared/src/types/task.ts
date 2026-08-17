import { z } from "zod"
import {
  OriginTypeSchema,
  type OriginType,
  type ResourceRef,
  type TaskSpec,
  type ScheduleStatus,
} from "./scheduler-job"

// ── TaskStatus (v2-D2/D14 — first-class task lifecycle) ─────────────
/** draft → ready → running → (done | failed | aborted).
 *  'claimed' is folded into 'running' (claim is a schedule-level detail, not
 *  a task state). Terminal: done | failed | aborted (G2: failed does NOT roll
 *  back; G4: aborted cleans workspace). Soft-deleted drafts/ready carry
 *  deleted_at rather than a status value. */
export const TaskStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "done",
  "failed",
  "aborted",
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

// ── TaskSpecField (v2-D12 — the 8 agent-settable fields) ─────────────
/** Fields the `update_task_spec_field` tool / `spec_field_update` SSE carry.
 *  goal/ac/subunits/integration_goal live inside task_spec; skills/projects map
 *  to the tasks.skills / tasks.project_ids columns; resources/authoring_resources
 *  map to the tasks.resources / tasks.authoring_resources columns. The server
 *  routes each field to the right column/blob on write. */
export const TaskSpecFieldSchema = z.enum([
  "projects",
  "skills",
  "goal",
  "ac",
  "subunits",
  "integration_goal",
  "resources",
  "authoring_resources",
])
export type TaskSpecField = z.infer<typeof TaskSpecFieldSchema>

// ── spec_field_update SSE payload (v2-D7) ────────────────────────────
/** SSE event name emitted on the "taskpool" channel. The server emits this
 *  when the task-author agent calls the `update_task_spec_field` tool; the
 *  web-app SpecPanel subscribes and applies the field locally + bumps its
 *  tracked version to avoid a subsequent [save] 409. */
export const SPEC_FIELD_UPDATE_EVENT = "spec_field_update" as const

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

// ── task_status SSE payload (SG2 — ScheduleStatusListener emits) ─────
/** SSE event name emitted when a schedule transition is reflected onto the
 *  parent task's status, so the /tasks kanban updates in real time. */
export const TASK_STATUS_EVENT = "task_status" as const

export const taskStatusSsePayloadSchema = z.object({
  task_id: z.string().min(1),
  status: TaskStatusSchema,
  // Traceability back to the schedule that drove the transition. Optional —
  // not every transition originates from a schedule (e.g. draft→ready via the
  // /ready API, or running→aborted via /abort).
  schedule_id: z.string().min(1).optional(),
  origin_type: OriginTypeSchema.optional(),
})
export type TaskStatusSsePayload = z.infer<typeof taskStatusSsePayloadSchema>

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

// ── Task row (first-class tasks table; v2-D1, S2 polymorphic origin) ─
/** A first-class task row.
 *
 * S2 (polymorphic origin, no FK): there is NO schedule_id / execution_id /
 * claimed_at on this row. The link to schedules is via
 * `schedules.origin_type='task' AND origin_id=task.id`; integrity is maintained
 * at the app level (cascade-reap on task delete/abort + an orphan reaper, SG12)
 * — the tradeoff for S2's uniform polymorphic association.
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
}

// ── ScheduleStatusListener (SG2 — engine↔server boundary port) ───────
/** Listens to schedule lifecycle transitions and reflects them onto the parent
 *  task's status, then emits `task_status` SSE on the "taskpool" channel.
 *
 *  Mapping (spec SG2): queued/claimed → running, done → done, failed → failed,
 *  aborted → aborted. The impl is provided by the server and injected into
 *  SchedulerEngine — same port/adapter pattern as {@link TaskDispatchPort}
 *  (interface in shared, impl in server, injected via context). The listener
 *  only fires for schedules whose `origin_type='task'` (others are cron-driven
 *  and don't touch tasks.status). */
export interface ScheduleStatusListener {
  onScheduleTransition(args: {
    schedule_id: string
    origin_type: OriginType
    /** The parent task id (schedules.origin_id). */
    origin_id: string
    /** The schedule's new status — the impl maps this to TaskStatus. */
    status: ScheduleStatus
    error_summary?: string | null
  }): Promise<void> | void
}
