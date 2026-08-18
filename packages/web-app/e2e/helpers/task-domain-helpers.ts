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
//   - SSE collector for /api/tasks/events (task_status + spec_field_update)
//   - Screenshot dir (E2E_ARTIFACTS_DIR, R-screenshot evidence)
//
// Data prefix E2E_TD_ (R7) — all task names/orgs carry this prefix so the
// phase-4 cleanup sweep can identify + reap leftover rows.

import { request, type APIRequestContext } from "@playwright/test"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

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
}

export interface ScheduleDbRow {
  id: string
  org: string
  name: string
  status: string
  origin_type: string
  origin_id: string | null
  origin_role: string | null
  config: string
  workflow_ref: string | null
  deleted_at: string | null
  created_at: string
}

/** Read a tasks row directly from SQLite (R3: DB-side of API↔DB cross-check). */
export function readTaskRow(taskId: string): TaskDbRow | null {
  const db = openTaskDb()
  if (!db) return null
  try {
    const row = db.prepare(
      "SELECT id, org, name, status, source_chat_session_id, task_spec, authoring_resources, resources, skills, project_ids, workflow_ref, version, deleted_at, created_at, updated_at, completed_at FROM tasks WHERE id = ?",
    ).get(taskId)
    return (row as TaskDbRow | undefined) ?? null
  } finally {
    db.close()
  }
}

/** Read all schedules linked to a task via S2 polymorphic origin (origin_type='task'). */
export function readSchedulesByOrigin(taskId: string): ScheduleDbRow[] {
  const db = openTaskDb()
  if (!db) return []
  try {
    return db.prepare(
      "SELECT id, org, name, status, origin_type, origin_id, origin_role, config, workflow_ref, deleted_at, created_at FROM schedules WHERE origin_type = 'task' AND origin_id = ? AND deleted_at IS NULL ORDER BY created_at ASC",
    ).all(taskId) as ScheduleDbRow[]
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

/**
 * Cross-validate an API response against the DB row (R3/R4). When the DB is
 * available, asserts the API-returned status/version/name match the SQL row.
 * When the DB is unavailable, this is a no-op (the API assertion in the test
 * body already carries the signal). Returns true when the DB check ran + passed.
 */
export function assertTaskMatchesDb(
  apiTask: { id: string; status: string; version: number; name: string },
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
  return true
}

// ── API helpers (R3: API-side of API↔DB cross-check) ───────────────────

export interface TaskDTO {
  id: string
  org: string
  name: string
  status: "draft" | "ready" | "running" | "done" | "failed" | "aborted"
  task_spec: unknown
  authoring_resources: Array<{ type: string; name: string }>
  resources: Array<{ type: string; name: string }>
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

export interface TaskDetailDTO extends TaskDTO {
  children: Array<{
    schedule_id: string
    name: string
    status: string
    origin_role: string | null
    workflow_ref: string | null
  }>
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

/** GET /api/tasks/:id — detail (task + children schedules). */
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

/** POST /api/tasks/:id/ready — enqueue: draft→ready + dispatch seam. */
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

/** POST /api/tasks/:id/abort — running→aborted + ws cleanup. */
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

/** DELETE /api/tasks/:id — soft-delete + cascade-reap schedules. */
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

export interface TaskStatusEvent {
  task_id: string
  status: string
  schedule_id?: string
  origin_type?: string
}
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

/** A live SSE subscriber for /api/tasks/events. Uses Node's fetch streaming
 *  (the events endpoint is an infinite stream — page.request would block).
 *  Call stop() to close the connection; collected events are in the arrays. */
export interface SseSubscriber {
  taskStatusEvents: TaskStatusEvent[]
  specFieldEvents: SpecFieldUpdateEvent[]
  assistRunEvents: AssistRunUpdateEvent[]
  heartbeat: number
  stop: () => void
}

/**
 * Subscribe to /api/tasks/events on the server and collect task_status +
 * spec_field_update + assist_run_update events into the returned arrays. The
 * subscriber stays alive until stop() is called. Uses Node fetch streaming (the
 * events endpoint is an infinite loop with 30s heartbeats).
 *
 * This verifies the SERVER emits the SSE (R3: server-side of the SSE path).
 * The UI-side assertion (SpecPanel / OutputViewer reflects the field) is done
 * in the test body by checking the DOM element.
 */
export async function startSseSubscriber(): Promise<SseSubscriber> {
  const taskStatusEvents: TaskStatusEvent[] = []
  const specFieldEvents: SpecFieldUpdateEvent[] = []
  const assistRunEvents: AssistRunUpdateEvent[] = []
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
          } else if (eventName === "spec_field_update") {
            specFieldEvents.push(parsed as SpecFieldUpdateEvent)
          } else if (eventName === "assist_run_update") {
            assistRunEvents.push(parsed as AssistRunUpdateEvent)
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
    specFieldEvents,
    assistRunEvents,
    heartbeat,
    stop: () => {
      controller.abort()
      reader.cancel().catch(() => {})
      // readLoop resolves on abort; no need to await.
    },
  }
}

// ── Wait helper ─────────────────────────────────────────────────────────

/** Poll a predicate until it returns truthy or timeoutMs elapses. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
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
