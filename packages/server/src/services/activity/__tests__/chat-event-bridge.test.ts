import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { getChatEventBridge, resetChatEventBridgeForTests } from "../chat-event-bridge"

/**
 * 通用「工作流运行」卡（2026-11-02）：执行层卡片，一执行一张、不唤醒主 Chat。
 * 验收规划是第一个消费方（task_id=NULL 的系统运行）。
 */

function insertSession(db: Database.Database, id: string, cloneName: string | null): void {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, title, clone_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "会话", cloneName, now, now)
}

function insertTask(
  db: Database.Database,
  id: string,
  sourceSessionId: string | null,
): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO tasks (id, name, source_chat_session_id, workspace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "演示任务", sourceSessionId, "ws-1", now, now)
}

function cards(db: Database.Database, sessionId: string): Array<Record<string, unknown>> {
  const rows = db.prepare(
    "SELECT content, metadata FROM messages WHERE session_id = ? ORDER BY created_at",
  ).all(sessionId) as Array<{ content: string; metadata: string | null }>
  return rows.map((r) => JSON.parse(r.metadata ?? "{}") as Record<string, unknown>)
}

const PLAN_CARD = {
  taskId: "t-1",
  executionId: "plan-exec-1",
  workspaceId: "ws-1",
  workflowRef: "built-in/acceptance-plan",
  workflowName: "验收规划",
  system: true,
  phaseIndex: 1,
  roundIndex: 2,
}

describe("ChatEventBridge.requestWorkflowRunCard", () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    resetChatEventBridgeForTests()
    getChatEventBridge().attach(db)
    insertSession(db, "s-main", null)
    insertTask(db, "t-1", "s-main")
  })

  afterEach(() => {
    db?.close()
    resetChatEventBridgeForTests()
  })

  it("落一张执行卡：payload.workflowRun + system + 坐标", () => {
    getChatEventBridge().requestWorkflowRunCard(PLAN_CARD)

    const rows = cards(db, "s-main")
    expect(rows).toHaveLength(1)
    const activity = rows[0].activity as {
      status: string
      executionId: string
      workspaceId: string
      payload: Record<string, unknown>
    }
    expect(rows[0].displayType).toBe("event")
    expect(activity.status).toBe("running")
    expect(activity.executionId).toBe("plan-exec-1")
    expect(activity.workspaceId).toBe("ws-1")
    expect(activity.payload).toMatchObject({
      workflowRun: true,
      system: true,
      workflowRef: "built-in/acceptance-plan",
      workflowName: "验收规划",
      phaseIndex: 1,
      roundIndex: 2,
    })
  })

  it("同一执行只落一张卡（重复调用幂等）", () => {
    getChatEventBridge().requestWorkflowRunCard(PLAN_CARD)
    getChatEventBridge().requestWorkflowRunCard(PLAN_CARD)
    expect(cards(db, "s-main")).toHaveLength(1)
  })

  it("legacy clone 线程不落卡", () => {
    db.prepare("UPDATE sessions SET clone_name = ? WHERE id = ?").run("clone-a", "s-main")
    getChatEventBridge().requestWorkflowRunCard(PLAN_CARD)
    expect(cards(db, "s-main")).toHaveLength(0)
  })

  it("任务没有主线程会话时不落卡", () => {
    insertTask(db, "t-2", null)
    getChatEventBridge().requestWorkflowRunCard({ ...PLAN_CARD, taskId: "t-2", executionId: "plan-exec-2" })
    expect(cards(db, "s-main")).toHaveLength(0)
  })
})

describe("ChatEventBridge.requestAcceptanceGuide", () => {
  let db: Database.Database
  let originalFetch: typeof fetch
  let originalWake: string | undefined

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    resetChatEventBridgeForTests()
    getChatEventBridge().attach(db)
    insertSession(db, "s-main", null)
    insertTask(db, "t-1", "s-main")
    originalFetch = global.fetch
    originalWake = process.env.OCTOPUS_CHAT_AUTO_WAKE
    delete process.env.OCTOPUS_CHAT_AUTO_WAKE
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalWake === undefined) delete process.env.OCTOPUS_CHAT_AUTO_WAKE
    else process.env.OCTOPUS_CHAT_AUTO_WAKE = originalWake
    db?.close()
    resetChatEventBridgeForTests()
  })

  // 2026-11-03：验收确认从文字提问变成了 AskUserQuestion 选项卡（8f0c0ee1 把
  // 主对话的 ask_user_question 事件接通后可见）。选项卡会打断逐场景引导，所以
  // 引导消息必须明确要求用对话正文提问。
  it("引导消息要求用对话正文提问，明确禁用 AskUserQuestion", async () => {
    const bodies: Array<Record<string, unknown>> = []
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return { ok: true, body: null } as unknown as Response
    }) as unknown as typeof fetch

    getChatEventBridge().requestAcceptanceGuide("t-1", {
      phaseIndex: 1,
      roundIndex: 2,
      caseCount: 2,
      checkCount: 3,
    })

    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    const message = String(bodies[0].message)
    expect(message).toContain("不要调用 AskUserQuestion")
    expect(message).toContain("get_acceptance_plan")
  })
})
