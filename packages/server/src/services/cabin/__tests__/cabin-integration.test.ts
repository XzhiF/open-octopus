import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
  SessionCacheContextDAO,
} from "../../../db/dao"
import { WorkspaceService } from "../../workspace"
import { initSessionService } from "../../agent/session-service"
import { SSEService } from "../../sse"
import { CabinService, CabinStatusConflictError } from "../cabin-service"
import { CabinInitService } from "../cabin-init-service"

async function waitForStatus(svc: CabinService, id: string, status: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (svc.get(id).status === status) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`cabin ${id} did not reach ${status} (still ${svc.get(id).status})`)
}

describe("CabinService integration (real workspace/session infra)", () => {
  let db: Database.Database
  let dao: CabinDAO
  let workspaceDAO: WorkspaceDAO
  let agentSessionDAO: AgentSessionDAO
  let svc: CabinService
  let tmpDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new CabinDAO(db)
    workspaceDAO = new WorkspaceDAO(db)
    agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-int-test-"))
    const sse = new SSEService()
    const initService = new CabinInitService({
      cabin: dao, sse, runOrchestratorTurn: vi.fn(async () => {}),
    })
    svc = new CabinService(dao)
    svc.bindInfra({
      workspaceService: new WorkspaceService(workspaceDAO),
      workspaceDAO,
      agentSessionDAO,
      taskDAO: new TaskDAO(db),
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
      initService,
    })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("create scaffolds workspace + orchestrator main session with role binding", () => {
    const cabin = svc.create({ name: "Aurora 结算平台", path: tmpDir, requirements: "做结算", repos: ["demo"] })
    expect(cabin.status).toBe("draft")
    expect(cabin.workspace_id).toBeTruthy()
    expect(cabin.main_session_id).toBeTruthy()

    const ws = workspaceDAO.findById(cabin.workspace_id!)!
    expect(ws.cabin_id).toBe(cabin.id)
    expect(ws.path).toBe(tmpDir)
    expect(ws.name).toMatch(/^[a-zA-Z0-9_-]+$/) // ASCII slug, Chinese display name stays on cabins.name
    expect(fs.existsSync(path.join(tmpDir, "config.json"))).toBe(true)
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"))
    expect(config.repos.map((r: { name: string }) => r.name)).toEqual(["demo"])

    const session = agentSessionDAO.findById(cabin.main_session_id!)!
    expect(session.cabin_id).toBe(cabin.id)
    expect(session.cwd).toBe(tmpDir)
    expect(session.session_type).toBe("main")
    const role = new SessionCacheContextDAO(db).getRoleState(cabin.main_session_id!)
    expect(role.activeExpert).toBe("cabin-orchestrator")
    expect(role.activeKind).toBe("clone")
  })

  it("create → init → active end-to-end; archive/reopen/wake lifecycle", async () => {
    const cabin = svc.create({ name: "生命周期舱", path: tmpDir })
    svc.init(cabin.id)
    await waitForStatus(svc, cabin.id, "active")

    expect(fs.existsSync(path.join(tmpDir, ".cabin", "manifest.json"))).toBe(true)
    expect(svc.listIterations(cabin.id).map((i) => i.code)).toEqual(["M1"])

    // soft archive keeps everything (C1)
    const archived = svc.archive(cabin.id)
    expect(archived.status).toBe("archived")
    expect(archived.archived_at).toBeTruthy()
    expect(workspaceDAO.findById(cabin.workspace_id!)).toBeTruthy()
    expect(agentSessionDAO.findById(cabin.main_session_id!)!.is_deleted).toBe(0)

    // reopen: no re-init gate
    const reopened = svc.reopen(cabin.id)
    expect(reopened.status).toBe("active")
    expect(reopened.archived_at).toBeNull()

    // dormant → wake
    dao.updateStatus(cabin.id, "dormant", new Date().toISOString())
    expect(svc.wake(cabin.id).status).toBe("active")

    // invalid transitions are 409-shaped
    expect(() => svc.archive(cabin.id)).not.toThrow() // active → archived legal
    expect(() => svc.wake(cabin.id)).toThrow(CabinStatusConflictError) // archived ≠ dormant
  })

  it("delete cascades workspace/session/cabin rows (G1)", async () => {
    const cabin = svc.create({ name: "删除舱", path: tmpDir })
    svc.init(cabin.id)
    await waitForStatus(svc, cabin.id, "active")
    const wsId = cabin.workspace_id!
    const sessId = cabin.main_session_id!

    svc.delete(cabin.id)
    expect(dao.findById(cabin.id)).toBeUndefined()
    expect(workspaceDAO.findById(wsId)).toBeNull()
    expect(agentSessionDAO.findById(sessId)!.is_deleted).toBe(1)
    // the user's directory itself is never rm -rf'd by delete
    expect(fs.existsSync(tmpDir)).toBe(true)
  })

  it("attach restores identity from .cabin/manifest.json when the DB row is gone", () => {
    const cabin = svc.create({ name: "重建舱", path: tmpDir, requirements: "原始需求" })
    fs.mkdirSync(path.join(tmpDir, ".cabin"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, ".cabin", "manifest.json"), JSON.stringify({
      id: cabin.id, name: cabin.name, path: tmpDir, org: null,
      main_session_id: cabin.main_session_id, createdAt: cabin.created_at,
    }))
    fs.writeFileSync(path.join(tmpDir, ".cabin", "requirements.md"), "原始需求")
    fs.writeFileSync(path.join(tmpDir, ".cabin", "init-state.json"), JSON.stringify({
      items: [{ key: "dir", state: "done" }],
    }))
    dao.delete(cabin.id)

    const restored = svc.attach(tmpDir)
    expect(restored.id).toBe(cabin.id)
    expect(restored.status).toBe("draft") // snapshot not all-done
    expect(restored.requirements).toBe("原始需求")
    expect(restored.workspace_id).toBe(cabin.workspace_id)
    expect(restored.main_session_id).toBe(cabin.main_session_id)
  })

  it("getView derives attention from cabin tasks via deriveTaskView", () => {
    const cabin = svc.create({ name: "视图舱", path: tmpDir })
    const taskDAO = new TaskDAO(db)
    taskDAO.insert({ id: "t1", name: "任务一", repo_group: null, status: "awaiting_review", cabin_id: cabin.id })
    svc.dispatchJob(cabin.id, { kind: "task", ref_id: "t1", title: "任务一", priority: 3 })
    const { view } = svc.getView(cabin.id)
    expect(view.attention.some((a) => a.stage === "review" && a.task_id === "t1" && a.priority === 3)).toBe(true)
  })
})