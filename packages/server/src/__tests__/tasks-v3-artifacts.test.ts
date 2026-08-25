// packages/server/src/__tests__/tasks-v3-artifacts.test.ts
//
// Ticket 06 — 产物路由 (artifacts index + content whitelist read, US7).
// Integration test: real better-sqlite3 + applySchema + real TaskHomeService
// (temp home) + real Hono app.request (R1/R3/R4/R5).
//
// AC1: GET /api/tasks/:id/artifacts → ArtifactIndexEntry[]; no index → [];
//      corrupted JSON → [] + warn (SW-BP12); missing task → 404.
// AC2: GET content?path= whitelist — relative-inside-artifacts (normalized, no
//      `../` escape) OR external=true absolute path registered in index; else 403.
// AC3: returns { path, content }, content == fs.readFileSync (live disk content).
// AC4: registered external entry whose file is missing on disk → 404 + clear code.
//
// Anti-fake-run: real DB + applySchema (R1/R3), Hono app.request (R3 API↔DB↔fs),
// data prefix E2E_TD_ (R7), assert response body + readdir + readFileSync (R4/R5).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import type { ArtifactIndexEntry } from "@octopus/shared"

const ORG = "e2e-td-06"

// ── Helpers ─────────────────────────────────────────────────────────

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

function mkdtemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

/** Write an internal artifact: file inside artifacts/ + index entry. */
function writeInternalArtifact(
  taskHome: TaskHomeService,
  taskId: string,
  relPath: string,
  content: string,
  overrides: Partial<ArtifactIndexEntry> = {},
): void {
  const dir = taskHome.artifactsDir(taskId)
  fs.mkdirSync(path.join(dir, path.dirname(relPath)), { recursive: true })
  fs.writeFileSync(path.join(dir, relPath), content, "utf-8")
  taskHome.writeArtifactEntry(taskId, {
    path: relPath,
    by: "open-spec",
    title: overrides.title ?? relPath,
    external: false,
    updated_at: "2026-08-18T00:00:00.000Z",
    ...overrides,
  })
}

/** Write an external artifact: file at an arbitrary absolute location + index
 *  entry pointing at it (external=true, absolute path). Returns the abs path. */
function writeExternalArtifact(
  taskHome: TaskHomeService,
  taskId: string,
  basePath: string,
  name: string,
  content: string,
  overrides: Partial<ArtifactIndexEntry> = {},
): string {
  const absDir = path.join(basePath, "external-src")
  fs.mkdirSync(absDir, { recursive: true })
  const absPath = path.join(absDir, name)
  fs.writeFileSync(absPath, content, "utf-8")
  taskHome.writeArtifactEntry(taskId, {
    path: absPath,
    by: "third-party-skill",
    title: overrides.title ?? name,
    external: true,
    updated_at: "2026-08-18T00:00:00.000Z",
    ...overrides,
  })
  return absPath
}

/** Create a v3 task via the real POST route (no skill_groups → no materializer
 *  needed; home created by the service). Returns the task id. */
async function createV3Task(app: Hono, name: string): Promise<string> {
  const res = await app.request("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ org: ORG, task_type: "coding", name }),
  })
  expect(res.status).toBe(201)
  const body = await res.json() as { id: string }
  return body.id
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

// ── Suite ──────────────────────────────────────────────────────────

describe("06: artifacts routes — index + content whitelist (integration)", () => {
  let db: Database.Database
  let app: Hono
  let homeBase: string
  let taskHome: TaskHomeService
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeAll(() => {
    db = newDb()
    homeBase = mkdtemp("v3-artifacts-home-")
    taskHome = new TaskHomeService(homeBase)
    const sse = new SSEService()
    const service = new TasksService(db, sse, new AgentSessionDAO(db), taskHome)
    app = new Hono()
    app.route("/api/tasks", createTasksRoutes(service, sse))
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterAll(() => {
    warnSpy.mockRestore()
    db.close()
    cleanupDir(homeBase)
  })

  // ── AC1: GET /:id/artifacts index ───────────────────────────────────

  it("AC1a: GET /:id/artifacts returns ArtifactIndexEntry[] (1 internal + 1 external)", async () => {
    const taskId = await createV3Task(app, "E2E_TD artifacts index")
    writeInternalArtifact(taskHome, taskId, "spec.md", "# E2E_TD spec content")
    writeExternalArtifact(taskHome, taskId, homeBase, "persona.md", "# E2E_TD persona")

    const res = await app.request(`/api/tasks/${taskId}/artifacts`)
    expect(res.status).toBe(200)
    const entries = await json<ArtifactIndexEntry[]>(res)
    expect(entries).toHaveLength(2)
    const internal = entries.find((e) => !e.external)!
    expect(internal.path).toBe("spec.md")
    expect(internal.by).toBe("open-spec")
    const external = entries.find((e) => e.external)!
    expect(path.isAbsolute(external.path)).toBe(true)
    expect(external.path).toContain("persona.md")
  })

  it("AC1b: GET /:id/artifacts with no artifacts.json → [] (fresh task)", async () => {
    const taskId = await createV3Task(app, "E2E_TD no index yet")
    // Home exists (createV3Task creates it) but no artifacts.json written.
    expect(fs.existsSync(path.join(taskHome.artifactsDir(taskId), "artifacts.json"))).toBe(false)
    const res = await app.request(`/api/tasks/${taskId}/artifacts`)
    expect(res.status).toBe(200)
    expect(await json<unknown[]>(res)).toEqual([])
  })

  it("AC1c: GET /:id/artifacts with corrupted JSON → [] + warn (SW-BP12)", async () => {
    const taskId = await createV3Task(app, "E2E_TD corrupted index")
    warnSpy.mockClear()
    const file = path.join(taskHome.artifactsDir(taskId), "artifacts.json")
    fs.writeFileSync(file, "{invalid json", "utf-8")
    const res = await app.request(`/api/tasks/${taskId}/artifacts`)
    expect(res.status).toBe(200)
    expect(await json<unknown[]>(res)).toEqual([])
    expect(warnSpy).toHaveBeenCalled()
  })

  it("AC1d: GET /no-such-task/artifacts → 404 (task-exists check)", async () => {
    const res = await app.request("/api/tasks/no-such-task/artifacts")
    expect(res.status).toBe(404)
  })

  // ── AC2/AC3: GET /:id/artifacts/content — whitelist + live content ──

  it("AC2/AC3 internal: GET content?path=spec.md → { path, content } == disk content", async () => {
    const taskId = await createV3Task(app, "E2E_TD content internal")
    writeInternalArtifact(taskHome, taskId, "spec.md", "# E2E_TD live spec content")
    const res = await app.request(`/api/tasks/${taskId}/artifacts/content?path=spec.md`)
    expect(res.status).toBe(200)
    const body = await json<{ path: string; content: string }>(res)
    expect(body.path).toBe("spec.md")
    // R3: content == live disk content (fs.readFileSync cross-check).
    const disk = fs.readFileSync(path.join(taskHome.artifactsDir(taskId), "spec.md"), "utf-8")
    expect(body.content).toBe(disk)
    expect(body.content).toContain("E2E_TD live spec content")
  })

  it("AC2 internal nested subpath: GET content?path=docs/proposal.md → content", async () => {
    const taskId = await createV3Task(app, "E2E_TD content nested")
    writeInternalArtifact(taskHome, taskId, "docs/proposal.md", "# E2E_TD nested proposal")
    const res = await app.request(`/api/tasks/${taskId}/artifacts/content?path=docs/proposal.md`)
    expect(res.status).toBe(200)
    const body = await json<{ path: string; content: string }>(res)
    expect(body.content).toContain("E2E_TD nested proposal")
  })

  it("AC2 escape attempt: GET content?path=../persona.md → 403", async () => {
    const taskId = await createV3Task(app, "E2E_TD escape attempt")
    writeInternalArtifact(taskHome, taskId, "spec.md", "ok")
    // ../persona.md would resolve OUTSIDE artifacts/ (into the home root).
    const res = await app.request(`/api/tasks/${taskId}/artifacts/content?path=../persona.md`)
    expect(res.status).toBe(403)
  })

  it("AC2 deep escape: GET content?path=foo/../../../etc/passwd → 403", async () => {
    const taskId = await createV3Task(app, "E2E_TD deep escape")
    writeInternalArtifact(taskHome, taskId, "spec.md", "ok")
    const res = await app.request(
      `/api/tasks/${taskId}/artifacts/content?path=foo/..%2F..%2F..%2Fetc%2Fpasswd`,
    )
    expect(res.status).toBe(403)
  })

  it("AC2 unregistered absolute path → 403 (not in index)", async () => {
    const taskId = await createV3Task(app, "E2E_TD unregistered abs")
    writeInternalArtifact(taskHome, taskId, "spec.md", "ok")
    // An absolute path that is NOT registered in the index → 403.
    const abs = path.join(homeBase, "not-registered.md")
    fs.writeFileSync(abs, "secret", "utf-8")
    const res = await app.request(
      `/api/tasks/${taskId}/artifacts/content?path=${encodeURIComponent(abs)}`,
    )
    expect(res.status).toBe(403)
  })

  it("AC2/AC3 external registered: GET content?path=<abs> → content == disk", async () => {
    const taskId = await createV3Task(app, "E2E_TD content external")
    const abs = writeExternalArtifact(taskHome, taskId, homeBase, "persona.md", "# E2E_TD external persona")
    const res = await app.request(
      `/api/tasks/${taskId}/artifacts/content?path=${encodeURIComponent(abs)}`,
    )
    expect(res.status).toBe(200)
    const body = await json<{ path: string; content: string }>(res)
    expect(body.path).toBe(abs)
    expect(body.content).toBe(fs.readFileSync(abs, "utf-8"))
    expect(body.content).toContain("E2E_TD external persona")
  })

  // ── AC4: registered-but-missing external entry → 404 ───────────────

  it("AC4: registered external whose file is missing on disk → 404 + clear code", async () => {
    const taskId = await createV3Task(app, "E2E_TD missing external file")
    // Register an external entry pointing at a path that does NOT exist on disk.
    const ghost = path.join(homeBase, "external-src", "ghost.md")
    taskHome.writeArtifactEntry(taskId, {
      path: ghost,
      by: "third-party-skill",
      title: "ghost",
      external: true,
      updated_at: "2026-08-18T00:00:00.000Z",
    })
    expect(fs.existsSync(ghost)).toBe(false)
    const res = await app.request(
      `/api/tasks/${taskId}/artifacts/content?path=${encodeURIComponent(ghost)}`,
    )
    expect(res.status).toBe(404)
    const body = await json<{ error: string }>(res)
    // Clear error message so the UI can show a degraded state (AC4).
    expect(body.error.toLowerCase()).toContain("not found")
  })

  it("AC4 internal file missing on disk → 404", async () => {
    const taskId = await createV3Task(app, "E2E_TD missing internal file")
    // No file written at this relative path.
    const res = await app.request(`/api/tasks/${taskId}/artifacts/content?path=never-written.md`)
    expect(res.status).toBe(404)
  })

  // ── Edge: missing path param + missing task ────────────────────────

  it("GET content with no path param → 400", async () => {
    const taskId = await createV3Task(app, "E2E_TD no path param")
    const res = await app.request(`/api/tasks/${taskId}/artifacts/content`)
    expect(res.status).toBe(400)
  })

  it("GET content for missing task → 404 (task-exists check before whitelist)", async () => {
    const res = await app.request(
      `/api/tasks/no-such-task/artifacts/content?path=spec.md`,
    )
    expect(res.status).toBe(404)
  })
})
