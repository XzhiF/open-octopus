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
let readyMock: ReturnType<typeof vi.fn>
let resumeMock: ReturnType<typeof vi.fn>
let createTaskMock: ReturnType<typeof vi.fn>
let updateSessionMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  cabin = new CabinDAO(db)
  taskDAO = new TaskDAO(db)
  cabin.insert({
    id: "c1", name: "舱", path: "C:/tmp/cabin-comm", workspace_id: "ws-cabin",
    main_session_id: "s-main", requirements: "", status: "active",
    mainline_strategy: "clean-main", org: "org", init_state: null, cockpit_prefs: null,
    version: 1, created_at: NOW, updated_at: NOW,
    last_active_at: NOW, archived_at: null, deleted_at: null,
  })
  fetchMock = vi.fn(async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  }))
  vi.stubGlobal("fetch", fetchMock)
  triggerMock = vi.fn(async () => ({}))
  readyMock = vi.fn(() => ({}))
  resumeMock = vi.fn(async () => ({}))
  createTaskMock = vi.fn(() => ({ id: "task-1", workspace_id: "ws-task" }))
  updateSessionMock = vi.fn()
  comm = new CabinCommService({
    cabin,
    taskDAO,
    agentSessionDAO: {
      updateSession: updateSessionMock,
    } as never,
    tasksService: {
      createTask: createTaskMock,
      readyTask: readyMock,
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
    // design 23 §3.1/§4：v4 起草形状 + 任务自己的 workspace（不再复用舱 ws）。
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      cabin_id: "c1", task_spec: { format: "v4" }, source_chat_session_id: "sess-author",
    }))
    const createArgs = createTaskMock.mock.calls[0][0] as Record<string, unknown>
    expect(createArgs).not.toHaveProperty("workspace_id")
    expect(createArgs).not.toHaveProperty("task_type")
    expect(updateSessionMock).toHaveBeenCalledWith("sess-author", expect.objectContaining({
      cabin_id: "c1", scope_id: "task-1", workspace_id: "ws-task",
    }))
    expect(job.ref_id).toBe("task-1")
    expect(job.session_id).toBe("sess-author")
    const events = cabin.listEvents(job.id)
    expect(events.map((e) => e.kind)).toEqual(["dispatch"])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { message: string }
    expect(body.message).toContain("mandate=explicit")
    expect(body.message).toContain("clarify=ask")
    expect(body.message).toContain("需求原文")
    // design 23 §1：派发授权不再等于「规格免确认」。
    expect(body.message).toContain("先澄清")
    expect(body.message).not.toContain("无需再向人确认")
  })

  it("dispatch(task, clarify=auto)：用户说「看着办」才允许无歧义直接入列", async () => {
    comm.dispatch("c1", {
      kind: "task", title: "T", prompt: "P",
      mandate: { strength: "explicit", clarify: "auto" },
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { message: string }
    expect(body.message).toContain("clarify=auto")
    expect(body.message).toContain("看着办")
    expect(body.message).not.toContain("先澄清：")
  })

  it("resume：ready 任务触发 + resume 事件", async () => {
    insertTask("task-r", "ready", "c1")
    const job = comm.dispatch("c1", { kind: "task", title: "T", ref_id: "task-r" })
    await comm.resume("c1", job.id)
    expect(triggerMock).toHaveBeenCalledWith("task-r")
    const event = cabin.listEvents(job.id).find((e) => e.kind === "resume")!
    expect(JSON.parse(event.payload!)).toMatchObject({ action: "trigger", from_status: "ready" })
  })

  it("resume：v4 草稿先过 ready gate 入列，再触发", async () => {
    readyMock.mockImplementation((id: string) => {
      db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(id)
      return {}
    })
    insertTask("task-d", "draft", "c1")
    const job = comm.dispatch("c1", { kind: "task", title: "T", ref_id: "task-d" })
    await comm.resume("c1", job.id)
    expect(readyMock).toHaveBeenCalledWith("task-d")
    expect(triggerMock).toHaveBeenCalledWith("task-d")
    const event = cabin.listEvents(job.id).find((e) => e.kind === "resume")!
    expect(JSON.parse(event.payload!)).toMatchObject({
      action: "enqueue+trigger", from_status: "draft", to_status: "ready",
    })
  })

  it("resume：gate 缺项时落 error 事件并原样抛出（不假装已触发）", async () => {
    const gate = Object.assign(new Error("phase:2:workflow-ref"), {
      missing: ["phase:2:workflow-ref"],
    })
    readyMock.mockImplementationOnce(() => { throw gate })
    insertTask("task-g", "draft", "c1")
    const job = comm.dispatch("c1", { kind: "task", title: "T", ref_id: "task-g" })
    await expect(comm.resume("c1", job.id)).rejects.toThrow("phase:2:workflow-ref")
    expect(triggerMock).not.toHaveBeenCalled()
    const event = cabin.listEvents(job.id).find((e) => e.kind === "resume")!
    expect(JSON.parse(event.payload!)).toMatchObject({
      action: "error", from_status: "draft", missing: ["phase:2:workflow-ref"],
    })
  })

  it("note：默认只留痕进审计；notify=true 才唤醒会话转达", async () => {
    // workflow job 的 dispatch 不 wake，能干净地观察 note 自己的唤醒开关。
    const job = comm.dispatch("c1", { kind: "workflow", title: "T", ref_id: "wf-1", session_id: "sess-note" })
    const event = comm.note("c1", job.id, "phase 2 产物已删除")
    expect(event.kind).toBe("note")
    expect(JSON.parse(event.payload!)).toEqual({ summary: "phase 2 产物已删除" })
    expect(fetchMock).not.toHaveBeenCalled()

    comm.note("c1", job.id, "请作者不要恢复", { notify: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { message: string }
    expect(body.message).toContain("[舱备注 · 不授权]")
    expect(cabin.listEvents(job.id).filter((e) => e.kind === "note")).toHaveLength(2)
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
