// Cabin P3（C6/C9）：CabinCommService 语义层 —— dispatch 建真实任务+作者线程+
// 首回合 wake；note 不授权（subagent 只留痕）；resume 触发 ready；入站信号自动
// 登记 job 并落 report/attention/handback。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { CabinDAO } from "../../../db/dao/cabin-dao"
import { TaskDAO } from "../../../db/dao"
import { CabinCommService } from "../cabin-comm-service"
import type { TasksService } from "../../tasks/tasks-service"

vi.mock("../../agent/session-service", () => ({
  getSessionService: () => ({
    createSession: () => ({ id: "sess-author" }),
  }),
}))

const NOW = "2026-11-12T10:00:00.000Z"

let db: Database.Database
let cabin: CabinDAO
let taskDAO: TaskDAO
let comm: CabinCommService
let fetchMock: ReturnType<typeof vi.fn>
let triggerMock: ReturnType<typeof vi.fn>
let resumeMock: ReturnType<typeof vi.fn>
let createTaskMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  cabin = new CabinDAO(db)
  taskDAO = new TaskDAO(db)
  cabin.insert({
    id: "c1", name: "舱", path: "C:/tmp/cabin-comm", workspace_id: "ws-cabin",
    main_session_id: "s-main", requirements: "", status: "active",
    mainline_strategy: "clean-main", org: "org", init_state: null, cockpit_prefs: null,
    focused_job_id: null, version: 1, created_at: NOW, updated_at: NOW,
    last_active_at: NOW, archived_at: null,
  })
  fetchMock = vi.fn(async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  }))
  vi.stubGlobal("fetch", fetchMock)
  triggerMock = vi.fn(async () => ({}))
  resumeMock = vi.fn(async () => ({}))
  createTaskMock = vi.fn(() => ({ id: "task-1", workspace_id: "ws-cabin" }))
  comm = new CabinCommService({
    cabin,
    taskDAO,
    agentSessionDAO: {
      updateSession: vi.fn(),
    } as never,
    tasksService: {
      createTask: createTaskMock,
      triggerTask: triggerMock,
      resumeTask: resumeMock,
    } as unknown as TasksService,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
})

function insertTask(id: string, status: string, cabinId: string | null): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, task_spec, cabin_id, created_at, updated_at)
    VALUES (?, 'org', ?, ?, '{}', ?, ?, ?)
  `).run(id, `任务${id}`, status, cabinId, NOW, NOW)
}

describe("CabinCommService", () => {
  it("dispatch(task) 建真实任务+作者线程+job+dispatch 事件+首回合 wake", async () => {
    const job = comm.dispatch("c1", {
      kind: "task", title: "接入渠道", prompt: "需求原文", mandate: { strength: "explicit" },
    })
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      cabin_id: "c1", workspace_id: "ws-cabin", task_type: "coding",
    }))
    expect(job.ref_id).toBe("task-1")
    expect(job.session_id).toBe("sess-author")
    const events = cabin.listEvents(job.id)
    expect(events.map((e) => e.kind)).toEqual(["dispatch"])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { message: string }
    expect(body.message).toContain("mandate=explicit")
    expect(body.message).toContain("需求原文")
  })

  it("note：task 落痕+steer wake；subagent 只留痕（C9 风险12）", async () => {
    const job = comm.dispatch("c1", { kind: "subagent", title: "临时调研", ref_id: "run-1" })
    fetchMock.mockClear()
    comm.note("c1", job.id, "只留痕")
    expect(cabin.listEvents(job.id).map((e) => e.kind)).toEqual(["dispatch", "note"])
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("resume：ready 任务触发 + resume 事件", async () => {
    insertTask("task-r", "ready", "c1")
    const job = comm.dispatch("c1", { kind: "task", title: "T", ref_id: "task-r" })
    await comm.resume("c1", job.id)
    expect(triggerMock).toHaveBeenCalledWith("task-r")
    expect(cabin.listEvents(job.id).map((e) => e.kind)).toContain("resume")
  })

  it("recordTaskSignal：自动登记 job + attention/report/handback + 终态 endJob", () => {
    insertTask("task-x", "running", "c1")
    comm.recordTaskSignal("task-x", "awaiting_review", "待验收")
    const job = cabin.findJobByRef("c1", "task-x")
    expect(job).toBeDefined()
    expect(cabin.listEvents(job!.id).map((e) => e.kind)).toEqual(["dispatch", "attention"])
    comm.recordTaskSignal("task-x", "done", "完成")
    const events = cabin.listEvents(job!.id)
    expect(events.map((e) => e.kind)).toEqual(["dispatch", "attention", "report"])
    expect(cabin.findJob(job!.id)!.ended_at).not.toBeNull()
    comm.recordTaskSignal("task-x", "failed", "失败")
    expect(cabin.listEvents(job!.id).map((e) => e.kind)).toContain("handback")
  })

  it("recordTaskSignal：无舱任务不落账；running 不落（progress 内部不 wake）", () => {
    insertTask("task-n", "running", null)
    comm.recordTaskSignal("task-n", "done", "x")
    expect(cabin.listJobs("c1")).toHaveLength(0)
    insertTask("task-c", "running", "c1")
    comm.recordTaskSignal("task-c", "running", "x")
    expect(cabin.listJobs("c1")).toHaveLength(0)
  })
})
