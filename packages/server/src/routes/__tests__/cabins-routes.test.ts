import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../db/dao"
import { WorkspaceService } from "../../services/workspace"
import { initSessionService } from "../../services/agent/session-service"
import { SSEService } from "../../services/sse"
import { CabinService } from "../../services/cabin/cabin-service"
import { CabinInitService } from "../../services/cabin/cabin-init-service"
import { createCabinRoutes } from "../cabins"

describe("/api/cabins routes", () => {
  let db: Database.Database
  let app: Hono
  let svc: CabinService
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    const dao = new CabinDAO(db)
    const sse = new SSEService()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-routes-test-"))
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    svc = new CabinService(dao)
    const initService = new CabinInitService({
      cabin: dao, sse, runOrchestratorTurn: vi.fn(async () => {}),
    })
    svc.bindInfra({
      workspaceService: new WorkspaceService(new WorkspaceDAO(db)),
      workspaceDAO: new WorkspaceDAO(db),
      agentSessionDAO,
      taskDAO: new TaskDAO(db),
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
      initService,
    })
    app = new Hono()
    app.route("/api/cabins", createCabinRoutes(svc, initService, sse))
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const post = (url: string, body: unknown) =>
    app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const patch = (url: string, body: unknown) =>
    app.request(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  async function createCabin(name = "路由舱"): Promise<Record<string, any>> {
    const res = await post("/api/cabins", { name, path: tmpDir })
    expect(res.status).toBe(201)
    return (await res.json()).cabin
  }

  it("POST / creates a draft; GET / lists; GET /:id returns cabin + derived view", async () => {
    const cabin = await createCabin()
    expect(cabin.status).toBe("draft")
    expect(cabin.name).toBe("路由舱")

    const list = await app.request("/api/cabins")
    expect(list.status).toBe(200)
    expect((await list.json()).cabins).toHaveLength(1)

    const one = await app.request(`/api/cabins/${cabin.id}`)
    expect(one.status).toBe(200)
    const body = await one.json()
    expect(body.cabin.id).toBe(cabin.id)
    expect(body.view.attention).toEqual([])
    expect(body.view.health.running).toBe(0)
  })

  it("POST / with invalid body → 400; unknown id → 404", async () => {
    expect((await post("/api/cabins", { name: "" })).status).toBe(400)
    expect((await app.request("/api/cabins/nope")).status).toBe(404)
  })

  it("PATCH /:id enforces optimistic locking", async () => {
    const cabin = await createCabin()
    const ok = await patch(`/api/cabins/${cabin.id}`, { version: cabin.version, name: "改名" })
    expect(ok.status).toBe(200)
    expect((await ok.json()).cabin.version).toBe(cabin.version + 1)
    const stale = await patch(`/api/cabins/${cabin.id}`, { version: cabin.version, name: "再改" })
    expect(stale.status).toBe(409)
  })

  it("init → 202; GET init shows the 7-item gate; retry resumes to active", async () => {
    const cabin = await createCabin()

    const init = await post(`/api/cabins/${cabin.id}/init`, {})
    expect(init.status).toBe(202)
    expect((await init.json()).cabin.status).toBe("initializing")

    const state = await app.request(`/api/cabins/${cabin.id}/init`)
    expect(state.status).toBe(200)
    expect((await state.json()).state.items).toHaveLength(7)

    // wait for the async gate to finish
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && svc.get(cabin.id).status !== "active") {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(svc.get(cabin.id).status).toBe("active")

    // retry on a non-initializing cabin → 409
    expect((await post(`/api/cabins/${cabin.id}/init/retry`, {})).status).toBe(409)
  })

  it("lifecycle transitions: archive from draft → 409; archive/reopen happy path", async () => {
    const cabin = await createCabin()
    expect((await post(`/api/cabins/${cabin.id}/archive`, {})).status).toBe(409)
    const dao = new CabinDAO(db)
    dao.updateStatus(cabin.id, "active", new Date().toISOString())
    const archived = await post(`/api/cabins/${cabin.id}/archive`, {})
    expect(archived.status).toBe(200)
    expect((await archived.json()).cabin.status).toBe("archived")
    const reopened = await post(`/api/cabins/${cabin.id}/reopen`, {})
    expect((await reopened.json()).cabin.status).toBe("active")
  })

  it("jobs: dispatch leaves a trace; priority patch; focus set/clear", async () => {
    const cabin = await createCabin()
    const jobRes = await post(`/api/cabins/${cabin.id}/jobs`, {
      kind: "task", title: "接入渠道", priority: 2,
      mandate: { strength: "explicit", scope: "渠道接入" },
    })
    expect(jobRes.status).toBe(201)
    const job = (await jobRes.json()).job
    expect(job.mandate.strength).toBe("explicit")

    const trace = await app.request(`/api/cabins/${cabin.id}/jobs/${job.id}/trace`)
    const events = (await trace.json()).events
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe("dispatch")
    expect(events[0].actor).toBe("orchestrator")

    expect((await patch(`/api/cabins/${cabin.id}/jobs/${job.id}`, { priority: 9 })).status).toBe(200)
    const jobs = await app.request(`/api/cabins/${cabin.id}/jobs`)
    expect((await jobs.json()).jobs[0].priority).toBe(9)

    const focused = await post(`/api/cabins/${cabin.id}/focus`, { version: cabin.version, job_id: job.id })
    expect((await focused.json()).cabin.focused_job_id).toBe(job.id)
    const unfocused = await app.request(`/api/cabins/${cabin.id}/focus?version=${cabin.version + 1}`, { method: "DELETE" })
    expect((await unfocused.json()).cabin.focused_job_id).toBeNull()
  })

  it("iterations: create + derived progress + patch status", async () => {
    const cabin = await createCabin()
    const created = await post(`/api/cabins/${cabin.id}/iterations`, { code: "M1", name: "渠道接入" })
    expect(created.status).toBe(201)
    const it = (await created.json()).iteration
    const list = await app.request(`/api/cabins/${cabin.id}/iterations`)
    const items = (await list.json()).iterations
    expect(items[0].progress).toBe(0)
    expect(items[0].task_count).toBe(0)
    expect((await patch(`/api/cabins/${cabin.id}/iterations/${it.id}`, { status: "active" })).status).toBe(200)
  })

  it("DELETE /:id removes the cabin", async () => {
    const cabin = await createCabin()
    expect((await app.request(`/api/cabins/${cabin.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await app.request(`/api/cabins/${cabin.id}`)).status).toBe(404)
  })

  it("GET /:id/events streams SSE with an immediate heartbeat", async () => {
    const cabin = await createCabin()
    const res = await app.request(`/api/cabins/${cabin.id}/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain("heartbeat")
    await reader.cancel()
  })
})