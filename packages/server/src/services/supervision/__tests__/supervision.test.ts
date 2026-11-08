import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { HarnessDAO } from "../../../db/dao/harness-dao"
import { IncidentStore } from "../incident-store"
import { OwnerResolver } from "../owner-resolver"
import { createDefaultHardGuards } from "../hard-guards"
import { RuntimeSupervisor } from "../runtime-supervisor"
import { parseDecision } from "../supervision-service"
import { getChatEventBridge, resetChatEventBridgeForTests } from "../../activity/chat-event-bridge"

function makeDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

function seedExecution(
  db: Database.Database,
  opts: {
    executionId?: string
    status?: string
    sessionId?: string | null
    cloneName?: string | null
    taskId?: string | null
    taskSessionId?: string | null
  } = {},
) {
  const executionId = opts.executionId ?? "exec-1"
  const workspaceId = "ws-1"
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO workspaces (id, name, repo_group, status, path, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
  ).run(workspaceId, "WS", "default", "/tmp/ws", now, now)
  const sessionId = opts.sessionId === undefined ? "sess-1" : opts.sessionId
  if (sessionId) {
    db.prepare(
      "INSERT INTO sessions (id, title, clone_name, created_at, updated_at) VALUES (?, 'chat', ?, ?, ?)",
    ).run(sessionId, opts.cloneName ?? null, now, now)
  }
  if (opts.taskId) {
    if (opts.taskSessionId) {
      db.prepare(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, 'task-chat', ?, ?)",
      ).run(opts.taskSessionId, now, now)
    }
    db.prepare(
      `INSERT INTO tasks (id, name, status, source_chat_session_id, task_spec, created_at, updated_at)
       VALUES (?, 'task', 'running', ?, '{}', ?, ?)`,
    ).run(opts.taskId, opts.taskSessionId ?? null, now, now)
  }
  db.prepare(
    `INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, status, task_id, created_at, updated_at)
     VALUES (?, ?, 'demo.yaml', 'demo', ?, ?, ?, ?)`,
  ).run(executionId, workspaceId, opts.status ?? "running", opts.taskId ?? null, now, now)
  if (sessionId && !opts.taskId) {
    db.prepare(
      "INSERT INTO execution_links (execution_id, session_id, kind, created_at) VALUES (?, ?, 'chat_run', ?)",
    ).run(executionId, sessionId, now)
  }
  return { executionId, workspaceId }
}

describe("parseDecision — REST body normalization", () => {
  it("accepts snake_case var_pool_patches from HTTP bodies", () => {
    expect(parseDecision({ type: "retry", var_pool_patches: { MODE: "ok" } })).toMatchObject({
      type: "retry",
      varPoolPatches: { MODE: "ok" },
    })
  })

  it("accepts camelCase from tool args", () => {
    expect(parseDecision({ type: "retry", varPoolPatches: { MODE: "ok" } })).toMatchObject({
      type: "retry",
      varPoolPatches: { MODE: "ok" },
    })
  })
})

describe("OwnerResolver — 执行级归属", () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
  })
  afterEach(() => db.close())

  it("chat_run → execution_links 的会话", () => {
    seedExecution(db)
    expect(new OwnerResolver(db).resolve("exec-1")).toMatchObject({
      kind: "chat",
      sessionId: "sess-1",
      org: "default",
      workspaceId: "ws-1",
    })
  })

  it("任务执行 → 任务主线程会话", () => {
    seedExecution(db, { taskId: "task-1", taskSessionId: "sess-task", sessionId: null })
    expect(new OwnerResolver(db).resolve("exec-1")?.sessionId).toBe("sess-task")
  })

  it("legacy clone 线程 → 无 owner", () => {
    seedExecution(db, { cloneName: "scheduler" })
    expect(new OwnerResolver(db).resolve("exec-1")).toBeNull()
  })

  it("没有任何会话归属 → null（unowned）", () => {
    seedExecution(db, { sessionId: null })
    expect(new OwnerResolver(db).resolve("exec-1")).toBeNull()
  })
})

describe("IncidentStore — 生命周期", () => {
  let db: Database.Database
  let store: IncidentStore

  beforeEach(() => {
    db = makeDb()
    seedExecution(db)
    store = new IncidentStore(db)
  })
  afterEach(() => db.close())

  const open = () =>
    store.open({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      phase: "before_retry",
      severity: "warning",
      kind: "stupid_retry",
      summary: "same error twice",
      evidence: [{ attempt: 2 }],
      contextRef: "execution:exec-1/node:n1",
      allowedActions: ["proceed", "retry", "escalate"],
    })

  it("同一 node+kind 复用未终态 incident", () => {
    const a = open()
    const b = open()
    expect(b.id).toBe(a.id)
    expect(store.listByExecution("exec-1")).toHaveLength(1)
  })

  it("dispatch → resolve 只生效一次", () => {
    const inc = open()
    store.markDispatched(inc.id, { kind: "chat", ref: "sess-1" })
    expect(store.findById(inc.id)?.status).toBe("dispatched")
    expect(store.resolve(inc.id, { type: "proceed" }, "agent")).toBe(true)
    expect(store.resolve(inc.id, { type: "proceed" }, "agent")).toBe(false)
    expect(store.findById(inc.id)?.status).toBe("resolved")
  })

  it("无 owner → unowned；deadline 过期 → expired", () => {
    const inc = store.open({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n2",
      phase: "node_end",
      severity: "info",
      kind: "timeout_cascade",
      summary: "slow",
      evidence: [],
      contextRef: "x",
      allowedActions: ["proceed"],
      deadlineAt: Date.now() - 1,
    })
    store.markUnowned(inc.id)
    expect(store.findById(inc.id)?.status).toBe("unowned")
    expect(store.expireDue()).toContain(inc.id)
    expect(store.findById(inc.id)?.status).toBe("expired")
  })
})

describe("RuntimeSupervisor — 硬护栏 / 事件 / 决策", () => {
  let db: Database.Database
  let notifySpy: ReturnType<typeof vi.fn>
  let applyMock: ReturnType<typeof vi.fn>

  const build = (hostPid = "12345") => {
    applyMock = vi.fn().mockResolvedValue({ ok: true, detail: "applied" })
    return new RuntimeSupervisor({
      executionId: "exec-1",
      workspaceId: "ws-1",
      db,
      dao: new HarnessDAO(db),
      sse: { emit: vi.fn() },
      hostPid,
      hardGuards: createDefaultHardGuards(),
      actionExecutor: { apply: applyMock } as never,
      ownerResolver: new OwnerResolver(db),
      incidentStore: new IncidentStore(db),
    })
  }

  beforeEach(() => {
    db = makeDb()
    seedExecution(db)
    resetChatEventBridgeForTests()
    notifySpy = vi
      .spyOn(getChatEventBridge(), "notifyIncident")
      .mockResolvedValue(undefined) as never
  })
  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it("process_conflict 硬护栏：同步 block，不创建可分派事件、不唤醒 Agent", async () => {
    const supervisor = build("12345")
    const callbacks = supervisor.onExecutionStart({})
    const decision = await callbacks.onBeforeNode!("bad", "bash", {
      bash: "kill -9 12345",
    } as never)
    expect(decision).toMatchObject({ action: "skip" })
    expect(notifySpy).not.toHaveBeenCalled()

    const incidents = new IncidentStore(db).listByExecution("exec-1")
    expect(incidents).toHaveLength(1)
    expect(incidents[0].kind).toBe("process_conflict")
    expect(incidents[0].status).toBe("resolved")
    expect(incidents[0].resolutionSource).toBe("policy")
  })

  it("重复失败 → 创建 incident、分派给 chat owner、失败 hook 选择 pause", async () => {
    const supervisor = build()
    const callbacks = supervisor.onExecutionStart({})
    const fail = { error: "boom", logLines: ["boom"] } as never

    await callbacks.onBeforeRetry!("n1", 1, fail, { poolSnapshot: {} })
    await callbacks.onBeforeRetry!("n1", 2, fail, { poolSnapshot: {} })

    const incidents = new IncidentStore(db).listByExecution("exec-1")
    expect(incidents.length).toBeGreaterThan(0)
    expect(incidents.some((i) => i.status === "dispatched")).toBe(true)
    expect(notifySpy).toHaveBeenCalled()

    const failure = await callbacks.onFailureDecision!("n1", "boom", "fail_fast")
    expect(failure).toMatchObject({ action: "delegate" })
  })

  it("无 owner 的执行不因 incident 被挂死：失败 hook 仍走引擎默认策略", async () => {
    db.prepare("DELETE FROM execution_links WHERE execution_id = 'exec-1'").run()
    db.prepare("UPDATE executions SET task_id = NULL WHERE id = 'exec-1'").run()
    const supervisor = build()
    const callbacks = supervisor.onExecutionStart({})
    const fail = { error: "boom", logLines: ["boom"] } as never
    await callbacks.onBeforeRetry!("n1", 1, fail, { poolSnapshot: {} })
    await callbacks.onBeforeRetry!("n1", 2, fail, { poolSnapshot: {} })

    const incidents = new IncidentStore(db).listByExecution("exec-1")
    expect(incidents.some((i) => i.status === "unowned")).toBe(true)
    expect(notifySpy).not.toHaveBeenCalled()
    const failure = await callbacks.onFailureDecision!("n1", "boom", "fail_fast")
    expect(failure).toMatchObject({ action: "abort" })
  })

  it("resolve 白名单：未允许的动作被拒绝", async () => {
    const supervisor = build()
    const store = new IncidentStore(db)
    const inc = store.open({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n9",
      phase: "before_retry",
      severity: "warning",
      kind: "stupid_retry",
      summary: "x",
      evidence: [],
      contextRef: "x",
      allowedActions: ["proceed"],
    })
    const result = await supervisor.resolve(inc.id, { type: "abort", reason: "nope" }, "agent")
    expect(result.ok).toBe(false)
    expect(store.findById(inc.id)?.status).not.toBe("resolved")
  })

  it("paused 执行上 resolve retry → 走 ActionExecutor 并落 resolved", async () => {
    db.prepare("UPDATE executions SET status = 'paused' WHERE id = 'exec-1'").run()
    const supervisor = build()
    const store = new IncidentStore(db)
    const inc = store.open({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      phase: "failure_exhausted",
      severity: "warning",
      kind: "stupid_retry",
      summary: "x",
      evidence: [],
      contextRef: "x",
      allowedActions: ["retry", "escalate"],
    })
    const result = await supervisor.resolve(
      inc.id,
      { type: "retry", hint: "try another way" },
      "agent",
    )
    expect(result.ok).toBe(true)
    expect(applyMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "exec-1", nodeId: "n1" }),
    )
    expect(store.findById(inc.id)?.status).toBe("resolved")
  })

  it("running 执行上 resolve → 决策进入下一个 hook，不重复驱动引擎", async () => {
    const supervisor = build()
    const callbacks = supervisor.onExecutionStart({})
    const store = new IncidentStore(db)
    const inc = store.open({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      phase: "before_retry",
      severity: "warning",
      kind: "stupid_retry",
      summary: "x",
      evidence: [],
      contextRef: "x",
      allowedActions: ["retry", "escalate"],
    })
    const result = await supervisor.resolve(inc.id, { type: "retry", hint: "换方法" }, "agent")
    expect(result.ok).toBe(true)
    expect(applyMock).not.toHaveBeenCalled()

    const retry = await callbacks.onBeforeRetry!(
      "n1",
      1,
      { error: "boom", logLines: ["boom"] } as never,
      { poolSnapshot: {} },
    )
    expect(retry).toMatchObject({ action: "retry", harnessHint: "换方法" })
  })

  it("落地失败时事件保持开启（Agent 可换动作或升级）", async () => {
    db.prepare("UPDATE executions SET status = 'paused' WHERE id = 'exec-1'").run()
    const supervisor = build()
    applyMock.mockResolvedValueOnce({ ok: false, detail: "block 不能在引擎外落地" })
    const store = new IncidentStore(db)
    const inc = store.open({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      phase: "failure_exhausted",
      severity: "warning",
      kind: "stupid_retry",
      summary: "x",
      evidence: [],
      contextRef: "x",
      allowedActions: ["block", "retry"],
    })
    const result = await supervisor.resolve(inc.id, { type: "block", reason: "skip" }, "agent")
    expect(result.ok).toBe(false)
    expect(store.findById(inc.id)?.status).not.toBe("resolved")
  })

  it("escalate → waiting_human + 确认卡", async () => {
    const supervisor = build()
    const store = new IncidentStore(db)
    const inc = store.open({
      executionId: "exec-1",
      workspaceId: "ws-1",
      nodeId: "n1",
      phase: "failure_exhausted",
      severity: "critical",
      kind: "deterministic_error",
      summary: "x",
      evidence: [],
      contextRef: "x",
      allowedActions: ["retry", "escalate"],
    })
    const escalationSpy = vi
      .spyOn(getChatEventBridge(), "requestIncidentEscalation")
      .mockImplementation(() => {})
    const result = await supervisor.resolve(
      inc.id,
      { type: "escalate", reason: "需要业务判断", options: ["继续", "中止"] },
      "agent",
    )
    expect(result.status).toBe("waiting_human")
    expect(store.findById(inc.id)?.status).toBe("waiting_human")
    expect(escalationSpy).toHaveBeenCalled()
  })
})
