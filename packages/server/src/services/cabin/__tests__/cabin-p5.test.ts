// Cabin P5：C11 dormant（手动守卫三条件 + 自动阈值 sweep + per-cabin 覆盖 + 活动 bump）
// + G3 封存沉淀 hook + wake/reopen 自愈。真实 DB（applySchema），K3 守卫读 getView。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../../db/dao"
import { TokenUsageDAO } from "../../../db/dao/token-usage-dao"
import { ExecutionLinkDAO } from "../../../db/dao/execution-link-dao"
import { IncidentStore } from "../../supervision/incident-store"
import { initSessionService } from "../../agent/session-service"
import { CabinService, CabinStatusConflictError } from "../cabin-service"
import { CabinCommService } from "../cabin-comm-service"
import type { FindingOpsService } from "../../knowledge/findings"
import type { TasksService } from "../../tasks/tasks-service"

const NOW = "2026-11-12T10:00:00.000Z"
const MIN = 60_000

let db: Database.Database
let cabinDAO: CabinDAO
let taskDAO: TaskDAO
let executionDAO: ExecutionDAO
let agentSessionDAO: AgentSessionDAO
let svc: CabinService
let tmpDir: string

function insertCabin(id: string, prefs: string | null = null, lastActive = NOW): void {
  cabinDAO.insert({
    id, name: `舱${id}`, path: path.join(tmpDir, id), workspace_id: "ws-1",
    main_session_id: "s-main", requirements: "", status: "active",
    mainline_strategy: "clean-main", org: "org", init_state: null, cockpit_prefs: prefs,
    focused_job_id: null, version: 1, created_at: NOW, updated_at: NOW,
    last_active_at: lastActive, archived_at: null,
  })
}
function insertTask(id: string, status: string): void {
  db.prepare(`INSERT INTO tasks (id, repo_group, name, status, task_spec, cabin_id, created_at, updated_at)
    VALUES (?, 'repo-a', ?, ?, '{}', 'c1', ?, ?)`).run(id, `任务${id}`, status, NOW, NOW)
}
function insertExecution(id: string, taskId: string, status: string): void {
  db.prepare(`INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, task_id, created_at, updated_at)
    VALUES (?, 'ws-1', 'wf', 'WF', ?, ?, ?, ?)`).run(id, status, taskId, NOW, NOW)
}

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  cabinDAO = new CabinDAO(db)
  taskDAO = new TaskDAO(db)
  executionDAO = new ExecutionDAO(db)
  agentSessionDAO = new AgentSessionDAO(db)
  initSessionService(agentSessionDAO)
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-p5-test-"))
  svc = new CabinService(cabinDAO)
  svc.bindInfra({
    workspaceService: { ensureWorktreesForReuse: vi.fn() } as never,
    workspaceDAO: new WorkspaceDAO(db),
    agentSessionDAO, taskDAO, executionDAO,
    acceptanceDAO: new AcceptanceDAO(db),
    incidentStore: new IncidentStore(db),
    findingOps: { root: tmpDir, list: () => [] } as unknown as FindingOpsService,
    tokenUsageDAO: new TokenUsageDAO(db),
    execLinks: new ExecutionLinkDAO(db),
  })
  db.prepare(`INSERT INTO workspaces (id, name, repo_group, path, source, status, created_at, updated_at)
    VALUES ('ws-1', '舱测试工作区', 'repo-a', ?, 'user', 'active', ?, ?)`).run(tmpDir, NOW, NOW)
  db.prepare(`INSERT INTO sessions (id, title, cwd, cabin_id, created_at, updated_at)
    VALUES ('s-main', '舱主会话', ?, 'c1', ?, ?)`).run(tmpDir, NOW, NOW)
  insertCabin("c1")
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("C11 手动 dormant + 守卫三条件", () => {
  it("active 空闲 → dormant；wake → active（自愈）", () => {
    expect(svc.dormant("c1").status).toBe("dormant")
    expect(svc.wake("c1").status).toBe("active")
  })
  it("有运行执行 → 拒绝休眠（不孤儿活作业）", () => {
    insertTask("t1", "running"); insertExecution("e1", "t1", "running")
    expect(() => svc.dormant("c1")).toThrow(CabinStatusConflictError)
    expect(cabinDAO.findById("c1")!.status).toBe("active")
  })
  it("有待人 attention（awaiting_review）→ 拒绝休眠", () => {
    insertTask("t1", "awaiting_review")
    expect(() => svc.dormant("c1")).toThrow(CabinStatusConflictError)
  })
  it("非 active 态 → 拒绝（dormant 不能重复休眠）", () => {
    svc.dormant("c1")
    expect(() => svc.dormant("c1")).toThrow(CabinStatusConflictError)
  })
})

describe("C11 自动阈值 sweepDormant", () => {
  it("空闲超阈值 → 休眠", () => {
    const ids = svc.sweepDormant(Date.parse(NOW) + 31 * MIN, 30 * MIN)
    expect(ids).toEqual(["c1"])
    expect(cabinDAO.findById("c1")!.status).toBe("dormant")
  })
  it("未超阈值 → 保留 active", () => {
    expect(svc.sweepDormant(Date.parse(NOW) + 10 * MIN, 30 * MIN)).toEqual([])
    expect(cabinDAO.findById("c1")!.status).toBe("active")
  })
  it("运行中舱即使超时也不休眠（守卫）", () => {
    insertTask("t1", "running"); insertExecution("e1", "t1", "running")
    expect(svc.sweepDormant(Date.parse(NOW) + 60 * MIN, 30 * MIN)).toEqual([])
  })
  it("待人 attention 舱即使超时也不休眠（守卫）", () => {
    insertTask("t1", "awaiting_review")
    expect(svc.sweepDormant(Date.parse(NOW) + 60 * MIN, 30 * MIN)).toEqual([])
  })
  it("dormantMinutes=0 关闭自动休眠", () => {
    cabinDAO.updateFields("c1", 1, { cockpit_prefs: JSON.stringify({ dormantMinutes: 0 }) }, NOW)
    expect(svc.sweepDormant(Date.parse(NOW) + 999 * MIN, 30 * MIN)).toEqual([])
  })
  it("per-cabin 阈值覆盖默认（5 分钟）", () => {
    cabinDAO.updateFields("c1", 1, { cockpit_prefs: JSON.stringify({ dormantMinutes: 5 }) }, NOW)
    expect(svc.sweepDormant(Date.parse(NOW) + 6 * MIN, 30 * MIN)).toEqual(["c1"])
  })
  it("只扫 active：已 dormant / archived 舱不再处理", () => {
    svc.dormant("c1")
    insertCabin("c2")
    svc.archive("c2")
    expect(svc.sweepDormant(Date.parse(NOW) + 999 * MIN, 30 * MIN)).toEqual([])
  })
})

describe("C11 活动 bump（touch / comm.onActivity）", () => {
  it("touch 刷新 last_active_at → sweep 不再休眠", () => {
    cabinDAO.updateFields("c1", 1, { last_active_at: "2020-01-01T00:00:00.000Z" }, NOW)
    svc.touch("c1")
    expect(svc.sweepDormant(Date.now(), 30 * MIN)).toEqual([])
  })
  it("dispatch 触发 onActivity（舱活动重置空闲计时）", () => {
    const onActivity = vi.fn()
    const comm = new CabinCommService({
      cabin: cabinDAO, taskDAO, agentSessionDAO,
      tasksService: {} as unknown as TasksService, onActivity,
    })
    comm.dispatch("c1", { kind: "workflow", title: "巡检", ref_id: "w1" })
    expect(onActivity).toHaveBeenCalledWith("c1")
  })
})

describe("G3 封存沉淀 hook + reopen", () => {
  it("archive 触发 archiveHook（fire-and-forget）+ 软封存不级联", () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    svc.setArchiveHook(hook)
    insertTask("t1", "done")
    const row = svc.archive("c1")
    expect(row.status).toBe("archived")
    expect(row.archived_at).not.toBeNull()
    expect(hook).toHaveBeenCalledWith("c1")
    expect(taskDAO.getById("t1")).not.toBeNull() // 任务保留
  })
  it("reopen → active，archived_at 清空，不重跑门禁", () => {
    svc.archive("c1")
    const row = svc.reopen("c1")
    expect(row.status).toBe("active")
    expect(row.archived_at).toBeNull()
  })
})