// packages/web-app/lib/tasks-api.ts
//
// Thin client for the first-class `/api/tasks` domain (v2-D1). Mirrors the
// scheduler-api factory pattern: pure fetch wrapper, no DB, no Hono. Every
// function maps 1:1 to a route in packages/server/src/routes/tasks.ts — the
// server is the single source of truth for response shapes (TaskDTO /
// TaskDetailDTO). Types come from @octopus/shared so the client stays in lock
// step with the Zod schemas (SG14: read `Task`, NOT `SchedulerJob`).

import { getServerUrl } from "@/lib/server-config"
import type {
  Task,
  TaskExecutionBadge,
  TaskStatus,
  TaskSpecField,
  TaskSpec,
  ResourceRef,
  ArtifactIndexEntry,
  AssistWorkflowRun,
  TaskPhaseStatus,
} from "@octopus/shared"

// ── Task read-model aliases (ADR-0021 票05) ─────────────────────────
//
// The wire shape is shared's `Task`, verbatim: the trigger columns
// (trigger_mode / trigger_at / cron_* / trigger_enabled:boolean / next_fire_at /
// last_fired_at) and the current-instance badge (`execution: TaskExecutionBadge`)
// are declared there, envelope mirrors `schedule_status`/`scheduled_at` included
// in the deletion. lib/ no longer mirrors any of it — the old local copies
// existed only while shared still carried the retired envelope columns; that
// trim is done, and a second copy would just be drift bait (the number-vs-boolean
// `trigger_enabled` between an old mirror and shared literally collapsed every
// `Task & TaskTriggerFields` consumer to `never`).
//
// What still legitimately lives here, because the server file that produces it
// is not importable from web:
//   - `derived` on the detail payload (mirror of @octopus/server
//     derive-task-view.ts — see TaskDerivedView below), and
//   - `executions[]` on the detail payload (GET /:id run history; each badge may
//     carry its composite fan-out in `children` — the board's list badge does
//     NOT load children, so `children === undefined` means "not loaded", never
//     "no subunits").
// `TaskView` stays as the board-row name (the list/summary endpoints answer it);
// `TaskDetail` is that plus the two fields above.

/** TaskDTO — one board row (GET /api/tasks items, GET /:id, and the trigger
 *  endpoints' summary). Alias of shared `Task` by design: keep the name so the
 *  seam (what the tasks API answers) has one place to grow. */
export type TaskView = Task

/** TaskDetail = TaskView + run history + derived (v4 视图). */
export type TaskDetail = TaskView & {
  /** Every ROOT execution of this task, newest first (empty for a draft).
   *  Composite SUBUNIT runs hang off their root's `children` (票05: detail and
   *  /executions load the fan-out; the board badge does not). */
  executions: TaskExecutionBadge[]
  derived?: TaskDerivedView
}

// ── Derived phase view (task-phase-redesign v4, ticket 07 契约) ──────
//
// GET /api/tasks/:id embeds `derived` = the server's deriveTaskView output
// VERBATIM (票 03 唯一真相；票 07 「GET /:id 增 phases 视图」). The canonical
// types live in @octopus/server (derive-task-view.ts) — web-app cannot import
// cross-package, so this mirror stays (it is the only reason the local
// detail type above extends shared instead of aliasing it).
// 票 11 看板角标/时间线 与 票 12 验收弹窗都只读这个视图，MUST NOT re-implement
// the derive matrix client-side.

/** Normalized outcome of one round's execution row (mirror of server
 *  TaskRoundState). Terminal = succeeded | failed | cancelled. */
export type TaskRoundState = "pending" | "running" | "paused" | "succeeded" | "failed" | "cancelled"

/** Mirror of the server's DerivedTaskStatus (derive-task-view.ts). Deliberately NOT
 *  `TaskStatus`: the derive output vocabulary is its own thing — 'draft'/'failed' are
 *  input-side passthroughs it never produces, and 'paused' is a value NO task row can
 *  ever carry (the truth is executions.status='paused'). Typing the wire field as plain
 *  TaskStatus was a mirror that lied, and the label tables below fall back silently on a
 *  missing key rather than failing loudly. */
export type DerivedTaskStatus =
  | "ready"
  | "running"
  | "paused"
  | "awaiting_review"
  | "archiving"
  | "done"
  | "aborted"

/** Mirror of the server's DerivedPhaseStatus. Same reasoning: 'accepted' is derive-only
 *  and 'paused' has no persisted counterpart. */
export type DerivedPhaseStatus = "pending" | "running" | "paused" | "awaiting_review" | "accepted"

/** What a card's column is decided by: persisted status for v3, derived for v4 —
 *  hence the union (mirrors the server's `TaskView.taskStatus`). */
export type TaskDisplayStatus = TaskStatus | DerivedTaskStatus

/** Human decision overlay on a round (latest ledger row wins). */
export type TaskRoundDecision = "accepted" | "rejected"

/** The execution-row subset deriveTaskView passes through. Only created_at is
 *  available for the ⏳ over-budget calc (no completed_at on the wire) — so the
 *  advisory badge only ever applies to IN-FLIGHT rounds (pending/running). */
export interface TaskRoundExec {
  id: string
  status: string
  /** ADR-0018: the workflow this round ACTUALLY ran (打回轻量修复轮 = task-fix
   *  while the phase binding stays the dev flow). Older servers omit it →
   *  consumers fall back to the phase's workflowRef. */
  workflow_ref?: string
  phase_index: number | null
  round_index: number | null
  created_at: string
}

export interface TaskRoundView {
  roundIndex: number
  exec: TaskRoundExec
  state: TaskRoundState
  /** Latest human decision on this exact round, or null (未验收). */
  decision: TaskRoundDecision | null
}

export interface TaskPhaseView {
  /** 1-based, mirrors TaskPhase.index. */
  index: number
  name: string
  slug: string
  workflowRef: string
  /** Derived display status — NOT the shared TaskPhaseStatusSchema (that enum describes
   *  the persisted phase node; this one is deriveTaskView's output vocabulary and
   *  additionally carries 'paused'). */
  status: DerivedPhaseStatus
  /** Ascending by roundIndex. */
  rounds: TaskRoundView[]
  /** Max round_index seen (null = never started). */
  currentRound: number | null
  acceptedRound: number | null
  /** Round that is terminal-and-unreviewed while status=awaiting_review. */
  awaitingRound: number | null
}

/** deriveTaskView output. v4: `{taskStatus: <derived>, isV4: true, phaseViews:[...]}`;
 *  v3/generic: `{taskStatus: <持久态 verbatim>, isV4: false, phaseViews: []}`
 *  — the field is ALWAYS present on GET /:id responses from the v4 server
 *  (票 07 契约), so 票 11/12 render one code path. Optional in the type only for
 *  backward compat with pre-v4 servers / test fixtures. */
export interface TaskDerivedView {
  /** v4: always within DerivedTaskStatus. Non-v4: verbatim mirror of task.status
   *  (which is why the server types this as the union). */
  taskStatus: TaskDisplayStatus
  isV4: boolean
  phaseViews: TaskPhaseView[]
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
  // ── task-phase-redesign 契约修复（POST 直建 v4）──
  /** RAW initial task_spec — the server validates (taskSpecSchema, ZodError →
   *  400). `{format:"v4"}` creates a v4 draft directly (home + manifest.json
   *  snapshot carry the flag; no task_type → no v3 shell). This is the body
   *  the [新建任务] sequence sends; mirrors server CreateTaskInput. Partial —
   *  the output TaskSpec type requires defaulted keys; on input you only send
   *  what you mean (the server parses + fills defaults). */
  task_spec?: Partial<TaskSpec>
  /** Top-level project ids (wins over preset.projects; both → project_ids col). */
  project_ids?: string[]
  skills?: string[]
  resources?: ResourceRef[]
  authoring_resources?: ResourceRef[]
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

/** GET /api/tasks — list (kanban); ?status=&org=. Returns {items: TaskView[]}, each
 *  row carrying the 票03 trigger columns + its current instance (`execution`), which
 *  is what the 「已排队」 badge and the 上一轮 status now read. */
export async function listTasks(params?: ListTasksParams): Promise<{ items: TaskView[] }> {
  const res = await fetch(buildUrl("", { status: params?.status, org: params?.org }))
  return handleResponse<{ items: TaskView[] }>(res)
}

/** GET /api/tasks/:id — detail (task + run history `executions` + derived v4 view). */
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
export async function createTask(input: CreateTaskInput): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return handleResponse<TaskView>(res)
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
): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-Match": String(version),
    },
    body: JSON.stringify(input),
  })
  return handleResponse<TaskView>(res)
}

/** DELETE /api/tasks/:id — soft-delete (discard draft/ready). 票03: no cascade — a
 *  task's runs are `executions` rows, which outlive it as rows (nothing to reap).
 *  Running tasks must be aborted first (409). */
export async function deleteTask(id: string): Promise<{ ok: true }> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}`, { method: "DELETE" })
  return handleResponse<{ ok: true }>(res)
}

// ============ Actions ============

/** POST /api/tasks/:id/ready — draft→ready (confirm gate, v1 D13). 票03: the gate
 *  creates NO run — arming happens in /trigger. v3 tasks (task_type set) must
 *  additionally pass the confirmation gate (goal non-empty ∧ ac≥1 ∧ goal_confirmed ∧
 *  all ac in ac_confirmed). On failure the server returns 409 with `{error,
 *  missing[]}`; this function throws a {@link TaskReadyGateError} carrying `.missing`
 *  so the UI can show exactly what to confirm before enqueue (server-side gate
 *  is the backstop for UI temp state lost on modal close). 409 if not draft. */
export async function readyTask(id: string): Promise<TaskView> {
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

/** POST /api/tasks/:id/abort — running/ready→aborted (v1 G4). 票03: stops the task's
 *  OWN instances (a live one goes through the engine cancel, a queued one is
 *  retired), writes tasks.status='aborted', emits task_status SSE. Does not touch
 *  schedules. 409 if not ready/running. */
export async function abortTask(id: string): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/abort`, { method: "POST" })
  return handleResponse<TaskView>(res)
}

/** POST /api/tasks/:id/pause — 暂停任务当前这一轮。
 *
 *  暂停本身是 **execution** 的事实（服务端委派给绑定执行的 pause：硬杀在飞节点、
 *  落 executions.status='paused'），task 的「已暂停」是从那一行**派生**出来的 ——
 *  没有 paused 的 task 行。这就是解耦的落点：不是每个工作流都绑了 task。
 *
 *  与工作流页同规则：只有真正 running 的执行能暂停。停在审批/交互节点等人的运行
 *  会被 409 拒绝并给出对应说法（那种情况是引擎活着在等人，标成「已暂停」会把
 *  「需要你审批」这件事盖掉）。409 的 message 已是面向用户的中文。 */
export async function pauseTask(id: string): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/pause`, { method: "POST" })
  return handleResponse<TaskView>(res)
}

/** POST /api/tasks/:id/resume — 把这一轮从刹车放开，可带一句 `intervention`
 *  注入给被中断的节点（与工作流页 resume 的 body 同形）。 */
export async function resumeTask(id: string, intervention?: string): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/resume`, {
    method: "POST",
    ...(intervention
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intervention }) }
      : {}),
  })
  return handleResponse<TaskView>(res)
}

/** POST /api/tasks/:id/reopen — 入队撤回 (ready→draft)：任务回到 draft 重新可编辑。
 *  票03 守卫改成「没有活实例」：currentInstance 非终态即 409（改用中止）。 */
export async function reopenTask(id: string): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/reopen`, { method: "POST" })
  return handleResponse<TaskView>(res)
}

/** POST /api/tasks/:id/trigger — v39 人工触发 (票03 semantics).
 *  `at` absent/past → arms a run + launches it inside the concurrency gate right
 *  away (status → running). `at` in the future → only arms the cursor: the task
 *  stays 'ready' with `next_fire_at = at`, and the built-in task-lifecycle job starts
 *  it when due. Existing live instance → 409 (「已有进行中的实例」); a workspace that
 *  cannot be pre-built → 409 on the click, not a minute later. Error(body.error) —
 *  the server's conflict messages are already user-facing Chinese. */
export async function triggerTask(id: string, at?: string): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(at ? { at } : {}),
  })
  return handleResponse<TaskView>(res)
}

/** POST /api/tasks/:id/trigger/cancel — withdraw a not-yet-started fire: the queued
 *  (pending) instance is retired + the cursor is disarmed, task returns to ready.
 *  Already started → 409 Error. */
export async function cancelTaskTrigger(id: string): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/trigger/cancel`, { method: "POST" })
  return handleResponse<TaskView>(res)
}

/** POST /api/tasks/:id/trigger/schedule — 周期触发 (票03, ADR-0021). Two body
 *  shapes, exactly as the route branches them:
 *   `{ cron, timezone? }`  → arm / replace a recurring fire (trigger_mode='cron')
 *   `{ enabled: boolean }` → pause / resume that fire without forgetting the cron
 * `cron: null` (or {@link unscheduleTaskTrigger}) goes back to manual. The server
 * answers with the task's list-row summary (trigger columns + current instance), so
 * the caller re-reads one number instead of a whole detail payload. */
export async function scheduleTaskTrigger(
  id: string,
  body: { cron: string; timezone?: string } | { enabled: boolean },
): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/trigger/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return handleResponse<TaskView>(res)
}

/** POST /api/tasks/:id/trigger/unschedule — drop the schedule, keep the task
 *  (trigger_mode → 'manual'). Same summary response as {@link scheduleTaskTrigger}. */
export async function unscheduleTaskTrigger(id: string): Promise<TaskView> {
  const res = await fetch(`${getServerUrl()}${BASE}/${id}/trigger/unschedule`, {
    method: "POST",
  })
  return handleResponse<TaskView>(res)
}

// ============ v4 验收 Gate (task-phase-redesign ticket 07 契约) ────────

/** Non-2xx from the acceptance/advance endpoints. Carries the HTTP status so
 *  the caller (票 12 dialog) can distinguish 409 (派生态不匹配 / 重复提交 →
 *  re-GET + 刷新) from 400 (body 非法) / 404 without string-matching. */
export class TaskApiError extends Error {
  public readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "TaskApiError"
    this.status = status
  }
}

/** Body of POST /api/tasks/:id/acceptance (票 07 契约). Indices are 1-based,
 *  matching TaskPhase.index / executions.phase_index. rejected 必填 feedback
 *  (缺 → 400). */
export interface AcceptanceInput {
  phase_index: number
  round_index: number
  decision: "accepted" | "rejected"
  feedback?: string
  /** ADR-0018 打回二分路由（rejected 生效）：
   *  "rerun"（缺省）= 重跑绑定流（matt-spec-dev 绑定时即「修订重跑」——流内
   *  spec 再审段在 ws 就地更新 spec）；"fix" = 轻量修复（server override
   *  built-in/task-fix + 合成输入）。 */
  next_flow?: "fix" | "rerun"
  /** ADR-0022 打回 ✗ 闭环：被重开的票名基（如 "11-e2e-story"），server 把对应
   *  issues/<name>.md 的 Status done→reopened。 */
  reopen_tickets?: string[]
}

/** What the caller must do next (票 07):
 *  - "dispatched"               a new round is already running (advance or retry)
 *  - "archiving"                last phase accepted — the task is in 归档 (票 08)
 *  - "awaiting_manual_trigger"  accepted with autoAdvance=false — parked at the
 *                               human gate (K6/US11), nothing was started. */
export type AcceptanceNextAction = "dispatched" | "archiving" | "awaiting_manual_trigger"

/** Round identity the server actually dispatched (present iff
 *  next_action === "dispatched"). 票03: `schedule_id` left with the envelope row —
 *  the round IS the execution, so `execution_id` is the only run handle. */
export interface AcceptanceDispatch {
  execution_id: string
  workspace_id: string
  phase_index: number
  round_index: number
}

/** 200 body of POST /:id/acceptance — `task` is the SAME shape as GET /:id
 *  (executions + derived included), re-derived AFTER the decision was applied. */
export interface AcceptanceResult {
  task: TaskDetail
  acceptance_id: string
  next_action: AcceptanceNextAction
  dispatch?: AcceptanceDispatch
}

/** 200 body of POST /:id/advance — same shape minus the ledger row (advance
 *  不写验收账本；它是 autoAdvance=false 时「人工起下一 phase」的入口，
 *  票 07 活体交互 #3 登记、server 落地归票 08/12 接线). */
export interface AdvanceResult {
  task: TaskDetail
  next_action: AcceptanceNextAction
  dispatch?: AcceptanceDispatch
}

/** POST /api/tasks/:id/acceptance — the v4 验收 Gate (K6/K7).
 *  404 任务不存在；409 派生态非 awaiting_review / round 不匹配 / 该轮已验收
 *  (重复提交) / 非 v4；400 body 非法 (rejected 缺 feedback 等)。 */
export async function postAcceptance(
  taskId: string,
  body: AcceptanceInput,
): Promise<AcceptanceResult> {
  const res = await fetch(buildUrl(`/${taskId}/acceptance`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new TaskApiError(err.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

/** POST /api/tasks/:id/advance — 手动开跑指定 phase 的下一 round
 *  (autoAdvance=false 的 my-gate 放行入口, US11; 票 12 复用). Body
 *  `{phase_index}` (1-based). Response mirrors AcceptanceResult without
 *  acceptance_id. 非 v4 / 派生态不允许 → 409 (TaskApiError). */
export async function postAdvance(taskId: string): Promise<AdvanceResult> {
  // No body: the server picks the target phase itself (派生「前序 accepted ∧
  // pending」唯一解, 票 08 advancePhase). A client-computed phase_index was a
  // dead parameter + drift bait (review ②) — display gating stays client-side
  // (advancePhaseOf), authority stays server-side.
  const res = await fetch(buildUrl(`/${taskId}/advance`), { method: "POST" })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new TaskApiError(err.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

/** POST /api/tasks/:id/archive/retry — 票 08 归档幂等续跑（仅 archiving 态，
 *  202 异步；完成以 task_status SSE 'done' 为准）。 */
export async function postArchiveRetry(taskId: string): Promise<{ ok: boolean; task_id: string; status: string }> {
  const res = await fetch(buildUrl(`/${taskId}/archive/retry`), { method: "POST" })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new TaskApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
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
 *  + the structured task_spec snapshot (manifest.json) + filesystem paths.
 *  Returns { content, path, artifactsDir, homePath, manifestContent, manifestPath }.
 *  content/manifestContent may be null if the file hasn't been created yet
 *  (manifestContent also falls back to a pre-rename spec.json read server-side). */
export async function getTaskContext(taskId: string): Promise<{
  content: string | null
  path: string
  artifactsDir: string
  homePath: string
  manifestContent: string | null
  manifestPath: string
}> {
  const res = await fetch(buildUrl(`/${taskId}/context`))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

// ============ Home batch-file read/write (v4 spec 审阅 + 验收证据面) ============

/** Mirror of server TaskHomeService.MAX_HOME_FILE_READ_BYTES (packages/server/
 *  src/services/tasks/task-home-service.ts) — 改一处必改两处。Used to pre-gate
 *  unpreviewable rows; the server's 413 stays authoritative. */
export const MAX_HOME_FILE_READ_BYTES = 512_000

/** GET /api/tasks/:id/home-file?path= — read ANY file under `.scratch/**` of
 *  the task home (spec.md 审阅 + v4 验收证据: e2e txt/json/probe …). 404 (file
 *  missing) / 403 (off-whitelist) / 413 (over the byte cap) throw
 *  {@link TaskApiError} carrying the status: the PhaseSpecDialog maps 404 →
 *  "create skeleton" empty state, 403 → read-only path display. */
export async function getHomeFile(taskId: string, relPath: string): Promise<ArtifactContent> {
  const res = await fetch(buildUrl(`/${taskId}/home-file`, { path: relPath }))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new TaskApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

/** PUT /api/tasks/:id/home-file — write/overwrite a `.scratch/**.md` (parents
 *  created; the UI's skeleton flow). No If-Match: the file is not the task row
 *  (no version involved server-side either). 400 body / 403 guard / 404 unknown
 *  task / 409 non-editable status → TaskApiError with the status. */
export async function putHomeFile(
  taskId: string,
  relPath: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const res = await fetch(`${getServerUrl()}${BASE}/${taskId}/home-file`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: relPath, content }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new TaskApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

// ============ Home batch-dir LIST (ADR-0018: spec 家族/反馈/报告 可见性) ============

/** One `.md` under a `.scratch/` batch dir (home-side mirror = last collected
 *  final state; spec.md / spec-rN.md / fix-feedback-rN.md / fix-report-rN.md /
 *  issues/*.md). */
export interface HomeFileListingEntry {
  path: string
  mtime: string
  bytes: number
}

/** GET /api/tasks/:id/home-file?path=<dir>&list=1[&all=1] — list the batch
 *  dir's files (depth ≤2, cap 200). Default `.md`-only (作者态契约); `opts.all`
 *  widens to every regular file (验收证据面: e2e-data/*.txt …). 404 dir missing
 *  → TaskApiError(404); the dialog renders its empty state from that. */
export async function listHomeDir(
  taskId: string,
  relDir: string,
  opts?: { all?: boolean },
): Promise<HomeFileListingEntry[]> {
  const res = await fetch(
    buildUrl(`/${taskId}/home-file`, { path: relDir, list: "1", ...(opts?.all ? { all: "1" } : {}) }),
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new TaskApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  const data = (await res.json()) as { files: HomeFileListingEntry[] }
  return data.files
}

// ============ Batch-tree (draft-artifact-visibility #53: 磁盘直扫) ============

/** One `.scratch/` batch dir (server-side disk scan — decoupled from
 *  task_spec.phases[]: files land here the moment the agent writes them).
 *  `dir` / `files[].path` are home-relative posix, usable as getHomeFile args. */
export interface BatchTreeEntry {
  dir: string
  slug: string
  files: HomeFileListingEntry[]
  latest_mtime: string
}

/** GET /api/tasks/:id/batch-tree — all batch dirs under the home's `.scratch/`,
 *  newest-mtime first, cap 300 files. Empty `.scratch/` → `[]` (200, the normal
 *  drafting state); only an unknown task throws TaskApiError(404). */
export async function getBatchTree(taskId: string): Promise<BatchTreeEntry[]> {
  const res = await fetch(buildUrl(`/${taskId}/batch-tree`))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new TaskApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  const data = (await res.json()) as { batches: BatchTreeEntry[] }
  return data.batches
}

// ============ 验货台 (acceptance v2): 实物 round-diff + 当场复检 ============
// 镜像 server round-evidence-service.ts 的 payload 形状（SHAs 永不出服务端；
// 端点都按 task id 解析 awaiting round，无 awaiting → 409）。

export interface DiffFile {
  path: string
  /** rename/copy source (status R/C). */
  oldPath?: string
  /** git 单字母状态码 A/M/D/R/C/T。 */
  status: string
  adds: number
  dels: number
  binary?: boolean
}

export interface DiffGroup {
  dir: string
  additions: number
  dels: number
  files: DiffFile[]
}

export interface RepoDiff {
  name: string
  expired?: boolean
  reason?: "no_workspace" | "no_commits" | "worktree_gone"
  commits: number
  additions: number
  dels: number
  files: number
  truncated: boolean
  groups: DiffGroup[]
}

export interface RoundDiffPayload {
  available: boolean
  reason?: string
  aggregate: { commits: number; additions: number; dels: number; files: number }
  /** harness 干预次数（executions.harness_summary）；null = 无数据。 */
  interventions: number | null
  repos: RepoDiff[]
}

export type VerifyState = "running" | "passed" | "failed" | "aborted" | "timeout"

export interface VerifySummary {
  task_id: string
  execution_id: string
  phase_index: number
  round_index: number
  command: string
  cwd: string
  state: VerifyState
  started_at: string
  ended_at?: string
  exit_code?: number
  duration_ms?: number
  verdict_path?: string | null
  tail?: string[]
}

/** GET /:id/round-diff — 待验收轮的真实 git 区间统计。409 无 awaiting / 404 无任务。 */
export async function getRoundDiff(taskId: string): Promise<RoundDiffPayload> {
  const res = await fetch(buildUrl(`/${taskId}/round-diff`))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new TaskApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

/** GET /:id/round-diff/patch?repo=&path= — 单文件 unified patch（懒拉，512K 截断）。 */
export async function getRoundPatch(
  taskId: string,
  repo: string,
  filePath: string,
): Promise<{ patch: string; truncated: boolean }> {
  const res = await fetch(buildUrl(`/${taskId}/round-diff/patch`, { repo, path: filePath }))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new TaskApiError(body.error ?? `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

/** POST /:id/verify — 起当场复检（202 + running summary）。400 未配置命令 /
 *  409 无 awaiting·在跑·ws 不在。进度走 taskpool SSE（task_verify_log 逐行 +
 *  task_verify 终态），重连用 getVerifyStatus 的 tail 重建。 */
export async function startVerify(taskId: string): Promise<VerifySummary> {
  const res = await fetch(`${getServerUrl()}${BASE}/${taskId}/verify`, { method: "POST" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new TaskApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status)
  return body as VerifySummary
}

/** GET /:id/verify — 会话摘要（含 tail 200）；从未跑过/重启后 → null。 */
export async function getVerifyStatus(taskId: string): Promise<VerifySummary | null> {
  const res = await fetch(buildUrl(`/${taskId}/verify`))
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new TaskApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status)
  }
  return (await res.json()) as VerifySummary | null
}

/** POST /:id/verify/abort — SIGTERM 进程树；终态经 SSE 到达。409 没有在跑的。 */
export async function abortVerify(taskId: string): Promise<VerifySummary> {
  const res = await fetch(`${getServerUrl()}${BASE}/${taskId}/verify/abort`, { method: "POST" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new TaskApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status)
  return body as VerifySummary
}

// ============ 验收面 v2.1: 验收剧本(playbook)+ 跑起来看(preview)============
// 镜像 server playbook-types.ts / round-evidence-service.ts。checks 走 home-file
// 的 .md 门(内嵌 json 围栏),与 server renderChecksMd/parseChecksMd 同 codec。

export type PlaybookItemKind = "walk" | "probe" | "claim"
export interface PlaybookItem { id: string; op: string; expect: string; evidence?: string; probe?: { command: string } }
export interface PlaybookSection { kind: PlaybookItemKind; title: string; source: string; items: PlaybookItem[] }
export interface PlaybookCarryover { id: string; fromRound: number; decision: "skipped" | "failed"; note?: string; op: string; expect: string }
export interface PlaybookBudget { steps: number; estMin: number; over: boolean; degraded: boolean }
export interface PlaybookPayload {
  available: boolean
  goal: string
  specRevised: boolean
  budget: PlaybookBudget
  sections: PlaybookSection[]
  finePrint: Array<{ ticket: string; acs: string[] }>
  carryover: PlaybookCarryover[]
  coverage: { found: string[]; missing: string[] }
}

/** GET /:id/playbook — 派生视图。409 无 awaiting;available:false = 无契约结构。 */
export async function getPlaybook(taskId: string): Promise<PlaybookPayload> {
  const res = await fetch(buildUrl(`/${taskId}/playbook`))
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new TaskApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status)
  return body as PlaybookPayload
}

// ── preview ───────────────────────────────────────────────────────────
export type PreviewState = "starting" | "ready" | "exited" | "stopped" | "failed"
export interface PreviewSummary {
  task_id: string
  execution_id?: string
  command?: string
  url: string
  state: PreviewState
  external?: boolean
  started_at?: string
  ended_at?: string
  exit_code?: number
  duration_ms?: number
  tail?: string[]
}

/** POST /:id/preview — 起跑长驻进程(202)。400 未配命令/非法url/$vars.;409 冲突。 */
export async function startPreview(taskId: string): Promise<PreviewSummary> {
  const res = await fetch(`${getServerUrl()}${BASE}/${taskId}/preview`, { method: "POST" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new TaskApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status)
  return body as PreviewSummary
}
/** GET /:id/preview — 会话态或一次性外部探活(external)。 */
export async function getPreview(taskId: string): Promise<PreviewSummary | null> {
  const res = await fetch(buildUrl(`/${taskId}/preview`))
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new TaskApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status)
  return (body ?? null) as PreviewSummary | null
}
/** POST /:id/preview/stop — SIGTERM 树。409 没有在跑的。 */
export async function stopPreview(taskId: string): Promise<PreviewSummary> {
  const res = await fetch(`${getServerUrl()}${BASE}/${taskId}/preview/stop`, { method: "POST" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new TaskApiError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status)
  return body as PreviewSummary
}

// ── checks 落盘(acceptance-checks-r{N}.md,复用 home-file .md 门)──────────
export type CheckDecision = "pass" | "fail" | "skip"
export interface CheckEntry { decision: CheckDecision; note: string; at: string }
export interface ChecksFile { version: "1"; task_id?: string; round_index?: number; checks: Record<string, CheckEntry> }

export const checksFileName = (roundIndex: number): string => `acceptance-checks-r${roundIndex}.md`
const CHECKS_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/

export function parseChecksMd(md: string): ChecksFile | null {
  const m = CHECKS_FENCE_RE.exec(md)
  if (!m) return null
  try {
    const o = JSON.parse(m[1]) as ChecksFile
    return o && typeof o === "object" && typeof o.checks === "object" && o.checks ? o : null
  } catch {
    return null
  }
}
export function renderChecksMd(data: ChecksFile): string {
  return [
    `# 走查勾选 · Round ${data.round_index ?? "?"}`,
    "",
    "> 机器读写:验收台勾选 → 本文件;ledger 聚合、下轮 carryover 都吃它。JSON 体可手改。",
    "",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
    "",
  ].join("\n")
}
export const checksRelPath = (batchRelDir: string, roundIndex: number): string =>
  `${batchRelDir}/${checksFileName(roundIndex)}`

/** 读某轮 checks;不存在/解析失败 → {}(诚实空态,不猜)。 */
export async function readChecks(taskId: string, batchRelDir: string, roundIndex: number): Promise<ChecksFile> {
  try {
    const f = await getHomeFile(taskId, checksRelPath(batchRelDir, roundIndex))
    return parseChecksMd(f.content) ?? { version: "1", round_index: roundIndex, checks: {} }
  } catch {
    return { version: "1", round_index: roundIndex, checks: {} }
  }
}
/** 写某轮 checks(整文件覆盖,panel 是唯一作者;round-trip 幂等)。 */
export async function saveChecks(
  taskId: string, batchRelDir: string, roundIndex: number, checks: Record<string, CheckEntry>,
): Promise<void> {
  const data: ChecksFile = { version: "1", task_id: taskId, round_index: roundIndex, checks }
  await putHomeFile(taskId, checksRelPath(batchRelDir, roundIndex), renderChecksMd(data))
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
export type {
  Task,
  TaskExecutionBadge,
  TaskStatus,
  TaskSpecField,
  TriggerMode,
  ArtifactIndexEntry,
  AssistWorkflowRun,
  TaskPhase,
  TaskPhaseStatus,
} from "@octopus/shared"
