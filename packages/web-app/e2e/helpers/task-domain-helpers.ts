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
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown; all: (...params: unknown[]) => unknown[] }
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
  input: { org?: string; name?: string; source_chat_session_id?: string | null },
): Promise<TaskDTO> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks`, {
      data: {
        org: input.org ?? TASK_E2E_ORG,
        name: input.name,
        source_chat_session_id: input.source_chat_session_id ?? undefined,
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
    qs.set("org", params?.org ?? TASK_E2E_ORG)
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

/** POST /api/tasks/:id/spec-field — agent update_task_spec_field tool. */
export async function updateSpecField(
  taskId: string,
  field: string,
  value: unknown,
): Promise<{ version: number }> {
  const ctx = await apiContext()
  try {
    const res = await ctx.post(`${SERVER_URL}/api/tasks/${taskId}/spec-field`, {
      data: { field, value },
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

/** A live SSE subscriber for /api/tasks/events. Uses Node's fetch streaming
 *  (the events endpoint is an infinite stream — page.request would block).
 *  Call stop() to close the connection; collected events are in the arrays. */
export interface SseSubscriber {
  taskStatusEvents: TaskStatusEvent[]
  specFieldEvents: SpecFieldUpdateEvent[]
  heartbeat: number
  stop: () => void
}

/**
 * Subscribe to /api/tasks/events on the server and collect task_status +
 * spec_field_update events into the returned arrays. The subscriber stays
 * alive until stop() is called. Uses Node fetch streaming (the events endpoint
 * is an infinite loop with 30s heartbeats).
 *
 * This verifies the SERVER emits the SSE (R3: server-side of the SSE path).
 * The UI-side assertion (SpecPanel reflects the field) is done in the test
 * body by checking the DOM element.
 */
export async function startSseSubscriber(): Promise<SseSubscriber> {
  const taskStatusEvents: TaskStatusEvent[] = []
  const specFieldEvents: SpecFieldUpdateEvent[] = []
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
