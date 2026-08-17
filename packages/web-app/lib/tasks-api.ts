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
 *  create a draft implicitly; both paths converge on the server's createTask. */
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
 *  running. 409 if not draft. */
export async function readyTask(id: string): Promise<Task> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/ready`, { method: "POST" })
  return handleResponse<Task>(res)
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
 *  endpoint. Merges a single field into the right column, bumps version,
 *  emits `spec_field_update` SSE so the SpecPanel applies the field locally +
 *  bumps its tracked version (avoids a subsequent [save] 409, v2-D12). */
export async function updateSpecField(
  id: string,
  field: TaskSpecField,
  value: unknown,
): Promise<{ version: number }> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/spec-field`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, value }),
  })
  return handleResponse<{ version: number }>(res)
}

// Re-export shared types so callers can import everything from one place.
export type { Task, TaskStatus, TaskSpecField } from "@octopus/shared"
