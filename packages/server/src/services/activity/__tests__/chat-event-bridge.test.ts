import { describe, it, expect, beforeEach, afterEach } from "vitest"
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
