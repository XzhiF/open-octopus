// packages/web-app/e2e/helpers/task-domain-helpers.ts
//
// Shared helpers for the task-domain E2E specs (tickets 12 — Story A/B/C +
// crash/abort). Centralizes:
//   - Server availability probe (R1: real server, no mocks)
//   - /api/tasks + /api/clones API helpers (request → response, R3: API↔DB)
//   - Direct SQLite reads via node:sqlite (R3/R4: assert response+SQL).
//     node:sqlite is a Node.js ≥22.5 built-in; falls back to API-only when the
//     module or DB file is unavailable so the specs still parse + list in any
//     environment.
//   - SSE collector for /api/tasks/events (task_status + task_execution +
//     task_trigger + spec_field_update)
//   - Screenshot dir (E2E_ARTIFACTS_DIR, R-screenshot evidence)
//
// Data prefix E2E_TD_ (R7) — all task names/orgs carry this prefix so the
// phase-4 cleanup sweep can identify + reap leftover rows.

import { request, type APIRequestContext } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
// ADR-0021 票05: the task read model's single type source is shared (web stopped
// mirroring it). The e2e DTOs are aliases of it, so a renamed column breaks the specs
// at compile time instead of silently comparing against a stale local copy. Type-only:
// nothing here pulls the built package into the Playwright runtime.
import type {
  Task,
  TaskExecutionBadge,
  TaskExecutionSsePayload,
  TaskTriggerSsePayload,
  TaskTriggerFailedSsePayload,
  TriggerMode,
} from "@octopus/shared"

// ── Constants ───────────────────────────────────────────────────────────

export const SERVER_URL = process.env.OCTOPUS_SERVER_URL ?? "http://localhost:3001"

/** E2E_TD_ data prefix (R7) — every task name + org carries this. */
export const DATA_PREFIX = "E2E_TD_"

/** Unique org for task-domain E2E (keeps test data isolated from real orgs). */
export const TASK_E2E_ORG = `${DATA_PREFIX}org`

// Screenshot / trace artifact directory. The pipeline sets E2E_ARTIFACTS_DIR;
// fall back to a scratch dir under .scratch so evidence always lands somewhere.
export const SCREENSHOT_DIR =
  process.env.E2E_ARTIFACTS_DIR
    ? path.join(process.env.E2E_ARTIFACTS_DIR, "e2e-screenshots", "task-domain")
    : path.resolve(__dirname, "../../../../.scratch/task-domain-redesign/e2e-screenshots")

// Ticket 11 — v3 full-link evidence dir. Screenshots for the
// task-authoring-v3 spec MUST land here (the pipeline artifact gate fails the
// phase when zero PNGs exist in this dir). Kept separate from SCREENSHOT_DIR
// so the task-domain-redesign specs keep writing to their own evidence dir.
export const V3_SCREENSHOT_DIR = path.resolve(
  __dirname,
  "../../../../.scratch/task-authoring-v3/e2e-screenshots",
)

// ── Logging ─────────────────────────────────────────────────────────────

/** Prefixed stdout — avoids bare console.log in E2E (matches octopus-agent-node.spec.ts). */
export const log = (msg: string): void => {
  process.stdout.write(`[e2e-td] ${msg}\n`)
}
export const logError = (msg: string): void => {
  process.stderr.write(`[e2e-td] ${msg}\n`)
}

// ── Screenshot dir ──────────────────────────────────────────────────────

export function ensureScreenshotDir(): void {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  }
}

export function screenshotPath(name: string): string {
  ensureScreenshotDir()
  return path.join(SCREENSHOT_DIR, name)
}

/** Ensure the v3 screenshot dir exists (ticket 11 evidence dir). */
export function ensureV3ScreenshotDir(): void {
  if (!fs.existsSync(V3_SCREENSHOT_DIR)) {
    fs.mkdirSync(V3_SCREENSHOT_DIR, { recursive: true })
  }
}

/** Resolve a screenshot path under the v3 evidence dir (ticket 11). Creates
 *  the dir on demand so the first screenshot never fails on a missing dir. */
export function v3ScreenshotPath(name: string): string {
  ensureV3ScreenshotDir()
  return path.join(V3_SCREENSHOT_DIR, name)
}

// ── Server availability (R1: real server) ──────────────────────────────

/** Probe /api/tasks — returns true when the real server is up + tasks routes registered. */
export async function isServerAvailable(): Promise<boolean> {
  const ctx = await request.newContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/tasks?org=${TASK_E2E_ORG}`, { timeout: 5000 })
    return res.ok()
  } catch {
    return false
  } finally {
    await ctx.dispose()
  }
}

// ── Direct SQLite reads (R3/R4: assert response+SQL) ───────────────────

/**
 * Resolve the dev SQLite DB path. Honors OCTOPUS_DB_PATH; falls back to
 * ~/.octopus/db/octopus.db (dev default from CLAUDE.md).
 */
export function resolveDbPath(): string {
  if (process.env.OCTOPUS_DB_PATH) return process.env.OCTOPUS_DB_PATH
  return path.join(os.homedir(), ".octopus", "db", "octopus.db")
}

interface NodeSqliteDb {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown
    all: (...params: unknown[]) => unknown[]
    run: (...params: unknown[]) => unknown
  }
  close: () => void
}

let sqliteImportFailed = false
let lastSqliteError: string | null = null

/**
 * Open a read-only SQLite connection to the dev DB. Uses node:sqlite (Node ≥22.5
 * built-in). Returns null when unavailable — callers fall back to API assertions
 * so the specs still run in environments without the DB file.
 */
export function openTaskDb(): NodeSqliteDb | null {
  if (sqliteImportFailed) return null
  const dbPath = resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    lastSqliteError = `DB file not found at ${dbPath}`
    return null
  }
  try {
    // node:sqlite is experimental; require may warn but works on Node ≥22.5.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => NodeSqliteDb
    }
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (err: unknown) {
    sqliteImportFailed = true
    lastSqliteError = err instanceof Error ? err.message : String(err)
    return null
  }
}

/** Last error from openTaskDb (for diagnostics when DB assertion is skipped). */
export function lastDbError(): string | null {
  return lastSqliteError
}

export interface TaskDbRow {
  id: string
  org: string
  name: string
  status: string
  source_chat_session_id: string | null
  task_spec: string
  authoring_resources: string
  resources: string
  skills: string
  project_ids: string
  workflow_ref: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  // ── WHEN this task runs (票03 moved this off the deleted `schedules` envelope onto
  // the task row; schema v41). These are the columns the DTO's trigger_* fields mirror.
  trigger_mode: string
  trigger_at: string | null
  cron_expression: string | null
  cron_timezone: string
  /** SQLite has no boolean: the read model maps `=== 1` (票05 §新事实1). */
  trigger_enabled: number
  next_fire_at: string | null
  last_fired_at: string | null
  /** v41+: workspaces carry the back-pointer, so 「这个 ws 属于哪个任务」 is a column
   *  read instead of the deleted schedules.origin_id join bridge. */
  workspace_id: string | null
}

/**
 * One task instance, read straight off `executions` (票03: the row IS the run — there
 * is no `schedules` envelope behind it any more, and schema v42 dropped the columns that
 * used to say so).
 *
 * Shape of the domain, so a spec can tell the three things apart without a second query:
 *   - `parent_id === '0'` → a ROOT: one v4 phase round, or one composite coordinator turn.
 *   - `parent_id !== '0'` → a composite fan-out arm; its identity is `parent_id` (the
 *     dispatching run) + `name` (the subunit's name, written by dispatchChildRun). This
 *     pair is what replaced `origin_role='subunit'`.
 *   - `status === 'pending'` → armed and queued behind the shared concurrency gate
 *     (「排队中」); `'running'` → executing (「执行中」); a terminal status → a finished run.
 *     The two are DIFFERENT moments now — under the envelope they were the same one, which
 *     is exactly why 「排队中」 used to look like 「执行中」.
 */
export interface TaskExecutionRow {
  id: string
  workspace_id: string
  parent_id: string
  child_index: number
  status: string
  workflow_ref: string
  workflow_name: string
  /** The subunit's name on an arm (票05); NULL on a root. */
  name: string | null
  phase_index: number | null
  round_index: number | null
  task_id: string | null
  started_at: string | null
  completed_at: string | null
  /** JSON blob. A failed row's `error` key is the one-line reason the badge shows. */
  var_pool: string
  created_at: string
}

/** Execution statuses that mean "this run is over" (mirrors shared's
 *  TERMINAL_EXECUTION_STATUSES; kept local so the specs' expectation does not move
 *  together with the production constant it is supposed to be checking). */
export const TERMINAL_EXECUTION_STATUSES: readonly string[] = [
  "completed",
  "completed_with_failures",
  "failed",
  "cancelled",
  "aborted",
  "skipped",
  "rejected",
]

export const isTerminalExecutionStatus = (status: string): boolean =>
  TERMINAL_EXECUTION_STATUSES.includes(status)

/** Read a tasks row directly from SQLite (R3: DB-side of API↔DB cross-check). */
export function readTaskRow(taskId: string): TaskDbRow | null {
  const db = openTaskDb()
  if (!db) return null
  try {
    const row = db.prepare(
      "SELECT id, org, name, status, source_chat_session_id, task_spec, authoring_resources, resources, skills, project_ids, workflow_ref, version, deleted_at, created_at, updated_at, completed_at, trigger_mode, trigger_at, cron_expression, cron_timezone, trigger_enabled, next_fire_at, last_fired_at, workspace_id FROM tasks WHERE id = ?",
    ).get(taskId)
    return (row as TaskDbRow | undefined) ?? null
  } finally {
    db.close()
  }
}

/**
 * Every `executions` row that serves this task — roots and composite arms alike
 * (ADR-0021 票03). Replaces `readSchedulesByOrigin`, which selected
 * `schedules.origin_type/origin_id/origin_role`: schema v42 dropped those columns, so a
 * task owns no row in the scheduler's table at all.
 *
 * Ordered by creation (rowid breaks same-second ties), so `[0]` is the first round;
 * callers split roots (`parent_id === '0'`) from arms (`parent_id !== '0'`, `name` = the
 * subunit).
 */
export function readTaskExecutions(taskId: string): TaskExecutionRow[] {
  const db = openTaskDb()
  if (!db) return []
  try {
    return db.prepare(
      "SELECT id, workspace_id, parent_id, child_index, status, workflow_ref, workflow_name, name, phase_index, round_index, task_id, started_at, completed_at, var_pool, created_at FROM executions WHERE task_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(taskId) as TaskExecutionRow[]
  } finally {
    db.close()
  }
}

/** The task's ROOT instances only (one v4 phase round / one composite turn per row),
 *  newest first — the same predicate + order the `execution` badge and 「执行历史」 use, so
 *  "exactly one live root" is checkable against what the API calls the current instance. */
export function readTaskRootExecutions(taskId: string): TaskExecutionRow[] {
  return readTaskExecutions(taskId)
    .filter((r) => r.parent_id === "0")
    .reverse()
}

/** How many rows the `schedules` table holds for an org. After 票03 the ONLY rows in
 *  this table are the scheduler's own cron/agent/built-in job definitions — a task must
 *  never add one (contract §新行为1: 入队后 schedules 零条任务行). Callers snapshot the
 *  count before an operation and assert the delta is 0, so an unrelated real job in the
 *  same org cannot turn the assertion red. */
export function countSchedulesInOrg(org: string): number {
  const db = openTaskDb()
  if (!db) return -1
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM schedules WHERE org = ?").get(org) as
      | { c: number }
      | undefined
    return row?.c ?? 0
  } finally {
    db.close()
  }
}

/** Total rows in `schedules` (org-agnostic) — the "no job row was created by 定时触发"
 *  check (票03: a task's cron lives in tasks.cron_expression, not in a schedule row). */
export function countAllSchedules(): number {
  const db = openTaskDb()
  if (!db) return -1
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM schedules").get() as
      | { c: number }
      | undefined
    return row?.c ?? 0
  } finally {
    db.close()
  }
}

/**
 * Rows in `schedules` that carry a task's id anywhere — as their own id, or inside
 * `config` / `name` / `workflow_ref`. Non-empty means the v39 envelope came back: the
 * whole point of 票03 is that nothing about a task lives in the scheduler's table.
 */
export function findTaskEnvelopeScheduleRows(taskId: string): Array<{ id: string; name: string; status: string }> {
  const db = openTaskDb()
  if (!db) return []
  const like = `%${taskId}%`
  try {
    return db.prepare(
      "SELECT id, name, status FROM schedules WHERE id = ? OR config LIKE ? OR name LIKE ? OR workflow_ref LIKE ?",
    ).all(taskId, like, like, like) as Array<{ id: string; name: string; status: string }>
  } finally {
    db.close()
  }
}


/** Read sessions.scope_id for a chat session (SG3: scope_id retargets to tasks.id). */
export function readSessionScopeId(sessionId: string): string | null {
  const db = openTaskDb()
  if (!db) return null
  try {
    const row = db.prepare("SELECT scope_id FROM sessions WHERE id = ?").get(sessionId) as
      | { scope_id: string | null }
      | undefined
    return row?.scope_id ?? null
  } finally {
    db.close()
  }
}

/** The trigger vocabulary the read model accepts (shared's TriggerModeSchema). Anything
 *  else in the column is dirty data, and 票05 fail-closes it to 'manual' on the wire. */
const TRIGGER_MODES: readonly TriggerMode[] = ["manual", "once", "cron"]

/**
 * Cross-validate an API response against the DB row (R3/R4). When the DB is
 * available, asserts the API-returned status/version/name AND the whole WHEN-half —
 * `trigger_mode` / `trigger_at` / `cron_expression` / `cron_timezone` / `trigger_enabled`
 * / `next_fire_at` / `last_fired_at` — match the SQL row. Those seven columns are the
 * task's own trigger state (票03 moved it off the deleted envelope row), so this is the
 * only place the pair can be compared: the old version had nothing to check beyond the
 * status mirror. When the DB is unavailable this is a no-op (the API assertion in the
 * test body already carries the signal). Returns true when the DB check ran + passed.
 */
export function assertTaskMatchesDb(
  apiTask: TaskDTO,
  opts?: { status?: string; version?: number; name?: string },
): boolean {
  const dbRow = readTaskRow(apiTask.id)
  if (!dbRow) {
    log(`DB cross-check skipped (DB unavailable: ${lastDbError() ?? "row not found"})`)
    return false
  }
  const expectStatus = opts?.status ?? apiTask.status
  const expectVersion = opts?.version ?? apiTask.version
  const expectName = opts?.name ?? apiTask.name
  if (dbRow.status !== expectStatus) {
    throw new Error(
      `DB status mismatch: API=${apiTask.status} expected=${expectStatus} DB=${dbRow.status} (task ${apiTask.id})`,
    )
  }
  if (dbRow.version !== expectVersion) {
    throw new Error(
      `DB version mismatch: API=${apiTask.version} expected=${expectVersion} DB=${dbRow.version} (task ${apiTask.id})`,
    )
  }
  if (dbRow.name !== expectName) {
    throw new Error(
      `DB name mismatch: API=${apiTask.name} expected=${expectName} DB=${dbRow.name} (task ${apiTask.id})`,
    )
  }
  // ── the WHEN half (票03: trigger state is the task's own data) ──
  // A stored value outside the enum is impossible via the API; a hand-edited row falls
  // back to 'manual' on the wire (fail-closed: an unreadable trigger never fires a round).
  const expectMode = TRIGGER_MODES.includes(apiTask.trigger_mode) ? apiTask.trigger_mode : "manual"
  if (dbRow.trigger_mode !== expectMode) {
    throw new Error(
      `DB trigger_mode mismatch: API=${apiTask.trigger_mode} expected=${expectMode} DB=${dbRow.trigger_mode} (task ${apiTask.id})`,
    )
  }
  for (const col of ["trigger_at", "cron_expression", "cron_timezone", "next_fire_at", "last_fired_at"] as const) {
    if (apiTask[col] !== dbRow[col]) {
      throw new Error(
        `DB ${col} mismatch: API=${String(apiTask[col])} DB=${String(dbRow[col])} (task ${apiTask.id})`,
      )
    }
  }
  // SQLite stores the switch as an integer; the DTO exposes a boolean (票05 §新事实1).
  if (apiTask.trigger_enabled !== (dbRow.trigger_enabled === 1)) {
    throw new Error(
      `DB trigger_enabled mismatch: API=${apiTask.trigger_enabled} DB=${dbRow.trigger_enabled} (task ${apiTask.id})`,
    )
  }
  return true
}


// ── API helpers (R3: API-side of API↔DB cross-check) ───────────────────

/**
 * The wire shape of a task — shared's `Task`, with the spec blob left opaque. Every other
 * column is shared's, so `trigger_*` / `execution` cannot drift from the server again
 * (that drift is what 票05's 「已彻底删除的 shared 符号」 list exists to catch);
 * `task_spec` stays `unknown` because each spec reads back the fixture it wrote (v4 phase
 * lists, composite subunit arrays) and a typed union there turns every assertion into a
 * cast fight.
 */
export interface TaskDTO extends Omit<Task, "task_spec"> {
  task_spec: unknown
}

/**
 * GET /api/tasks/:id — the task + its run history. `children[]` (the envelope rows that
 * used to stand for the same runs) is gone: `executions[]` lists the ROOT runs, newest
 * first, each carrying its composite arms under `children`; `execution` is the badge of
 * the newest root — the one row the board shows.
 */
export interface TaskDetailDTO extends TaskDTO {
  executions: TaskExecutionBadge[]
  /** deriveTaskView's output, embedded verbatim (server-owned; the specs cast it). */
  derived?: unknown
}


interface CloneSession {
  id: string
  org: string
  title: string
  clone_name: string
  scope_id: string | null
  provider_session_id: string | null
}

async function apiContext(): Promise<APIRequestContext> {
  return request.newContext()
}

/** POST /api/tasks — create a draft task. */
export async function createTask(
  input: {
    org?: string
    name?: string
    source_chat_session_id?: string | null
    // v3 (ticket 09): two-phase-flow fields. Absent → legacy v2 create.
    task_type?: "coding" | "generic"
    skill_groups?: string[]
    preset?: { org?: string; projects?: string[] }
    // 契约修复 (v4 直建): server now honors these on POST.
    task_spec?: Record<string, unknown>
    project_ids?: string[]
  },
): Promise<TaskDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks`, {
      data: {
        org: input.org ?? TASK_E2E_ORG,
        name: input.name,
        source_chat_session_id: input.source_chat_session_id ?? undefined,
        ...(input.task_type ? { task_type: input.task_type } : {}),
        ...(input.skill_groups ? { skill_groups: input.skill_groups } : {}),
        ...(input.preset ? { preset: input.preset } : {}),
        ...(input.task_spec ? { task_spec: input.task_spec } : {}),
        ...(input.project_ids ? { project_ids: input.project_ids } : {}),
      },
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const body = await res.text()
      throw new Error(`createTask failed (${res.status()}): ${body}`)
    }
    return (await res.json()) as TaskDTO
  } finally {
    await ctx.dispose()
  }
}

/** GET /api/tasks — list (kanban), filtered by status and/or org. */
export async function listTasks(params?: { status?: string; org?: string }): Promise<{ items: TaskDTO[] }> {
  const ctx = await apiContext()
  try {
    const qs = new URLSearchParams()
    if (params?.status) qs.set("status", params.status)
    // Org is opt-in: only filter when explicitly provided. The v3 two-phase
    // E2E (task-authoring-v3.spec.ts) creates tasks via the UI, which selects a
    // REAL registered org — forcing TASK_E2E_ORG here would hide those tasks.
    if (params?.org) qs.set("org", params.org)
    const res = await ctx.get(`${SERVER_URL}/api/tasks?${qs.toString()}`)
    if (!res.ok()) {
      const body = await res.text()
      throw new Error(`listTasks failed (${res.status()}): ${body}`)
    }
    return (await res.json()) as { items: TaskDTO[] }
  } finally {
    await ctx.dispose()
  }
}

/** GET /api/tasks/:id — detail (task + `executions[]` run history + `execution` badge). */
export async function getTask(taskId: string): Promise<TaskDetailDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/tasks/${taskId}`)
    if (!res.ok()) {
      const body = await res.text()
      throw new Error(`getTask failed (${res.status()}): ${body}`)
    }
    return (await res.json()) as TaskDetailDTO
  } finally {
    await ctx.dispose()
  }
}

/** PUT /api/tasks/:id — save draft with If-Match optimistic locking. */
export async function updateTask(
  taskId: string,
  expectedVersion: number,
  body: Record<string, unknown>,
): Promise<TaskDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.put(`${SERVER_URL}/api/tasks/${taskId}`, {
      data: body,
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
    })
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`updateTask failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as TaskDTO
  } finally {
    await ctx.dispose()
  }
}

/** PUT /api/tasks/:id — raw {status, body} variant for asserting the SW-BP9
 *  lock 409 (skill_groups/task_type change rejected) WITHOUT throwing. The
 *  non-raw {@link updateTask} throws on non-2xx, so it can't surface the 409
 *  body for the AC2 lock-regression assertion. */
export async function updateTaskRaw(
  taskId: string,
  expectedVersion: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { error?: string } & Record<string, unknown> }> {
  const ctx = await apiContext()
  try {
    const res = await ctx.put(`${SERVER_URL}/api/tasks/${taskId}`, {
      data: body,
      headers: { "Content-Type": "application/json", "If-Match": String(expectedVersion) },
    })
    const bodyJson = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>
    return { status: res.status(), body: bodyJson }
  } finally {
    await ctx.dispose()
  }
}

/** POST /api/tasks/:id/spec-field — agent update_task_spec_field tool.
 *  v3 (ticket 09): `source` routes user-direct-edits through the
 *  @@spec_updated notice path (D7). Default omitted → "agent" (no notice). */
export async function updateSpecField(
  taskId: string,
  field: string,
  value: unknown,
  opts?: { source?: "user" | "agent" },
): Promise<{ version: number }> {
  const ctx = await apiContext()
  try {
    const body: Record<string, unknown> = { field, value }
    if (opts?.source) body.source = opts.source
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/spec-field`, {
      data: body,
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`updateSpecField failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as { version: number }
  } finally {
    await ctx.dispose()
  }
}

/** GET /api/skill-groups — list skill groups for the template page (D3). */
export async function listSkillGroupsViaApi(): Promise<{
  groups: Array<{ group: string; displayName: string; skills: Array<{ name: string; description?: string }> }>
}> {
  const ctx = await apiContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/skill-groups`)
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`listSkillGroups failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as {
      groups: Array<{ group: string; displayName: string; skills: Array<{ name: string; description?: string }> }>
    }
  } finally {
    await ctx.dispose()
  }
}

/** POST /api/tasks/:id/ready — returns the raw {status, body} so the caller
 *  can assert the D18 gate's 409 + missing[] (AC6). Unlike {@link readyTask},
 *  this never throws on 409 — it surfaces the body. */
export async function readyTaskRaw(taskId: string): Promise<{
  status: number
  body: { error?: string; missing?: string[] } & Record<string, unknown>
}> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/ready`, {
      headers: { "Content-Type": "application/json" },
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string; missing?: string[] } & Record<string, unknown>
    return { status: res.status(), body }
  } finally {
    await ctx.dispose()
  }
}

/** Read the task home directory contents (~/.octopus/tasks/{id}/) — R3/R5:
 *  cross-validate that the v3 create path materialized the home + skills/
 *  subdir. Returns null when the dir is absent (v2/legacy task or not yet
 *  materialized). */
export function readTaskHomeDir(taskId: string): string[] | null {
  const home = path.join(os.homedir(), ".octopus", "tasks", taskId)
  if (!fs.existsSync(home)) return null
  try {
    return fs.readdirSync(home)
  } catch {
    return null
  }
}

/** Resolve the task home directory path (~/.octopus/tasks/{id}/) — the on-disk
 *  convention (ADR-0011). Returns null when the home is absent. */
export function taskHomePath(taskId: string): string | null {
  const home = path.join(os.homedir(), ".octopus", "tasks", taskId)
  return fs.existsSync(home) ? home : null
}

/** The task's artifacts/ directory (~/.octopus/tasks/{id}/artifacts/). Created
 *  on demand so E2E fixtures can write into it even before any artifact exists. */
export function taskArtifactsDir(taskId: string): string {
  const dir = path.join(os.homedir(), ".octopus", "tasks", taskId, "artifacts")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export interface ArtifactIndexEntryShape {
  path: string
  by: string
  title: string
  external: boolean
  updated_at: string
}

/** Write artifacts.json (the artifact index, ADR-0011) directly to disk. Used
 *  by the viewer E2E to pre-place an index before opening the dialog. Each entry
 *  is validated by the server on read (invalid rows dropped + warned), so the
 *  fixture must carry all schema-required fields. */
export function writeTaskArtifactIndex(taskId: string, entries: ArtifactIndexEntryShape[]): void {
  const dir = taskArtifactsDir(taskId)
  fs.writeFileSync(path.join(dir, "artifacts.json"), JSON.stringify(entries, null, 2), "utf-8")
}

/** Write a file into the task's artifacts/ dir (relative path). Used by the
 *  viewer E2E to pre-place the on-disk content the GET content route reads. */
export function writeTaskArtifactFile(taskId: string, relativePath: string, content: string): void {
  const dir = taskArtifactsDir(taskId)
  const full = path.join(dir, relativePath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, "utf-8")
}

/** GET /api/tasks/:id/artifacts — the artifact index. Missing file → [];
 *  corrupted → [] + server warn (SW-BP12). */
export async function listArtifactsViaApi(taskId: string): Promise<ArtifactIndexEntryShape[]> {
  const ctx = await apiContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/tasks/${taskId}/artifacts`)
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`listArtifacts failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as ArtifactIndexEntryShape[]
  } finally {
    await ctx.dispose()
  }
}

/** GET /api/tasks/:id/artifacts/content?path= — returns the raw {status, body}
 *  so the caller can assert 403 (escape/unregistered) + 404 (missing on disk)
 *  degraded states (AC2) without throwing. */
export async function getArtifactContentRaw(
  taskId: string,
  artifactPath: string,
): Promise<{ status: number; body: { path?: string; content?: string; error?: string } & Record<string, unknown> }> {
  const ctx = await apiContext()
  try {
    const qs = new URLSearchParams({ path: artifactPath })
    const res = await ctx.get(`${SERVER_URL}/api/tasks/${taskId}/artifacts/content?${qs.toString()}`)
    const body = (await res.json().catch(() => ({}))) as { path?: string; content?: string; error?: string } & Record<string, unknown>
    return { status: res.status(), body }
  } finally {
    await ctx.dispose()
  }
}

/** POST /api/tasks/:id/assist-workflows — trigger a built-in assist-workflow
 *  run. Returns the raw {status, body} so the caller can assert 400 on a bad
 *  template (AC3) without throwing. */
export async function triggerAssistWorkflowRaw(
  taskId: string,
  template: string,
  input?: { goal?: string; ac?: string[]; projects?: string[] },
): Promise<{
  status: number
  body: { run_id?: string; execution_id?: string; workspace_id?: string; template?: string; error?: string } & Record<string, unknown>
}> {
  const ctx = await apiContext()
  try {
    const data: Record<string, unknown> = { template }
    if (input) data.input = input
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/assist-workflows`, {
      data,
      headers: { "Content-Type": "application/json" },
    })
    const body = (await res.json().catch(() => ({}))) as { run_id?: string; execution_id?: string; workspace_id?: string; template?: string; error?: string } & Record<string, unknown>
    return { status: res.status(), body }
  } finally {
    await ctx.dispose()
  }
}

export interface AssistWorkflowRunShape {
  run_id: string
  execution_id: string
  workspace_id: string
  template: string
  status: string
  logs: Array<{ t: string; icon: string; text: string }>
  output?: { ac_candidates: string[]; suggestions: string[]; risks: string[] }
  output_raw?: string
  output_parse_error?: boolean
}

/** GET /api/tasks/:id/assist-workflows/:runId — run status + logs + structured
 *  output (parse failure → output_raw + output_parse_error on the 200 response). */
export async function getAssistWorkflowRunViaApi(taskId: string, runId: string): Promise<AssistWorkflowRunShape> {
  const ctx = await apiContext()
  try {
    const res = await ctx.get(`${SERVER_URL}/api/tasks/${taskId}/assist-workflows/${runId}`)
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`getAssistWorkflowRun failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as AssistWorkflowRunShape
  } finally {
    await ctx.dispose()
  }
}

/** Seed an assist run's aggregator output directly into the DB (mirrors the
 *  server assist test's `insertExecutionWithOutput`). The real MoA workflow
 *  needs an LLM provider; in dev it stays "running" indefinitely. Seeding the
 *  swarm node's `outputs.synthesis` lets the GET /assist-workflows/:runId route
 *  (the real server, R1) parse + return structured output — so the UI is
 *  exercised through the real API without a working provider.
 *
 *  - `synthesis` = a JSON string → run.output = {ac_candidates, suggestions, risks}
 *  - `synthesis` = malformed text → run.output_raw + run.output_parse_error (AC6)
 *  Also sets the execution status to `completed` (default) so the run shows a
 *  terminal badge + stops the viewer's poll. */
export function seedAssistRunOutput(
  runId: string,
  synthesis: string,
  opts?: { status?: string },
): void {
  const dbPath = resolveDbPath()
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB file not found at ${dbPath} — cannot seed assist run output`)
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => NodeSqliteDb
  }
  const db = new DatabaseSync(dbPath)
  try {
    const now = new Date().toISOString()
    const status = opts?.status ?? "completed"
    db.prepare("UPDATE executions SET status = ?, updated_at = ? WHERE id = ?").run(status, now, runId)
    // Remove any prior partial panel row for this execution (real engine's).
    db.prepare("DELETE FROM node_executions WHERE execution_id = ? AND node_id = 'panel'").run(runId)
    const neId = `${runId}-panel-e2e`
    db.prepare(`
      INSERT INTO node_executions (id, execution_id, node_id, node_type, status,
        started_at, completed_at, duration, exit_code, error, vars_snapshot, outputs,
        session_id, parent_node_id, iteration_index)
      VALUES (?, ?, 'panel', 'swarm', 'completed', ?, ?, 10, 0, NULL, NULL, ?, NULL, NULL, NULL)
    `).run(neId, runId, now, now, JSON.stringify({ synthesis }))
  } finally {
    db.close()
  }
}

/** POST /api/tasks/:id/ready — 入队: the confirmation gate + `status: draft→ready`, and
 *  NOTHING else (票03 §新行为1). It creates no `schedules` row and arms no instance —
 *  under the v39 envelope this call pre-created a parked private schedule, which is the
 *  coupling ADR-0021 removed. A run starts from an explicit 触发 (or, for a task carrying
 *  a due cursor, from the built-in task-lifecycle job). */
export async function readyTask(taskId: string): Promise<TaskDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/ready`, {
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`readyTask failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as TaskDTO
  } finally {
    await ctx.dispose()
  }
}

/**
 * POST /api/tasks/:id/trigger — 触发 one round (票03 §新行为2).
 *   - `at` absent / in the past → the job arms an `executions(task_id, pending)` root and
 *     claims it inside the shared concurrency gate; the task goes 'running'.
 *   - `at` in the future → one-shot arming only: `trigger_mode='once'` + `next_fire_at=at`,
 *     status stays 'ready', and NO instance exists until the built-in job fires.
 *   - a live instance already exists → 409 「已有进行中的实例」 (the same-task mutex is the
 *     `ux_exec_task_active` partial unique index over the roots, not a code convention).
 */
export async function triggerTask(taskId: string, at?: string): Promise<TaskDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/trigger`, {
      data: at ? { at } : {},
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`triggerTask failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as TaskDTO
  } finally {
    await ctx.dispose()
  }
}

/** The raw {status, body} variant, for asserting the 409s (in-flight mutex / not-ready)
 *  without {@link triggerTask} throwing on them. */
export async function triggerTaskRaw(
  taskId: string,
  at?: string,
): Promise<{ status: number; body: { error?: string; reason?: string } & Record<string, unknown> }> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/trigger`, {
      data: at ? { at } : {},
      headers: { "Content-Type": "application/json" },
    })
    const body = (await res.json().catch(() => ({}))) as
      { error?: string; reason?: string } & Record<string, unknown>
    return { status: res.status(), body }
  } finally {
    await ctx.dispose()
  }
}

/** POST /api/tasks/:id/trigger/schedule — 周期触发 (票03 §新行为2/8). Body
 *  `{cron, timezone?}` arms the task's OWN cron trigger: `tasks.trigger_mode='cron'` +
 *  `cron_expression` + a computed `next_fire_at`. No `schedules` row and no scheduler job
 *  is created — the built-in task-lifecycle job scans the cursor. */
export async function scheduleTaskTrigger(
  taskId: string,
  cron: string,
  timezone?: string,
): Promise<TaskDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/trigger/schedule`, {
      data: { cron, ...(timezone ? { timezone } : {}) },
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`scheduleTaskTrigger failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as TaskDTO
  } finally {
    await ctx.dispose()
  }
}

/** POST /api/tasks/:id/abort — stops the task's own instance(s) and sets
 *  `tasks.status='aborted'` (票03 §新行为4): a live row is engine-cancelled, an armed
 *  'pending' row is retired, both land on `executions.status='aborted'`. It never touches
 *  `schedules` (there is nothing there to clean), and the bound workspace survives (K12). */
export async function abortTask(taskId: string): Promise<TaskDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/abort`, {
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`abortTask failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as TaskDTO
  } finally {
    await ctx.dispose()
  }
}

/** DELETE /api/tasks/:id — soft-delete, NO cascade (票03 §新行为5): there is no envelope
 *  row to reap; the task's runs are `executions` rows and stay as history. */
export async function deleteTask(taskId: string): Promise<{ ok: true }> {
  const ctx = await apiContext()
  try {
    const res = await ctx.delete(`${SERVER_URL}/api/tasks/${taskId}`)
    if (!res.ok() && res.status() !== 404) {
      const text = await res.text()
      throw new Error(`deleteTask failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as { ok: true }
  } finally {
    await ctx.dispose()
  }
}

/** GET /api/tasks/:id/executions — the run history the 「执行历史」 panel reads: roots
 *  newest first, each badge carrying `current` (the row the board shows as `execution`)
 *  and its composite `children`. Replaced the envelope's children[]. */
export async function listTaskExecutions(
  taskId: string,
  limit?: number,
): Promise<{ items: Array<TaskExecutionBadge & { current: boolean }>; total: number }> {
  const ctx = await apiContext()
  try {
    const qs = limit ? `?limit=${limit}` : ""
    const res = await ctx.get(`${SERVER_URL}/api/tasks/${taskId}/executions${qs}`)
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`listTaskExecutions failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as { items: Array<TaskExecutionBadge & { current: boolean }>; total: number }
  } finally {
    await ctx.dispose()
  }
}


/** POST /api/clones/task-author/sessions — create a task-author chat session. */
export async function createTaskAuthorSession(opts?: {
  title?: string
  scope_id?: string
  org?: string
}): Promise<CloneSession> {
  const ctx = await apiContext()
  try {
    const body: Record<string, unknown> = {}
    if (opts?.title) body.title = opts.title
    if (opts?.scope_id) body.scope_id = opts.scope_id
    const res = await ctx.post(`${SERVER_URL}/api/clones/task-author/sessions`, {
      data: body,
      headers: {
        "Content-Type": "application/json",
        "X-Octopus-Org": opts?.org ?? TASK_E2E_ORG,
      },
    })
    if (!res.ok()) {
      const text = await res.text()
      throw new Error(`createTaskAuthorSession failed (${res.status()}): ${text}`)
    }
    return (await res.json()) as CloneSession
  } finally {
    await ctx.dispose()
  }
}

export interface CloneChatSseEvents {
  done: Array<{ session_id: string; message_id: string; session_title?: string }>
  error: Array<{ code: string; message: string }>
  tool_call: Array<{ type: string; tool_name?: string; tool_call_id?: string; content?: string; input?: unknown; is_error?: boolean }>
  status: Array<{ status: string }>
  [key: string]: unknown[]
}

/**
 * POST /api/clones/task-author/sessions/:id/chat — send a message + collect the
 * SSE stream. The turn-end autosave seam fires inside this route (04). Returns
 * every parsed SSE event grouped by event name. Times out after timeoutMs.
 *
 * NOTE (R1): this hits the REAL task-author clone + provider. In dev the
 * provider may be absent/misconfigured — the autosave seam still fires at
 * turn-end even if the provider errors, because it's gated on cloneName, not
 * on stream success. Callers should treat provider errors as non-fatal for
 * autosave/spec-field assertions and assert the DB row was created.
 */
export async function sendTaskAuthorChat(
  sessionId: string,
  message: string,
  opts?: { org?: string; timeoutMs?: number },
): Promise<CloneChatSseEvents> {
  const ctx = await apiContext()
  const events: CloneChatSseEvents = {
    done: [],
    error: [],
    tool_call: [],
    status: [],
  }
  try {
    const res = await ctx.post(`${SERVER_URL}/api/clones/task-author/sessions/${sessionId}/chat`, {
      data: { message },
      headers: {
        "Content-Type": "application/json",
        "X-Octopus-Org": opts?.org ?? TASK_E2E_ORG,
        Accept: "text/event-stream",
      },
      timeout: opts?.timeoutMs ?? 90_000,
    })
    // SSE stream — read the body as text + parse event-by-event.
    const text = await res.text()
    const blocks = text.split(/\n\n/).filter((b) => b.trim().length > 0)
    for (const block of blocks) {
      const lines = block.split(/\n/)
      let eventName = "message"
      let dataStr = ""
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim()
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim()
      }
      let parsed: unknown = dataStr
      try {
        parsed = JSON.parse(dataStr)
      } catch {
        // keep as string
      }
      if (!events[eventName]) events[eventName] = []
      ;(events[eventName] as unknown[]).push(parsed)
    }
    return events
  } finally {
    await ctx.dispose()
  }
}

// ── SSE collector for /api/tasks/events ─────────────────────────────────

/** task_status payload — `{task_id, status}` only (票05): under the envelope this event
 *  was the scheduler mirroring `schedules.status`, so the payload carried `schedule_id` +
 *  `origin_type` to say which world it came from. There is one writer now (the task
 *  routes / the built-in lifecycle job), so a task_status event is about a task. */
export type TaskStatusEvent = { task_id: string; status: string }
/** task_execution payload (票03 introduced the event, 票05 put it on the wire): one
 *  instance transition the job performed — armed ('pending', queued behind the gate),
 *  launched ('running'), finalized, reaped. This is the event that makes 「排队中」 and
 *  「执行中」 two different observations instead of one mirrored status. */
export type TaskExecutionEvent = TaskExecutionSsePayload
/** task_trigger payload — the task's own due cursor moved (`scheduled` / `unscheduled` /
 *  `cancelled` / `paused` / `resumed`). `next_fire_at` replaced the envelope's
 *  `scheduled_at`. An immediate 触发 sends nothing here; it arms a row, which is
 *  task_execution's job. */
export type TaskTriggerEvent = TaskTriggerSsePayload
/** task_trigger_failed payload (票05): a fire the pump could not arm — the refusal's own
 *  one-liner + the trigger_mode it happened under. The 「周期不被一次失败钉死」 half of the
 *  contract: the cursor still advances, and the reason reaches the board here. */
export type TaskTriggerFailedEvent = TaskTriggerFailedSsePayload
export interface SpecFieldUpdateEvent {
  task_id: string
  field: string
  value: unknown
  version: number
}
export interface AssistRunUpdateEvent {
  task_id: string
  run_id: string
  phase: string
}
/** D19: companion event emitted on every spec-field update (same taskpool
 *  stream) so the OutputViewer re-fetches the artifact index without polling.
 *  Shape: { task_id } (no field/version — it's a "go re-fetch" signal). */
export interface TaskArtifactsUpdateEvent {
  task_id: string
}

/** A live SSE subscriber for /api/tasks/events. Uses Node's fetch streaming
 *  (the events endpoint is an infinite stream — page.request would block).
 *  Call stop() to close the connection; collected events are in the arrays. */
export interface SseSubscriber {
  taskStatusEvents: TaskStatusEvent[]
  taskExecutionEvents: TaskExecutionEvent[]
  taskTriggerEvents: TaskTriggerEvent[]
  taskTriggerFailedEvents: TaskTriggerFailedEvent[]
  specFieldEvents: SpecFieldUpdateEvent[]
  assistRunEvents: AssistRunUpdateEvent[]
  taskArtifactsEvents: TaskArtifactsUpdateEvent[]
  heartbeat: number
  stop: () => void
}

/**
 * Subscribe to /api/tasks/events on the server and collect task_status +
 * task_execution + task_trigger(+failed) + spec_field_update + assist_run_update events
 * into the returned arrays. The subscriber stays alive until stop() is called. Uses Node
 * fetch streaming (the events endpoint is an infinite loop with 30s heartbeats).
 *
 * This verifies the SERVER emits the SSE (R3: server-side of the SSE path).
 * The UI-side assertion (SpecPanel / OutputViewer reflects the field) is done
 * in the test body by checking the DOM element.
 */
export async function startSseSubscriber(): Promise<SseSubscriber> {
  const taskStatusEvents: TaskStatusEvent[] = []
  const taskExecutionEvents: TaskExecutionEvent[] = []
  const taskTriggerEvents: TaskTriggerEvent[] = []
  const taskTriggerFailedEvents: TaskTriggerFailedEvent[] = []
  const specFieldEvents: SpecFieldUpdateEvent[] = []
  const assistRunEvents: AssistRunUpdateEvent[] = []
  const taskArtifactsEvents: TaskArtifactsUpdateEvent[] = []
  let heartbeat = 0

  const controller = new AbortController()

  const res = await fetch(`${SERVER_URL}/api/tasks/events`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`SSE subscribe failed: ${res.status} ${res.statusText}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  // Read loop runs in the background; collects into the arrays above.
  const readLoop = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() ?? ""
        for (const block of blocks) {
          if (!block.trim()) continue
          let eventName = "message"
          let dataStr = ""
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim()
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim()
          }
          let parsed: unknown = dataStr
          try {
            parsed = JSON.parse(dataStr)
          } catch {
            // keep as string
          }
          if (eventName === "task_status") {
            taskStatusEvents.push(parsed as TaskStatusEvent)
          } else if (eventName === "task_execution") {
            taskExecutionEvents.push(parsed as TaskExecutionEvent)
          } else if (eventName === "task_trigger") {
            taskTriggerEvents.push(parsed as TaskTriggerEvent)
          } else if (eventName === "task_trigger_failed") {
            // The pump could not arm this task's fire (gate / workspace / in-flight). Same
            // stream, same 「go re-fetch」 effect as task_trigger.
            taskTriggerFailedEvents.push(parsed as TaskTriggerFailedEvent)
          } else if (eventName === "spec_field_update") {

            specFieldEvents.push(parsed as SpecFieldUpdateEvent)
          } else if (eventName === "assist_run_update") {
            assistRunEvents.push(parsed as AssistRunUpdateEvent)
          } else if (eventName === "task_artifacts_update") {
            // D19 (SW-BP8): companion "go re-fetch artifacts" signal emitted
            // alongside every spec_field_update on the same taskpool stream.
            taskArtifactsEvents.push(parsed as TaskArtifactsUpdateEvent)
          } else if (eventName === "heartbeat") {
            heartbeat++
          }
        }
      }
    } catch (err: unknown) {
      // AbortError is expected on stop(); swallow others (non-fatal — the
      // test asserts on whatever was collected before the error).
      if (!(err instanceof Error && err.name === "AbortError")) {
        logError(`SSE read loop error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })()

  return {
    taskStatusEvents,
    taskExecutionEvents,
    taskTriggerEvents,
    taskTriggerFailedEvents,
    specFieldEvents,
    assistRunEvents,
    taskArtifactsEvents,
    heartbeat,
    stop: () => {
      controller.abort()
      reader.cancel().catch(() => {})
      // readLoop resolves on abort; no need to await.
    },
  }
}

// ── Wait helper ─────────────────────────────────────────────────────────

/** Poll a predicate until it returns a non-null value or timeoutMs elapses. A predicate
 *  that has not reached its condition yet returns null/undefined — that is the polling
 *  protocol every spec here uses, so it is part of the signature rather than something
 *  each caller has to fight the generic about. */
export async function waitFor<T>(
  predicate: () => T | null | undefined | Promise<T | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const intervalMs = opts.intervalMs ?? 500
  const start = Date.now()
  let lastErr: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (err: unknown) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  const msg = opts.message ?? `waitFor timed out after ${timeoutMs}ms`
  if (lastErr !== undefined) {
    throw new Error(`${msg}: last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
  }
  throw new Error(msg)
}

/** Poll until this task has no root execution in a live status (pending/running/…), i.e.
 *  its slot in `ux_exec_task_active` is free again. Returns the terminal rows. */
export async function waitForNoLiveTaskRoot(
  taskId: string,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<TaskExecutionRow[]> {
  const rows = await waitFor(
    () => {
      const all = readTaskExecutions(taskId)
      const live = all.filter((r) => r.parent_id === "0" && !isTerminalExecutionStatus(r.status))
      return live.length === 0 ? all : null
    },
    {
      timeoutMs: opts.timeoutMs ?? 60_000,
      intervalMs: opts.intervalMs ?? 1000,
      message: opts.message ?? `task ${taskId} still holds a live root execution`,
    },
  )
  return rows as TaskExecutionRow[]
}

/** Wait until a task reaches one of the target statuses (via API poll). */
export async function waitForTaskStatus(
  taskId: string,
  target: string | string[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TaskDetailDTO> {
  const targets = Array.isArray(target) ? target : [target]
  const result = await waitFor(
    async () => {
      const task = await getTask(taskId)
      return targets.includes(task.status) ? task : null
    },
    { timeoutMs: opts.timeoutMs ?? 30_000, intervalMs: opts.intervalMs ?? 1000, message: `task ${taskId} did not reach ${targets.join("|")}` },
  )
  // waitFor throws on timeout; if it returns, the predicate was truthy.
  return result as TaskDetailDTO
}
