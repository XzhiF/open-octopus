// packages/web-app/lib/tasks-api.ts
//
// Thin client for the first-class `/api/tasks` domain (v2-D1). Mirrors the
// scheduler-api factory pattern: pure fetch wrapper, no DB, no Hono. Every
// function maps 1:1 to a route in packages/server/src/routes/tasks.ts — the
// server is the single source of truth for response shapes (TaskDTO /
// TaskDetailDTO). Types come from @octopus/shared so the client stays in lock
// step with the Zod schemas (SG14: read `Task`, NOT `SchedulerJob`).
//
// The `TaskDetail.children` shape mirrors the server's TaskDetailDTO.children
// (S2 origin lookup — schedules WHERE origin_type='task' AND origin_id=task.id).
// There is no FK; integrity is maintained server-side (cascade-reap + orphan
// reaper, SG12).

import { getServerUrl } from "@/lib/server-config"
import type {
  Task,
  TaskStatus,
  TaskSpecField,
  TaskSpec,
  ResourceRef,
  ArtifactIndexEntry,
  AssistWorkflowRun,
} from "@octopus/shared"

// ============ TaskDetail (composite view) ============
// GET /api/tasks/:id returns a TaskDetail: Task + children schedules (S2 origin
// lookup). The canonical definitions live in @octopus/server (tasks-service.ts
// TaskDetailDTO); web-app cannot import from the server package — this mirror
// keeps the client type-safe without a cross-package dependency. Mirrors the
// JobDetail pattern in scheduler-api.ts.

export interface TaskChild {
  /** The child schedule's id (origin_type='task', origin_id=parent task). */
  schedule_id: string
  /** Schedule name (e.g. "task-{taskId}-coordinator" / "task-{taskId}-primary"
   *  / the subunit name for fan-out children). */
  name: string
  /** Schedule status (ScheduleStatus — queued/claimed/running/done/failed/aborted). */
  status: string
  /** Dispatch role: 'primary' (simple) | 'coordinator' (composite parent) |
   *  'subunit' (composite fan-out child). */
  origin_role: string | null
  /** workflow_ref extracted from the schedule's config.workflow_chain[0]. */
  workflow_ref: string | null
}

/** TaskDetail = Task + optional children. Simple/draft tasks return children=[]
 *  — backward compatible with the plain Task shape. */
export type TaskDetail = Task & {
  children?: TaskChild[]
}

// ============ Input types ============

export interface CreateTaskInput {
  org: string
  name?: string
  /** Links the new task to a chat session (sessions.scope_id retargets to
   *  tasks.id, SG3). The autosave seam (04) creates a task implicitly; this is
   *  the explicit POST path. */
  source_chat_session_id?: string | null
  // ── task-authoring v3 (ticket 09 — two-phase flow) ──
  /** D13: template selected on the template page (coding/generic). Present ⇒
   *  the server takes the v3 path (home created, skill_groups materialized,
   *  ready-gate applies). Absent ⇒ legacy v2 create. */
  task_type?: "coding" | "generic"
  /** D2/D3: skill groups chosen at creation then LOCKED (ADR-0012). Persisted
   *  into task_spec.skill_groups (D4 — NOT authoring_resources, which would
   *  double-inject via the augmenter). */
  skill_groups?: string[]
  /** D13 coding-template preset: org + projects only (skills belong to
   *  workflow.requires, not the preset). preset.org OVERRIDES the top-level
   *  org (the template page is the source of the authoring context). */
  preset?: { org?: string; projects?: string[] }
}

export interface UpdateTaskInput {
  name?: string
  /** The structured WHAT (D2). Written via the spec-field tool (agent) or
   *  PUT ([save draft]); never via autosave (SG8). */
  task_spec?: TaskSpec
  skills?: string[]
  project_ids?: string[]
  /** workspace-scope resources → workflow.requires at dispatch (v2-D13/SG7). */
  resources?: ResourceRef[]
  /** draft-scope resources prompt-injected into the task-author session (v2-D8). */
  authoring_resources?: ResourceRef[]
  workflow_ref?: string | null
}

export interface ListTasksParams {
  status?: TaskStatus
  org?: string
}

// ── v3: client-side spec-field + ready-gate types (ticket 09) ──────────

/** The set of field names the spec-field route accepts. Mirrors the server's
 *  `ServerSpecField` (tasks-service.ts:241): the shared `TaskSpecField` enum
 *  PLUS the v3 confirmation gates `goal_confirmed` / `ac_confirmed` (D18),
 *  which live in task_spec JSON but are bindable through the spec-field seam.
 *  The shared enum omits them because they aren't agent-tool fields; the
 *  client sends them by name for user confirmations (AC5). */
export type ClientSpecField = TaskSpecField | "goal_confirmed" | "ac_confirmed"

/** Thrown by {@link readyTask} when the v3 confirmation gate fails (D18/US6).
 *  Carries the `missing` list (e.g. ["goal_confirmed","ac_confirmed"]) so the
 *  UI shows exactly what to confirm before enqueue — the server-side gate is
 *  the backstop for UI temp state lost on modal close. */
export class TaskReadyGateError extends Error {
  public missing: string[]
  constructor(message: string, missing: string[]) {
    super(message)
    this.name = "TaskReadyGateError"
    this.missing = missing
  }
}

// ============ Helpers ============

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

const BASE = "/api/tasks"

function buildUrl(path: string, params?: Record<string, string | undefined>): string {
  const url = new URL(`${getServerUrl()}${BASE}${path}`)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value)
      }
    }
  }
  return url.toString()
}

// ============ Tasks CRUD ============

/** GET /api/tasks — list (kanban); ?status=&org=. Returns {items: Task[]}. */
export async function listTasks(params?: ListTasksParams): Promise<{ items: Task[] }> {
  const res = await fetch(buildUrl("", { status: params?.status, org: params?.org }))
  return handleResponse<{ items: Task[] }>(res)
}

/** GET /api/tasks/:id — detail (task + children schedules via S2 origin lookup). */
export async function getTask(id: string, signal?: AbortSignal): Promise<TaskDetail> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}`, { signal })
  return handleResponse<TaskDetail>(res)
}

/** POST /api/tasks — explicit draft creation. The autosave seam (04) may also
 *  create a draft implicitly; both paths converge on the server's createTask.
 *
 *  v3 (ticket 09, D15): the two-phase template page sends source_chat_session_id
 *  (created first) + task_type + skill_groups[] + preset{org,projects}. Legacy
 *  callers (no task_type) take the v2 path. */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const res = await fetch(`${getServerUrl()}${BASE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<Task>(res)
}

/** PUT /api/tasks/:id — [save draft] with If-Match optimistic locking. Only
 *  draft/ready tasks are editable (server throws 409 TaskStatusConflictError
 *  otherwise). Stale version → 409 TaskVersionConflictError → caller re-GET +
 *  retry (v2-D12). The server sets a transient @@spec_updated reverse-msg
 *  notice (05) so the task-author agent sees the user's override next turn. */
export async function updateTask(
  id: string,
  input: UpdateTaskInput,
  version: number,
): Promise<Task> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": String(version),
    },
    body: JSON.stringify(input),
  })
  return handleResponse<Task>(res)
}

/** DELETE /api/tasks/:id — soft-delete (discard draft/ready) + cascade-reap
 *  child schedules (R-INT). Running tasks must be aborted first (409). */
export async function deleteTask(id: string): Promise<{ ok: true }> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}`, { method: "DELETE" })
  return handleResponse<{ ok: true }>(res)
}

// ============ Actions ============

/** POST /api/tasks/:id/ready — draft→ready (confirm gate, v1 D13) + dispatch
 *  seam (creates the schedules envelope: simple=1 primary; composite=1
 *  coordinator). Runner claims the schedule; ScheduleStatusListener mirrors
 *  running. 409 if not draft.
 *
 *  v3 (ticket 09, D18/US6): a v3 task (task_type set) must additionally pass
 *  the confirmation gate (goal non-empty ∧ ac≥1 ∧ goal_confirmed ∧ all ac in
 *  ac_confirmed). On failure the server returns 409 with `{error, missing[]}`;
 *  this function throws a {@link TaskReadyGateError} carrying `.missing` so
 *  the UI can show exactly what to confirm before enqueue (server-side gate
 *  is the backstop for UI temp state lost on modal close). */
export async function readyTask(id: string): Promise<Task> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/ready`, { method: "POST" })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    // D18 gate miss: 409 + missing[] → typed error so the UI shows the gaps.
    if (res.status === 409 && Array.isArray(body.missing)) {
      throw new TaskReadyGateError(body.error ?? "Task not ready", body.missing as string[])
    }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

/** POST /api/tasks/:id/abort — running/ready→aborted + ws cleanup (v1 G4).
 *  Finds all child schedules via S2 origin lookup, aborts each in-flight
 *  (claimed/running) schedule, writes tasks.status='aborted', emits
 *  task_status SSE. 409 if not ready/running. */
export async function abortTask(id: string): Promise<Task> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/abort`, { method: "POST" })
  return handleResponse<Task>(res)
}

/** POST /api/tasks/:id/spec-field — agent `update_task_spec_field` tool
 *  endpoint, AND the v3 user-direct-edit path. Merges a single field into the
 *  right column, bumps version, emits `spec_field_update` SSE so the SpecPanel
 *  applies the field locally + bumps its tracked version (avoids a subsequent
 *  [save] 409, v2-D12).
 *
 *  v3 (ticket 09, D7/SW-BP4): `source` routes user-direct edits through the
 *  @@spec_updated reverse-notice path so the agent reconciles next turn;
 *  agent edits (default) do NOT set the notice (the agent would see its own
 *  edit echoed back as a user override). The field name may be a v3
 *  confirmation field (`goal_confirmed` / `ac_confirmed`) — the server's
 *  ServerSpecField extends the shared enum with those two (D18). */
export async function updateSpecField(
  id: string,
  field: ClientSpecField,
  value: unknown,
  opts?: { source?: "user" | "agent" },
): Promise<{ version: number }> {
  const body: Record<string, unknown> = { field, value }
  if (opts?.source) body.source = opts.source
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/spec-field`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return handleResponse<{ version: number }>(res)
}

// ============ Artifacts (ticket 06 routes — US7/D5) ============

/** GET /api/tasks/:id/artifacts — the artifact index (artifacts.json). Missing
 *  file → []; corrupted JSON → [] + server-side warn (SW-BP12); missing task →
 *  404. The index is the single source of truth for "what did this task produce"
 *  (ADR-0011). `external:true` entries carry an ABSOLUTE path at the artifact's
 *  native location; `false` entries are relative to the task home's artifacts/ dir. */
export async function listArtifacts(taskId: string): Promise<ArtifactIndexEntry[]> {
  const res = await fetch(buildUrl(`/${taskId}/artifacts`))
  return handleResponse<ArtifactIndexEntry[]>(res)
}

/** Error thrown by {@link getArtifactContent} on 403 (path outside the whitelist
 *  — escape/unregistered) or 404 (whitelisted but missing on disk). The caller
 *  surfaces a degraded state in the viewer rather than white-screening (AC2). */
export class ArtifactContentError extends Error {
  public readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "ArtifactContentError"
    this.status = status
  }
}

export interface ArtifactContent {
  path: string
  content: string
}

/** GET /api/tasks/:id/artifacts/content?path= — full artifact content (US7). The
 *  server whitelists `path` (relative-inside-artifacts no-escape OR a registered
 *  external=true absolute path) and reads live disk content. 400 (missing param),
 *  403 (forbidden — escape/unregistered), 404 (missing on disk) → throws
 *  {@link ArtifactContentError} carrying the status so the UI shows the right
 *  degraded hint (AC2). */
export async function getArtifactContent(taskId: string, artifactPath: string): Promise<ArtifactContent> {
  const res = await fetch(buildUrl(`/${taskId}/artifacts/content`, { path: artifactPath }))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ArtifactContentError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

/** GET /api/tasks/:id/context — read the workspace context file (context.md)
 *  + the structured spec snapshot (spec.json) + filesystem paths. Returns
 *  { content, path, artifactsDir, homePath, specContent, specPath }.
 *  content/specContent may be null if the file hasn't been created yet. */
export async function getTaskContext(taskId: string): Promise<{
  content: string | null
  path: string
  artifactsDir: string
  homePath: string
  specContent: string | null
  specPath: string
}> {
  const res = await fetch(buildUrl(`/${taskId}/context`))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ============ Workflow-ref view (task board: click bound workflow → full YAML) ============

/** Error thrown by {@link getWorkflowRefView} when the bound ref can no longer
 *  be resolved (400 — was bound but is neither an installed builtin nor a task
 *  home workflows/ file) or the task is gone (404). The viewer surfaces a
 *  degraded state instead of white-screening (same discipline as
 *  {@link ArtifactContentError}). */
export class WorkflowRefViewError extends Error {
  public readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "WorkflowRefViewError"
    this.status = status
  }
}

export interface WorkflowRefView {
  /** The bound ref; null when nothing is bound. */
  ref: string | null
  /** Full raw YAML text; null when unbound. */
  content: string | null
  /** Where the ref resolved: installed builtin vs task home workflows/ dir. */
  source: "builtin" | "task-home" | null
}

/** GET /api/tasks/:id/workflow-ref — full YAML content of the workflow this
 *  task is bound to (ADR-0013 HOW entry). Server resolution order: installed
 *  builtin → task home workflows/. Unbound → 200 with all-null payload.
 *  Non-2xx → {@link WorkflowRefViewError} carrying the status (400 unresolvable
 *  / 404 task missing) so the dialog can show the matching degraded hint. */
export async function getWorkflowRefView(taskId: string): Promise<WorkflowRefView> {
  const res = await fetch(buildUrl(`/${taskId}/workflow-ref`))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new WorkflowRefViewError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

// ============ Assist workflows (ticket 07 routes — US9/10/11/D9) ============

/** The 3 built-in assist-workflow template ids (AC3 whitelist). Mirrors the
 *  server's `ASSIST_WORKFLOW_TEMPLATES` constant. The MoA trigger button uses
 *  `moa-requirements-review` (primary). */
export const ASSIST_WORKFLOW_TEMPLATES = [
  "moa-requirements-review",
  "spec-review-swarm",
  "clarify-debate",
] as const
export type AssistWorkflowTemplate = (typeof ASSIST_WORKFLOW_TEMPLATES)[number]

export interface AssistWorkflowTriggerResult {
  run_id: string
  execution_id: string
  workspace_id: string
  template: string
}

/** POST /api/tasks/:id/assist-workflows — trigger a built-in assist-workflow run
 *  (US9). Body: `{ template, input? }`. Non-whitelist template → 400. The run
 *  executes in the background; the response returns immediately with the run id.
 *  Progress/completion arrive via `assist_run_update` SSE (D19). On completion,
 *  a markdown artifact is written to the task's artifacts/ dir.
 *
 *  v2 (dynamic MoA/Debate): template = "dynamic-moa-analysis", input carries
 *  mode, experts[{agent, engine, model}], aggregator?, rounds?, userInput. */
export async function triggerAssistWorkflow(
  taskId: string,
  template: string,
  input?: {
    goal?: string
    ac?: string[]
    projects?: string[]
    userInput?: string
    /** "moa" (parallel + aggregate) or "debate" (multi-round argue). */
    mode?: "moa" | "debate"
    /** Expert rows: each = { agent id, engine, model }. Min 2. */
    experts?: Array<{ agent: string; engine: string; model: string }>
    /** Aggregator model config (MoA mode only). */
    aggregator?: { engine?: string; model: string }
    /** Max debate rounds (Debate mode only, default 3). */
    rounds?: number
  },
): Promise<AssistWorkflowTriggerResult> {
  const body: Record<string, unknown> = { template }
  if (input) body.input = input
  const res = await fetch(buildUrl(`/${taskId}/assist-workflows`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return handleResponse<AssistWorkflowTriggerResult>(res)
}

/** GET /api/tasks/:id/assist-workflows/:runId — run status + process logs +
 *  structured output (US10/US11). Parse failure → `output_raw` +
 *  `output_parse_error=true` on the 200 response (SW-BP10), never an error
 *  status. Missing/mismatched run → throws (404). */
export async function getAssistWorkflowRun(taskId: string, runId: string): Promise<AssistWorkflowRun> {
  const res = await fetch(buildUrl(`/${taskId}/assist-workflows/${runId}`))
  return handleResponse<AssistWorkflowRun>(res)
}

// Re-export shared types so callers can import everything from one place.
export type { Task, TaskStatus, TaskSpecField, ArtifactIndexEntry, AssistWorkflowRun } from "@octopus/shared"
