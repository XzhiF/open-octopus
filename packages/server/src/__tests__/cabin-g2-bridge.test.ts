// Cabin P3（G2/C4/C6）：舱任务的卡/wake 汇聚舱主会话，
// 且高信号经 hook 落派发账本审计。
//
// 2026-11-14 用户口径修订：运行态卡改落**任务自己的 chat**（task thread），舱主
// 会话只保留 wake/账本 —— 否则任务 chat 看不到工作流状态，舱 chat 把同一次执行
// 重复画几遍。本文件同时钉住这两半。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { getChatEventBridge, resetChatEventBridgeForTests } from "../services/activity/chat-event-bridge"
import type { SSEService } from "../services/sse"

const NOW = "2026-11-12T10:00:00.000Z"

let db: Database.Database
let emit: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>
let signals: Array<{ taskId: string; status: string }>

function insertSession(id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES (?, 'org', ?, NULL, 'main', 1, 0, ?, ?)
  `).run(id, id, NOW, NOW)
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  db.prepare(`
    INSERT INTO cabins (id, name, path, status, main_session_id, version, created_at, updated_at)
    VALUES ('c1', '测试舱', 'C:/tmp/cabin-g2', 'active', 's-cabin', 1, ?, ?)
  `).run(NOW, NOW)
  insertSession("s-cabin")
  insertSession("s-task")
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, cabin_id, created_at, updated_at)
    VALUES ('t1', 'org', '舱任务', 'running', 's-task', '{"format":"v4"}', 'c1', ?, ?)
  `).run(NOW, NOW)
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, created_at, updated_at)
    VALUES ('t2', 'org', '普通任务', 'running', 's-task', '{"format":"v4"}', ?, ?)
  `).run(NOW, NOW)
})

afterAll(() => db.close())

beforeEach(() => {
  resetChatEventBridgeForTests()
  db.prepare("DELETE FROM messages").run()
  emit = vi.fn()
  signals = []
  fetchMock = vi.fn(async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  }))
  vi.stubGlobal("fetch", fetchMock)
  const bridge = getChatEventBridge()
  bridge.attach(db)
  bridge.attachSse({ emit } as unknown as SSEService)
  bridge.setCabinSignalHook((taskId, status) => { signals.push({ taskId, status }) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function cards(sessionId: string): Array<Record<string, unknown>> {
  return db.prepare("SELECT metadata FROM messages WHERE session_id = ? ORDER BY rowid")
    .all(sessionId)
    .map((r) => JSON.parse((r as { metadata: string }).metadata) as Record<string, unknown>)
}

describe("舱任务的路由（2026-11-14 修订）", () => {
  it("舱任务卡落任务自己的 chat，wake 仍汇聚舱主会话", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "awaiting_review" } })
    expect(cards("s-task")).toHaveLength(1)
    expect(cards("s-cabin")).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/sessions/s-cabin/chat")
  })

  it("暂停/继续落任务 chat，且是轻量转场卡（runState，不再重复运行摘要）", () => {
    const bridge = getChatEventBridge()
    bridge.notifyTaskRunState("t1", "e1", "running")
    bridge.notifyTaskRunState("t1", "e1", "paused")
    expect(cards("s-cabin")).toHaveLength(0)
    const rows = cards("s-task") as Array<{ activity?: { payload?: { runState?: string } } }>
    expect(rows).toHaveLength(2)
    expect(rows[0].activity?.payload?.runState).toBe("resumed")
    expect(rows[1].activity?.payload?.runState).toBe("paused")
  })

  it("高信号经 hook 落审计（attention），普通状态不落", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "ready" } })
    expect(signals).toHaveLength(0)
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "awaiting_review" } })
    expect(signals).toEqual([{ taskId: "t1", status: "awaiting_review" }])
    bridge.handleSse({ event: "task_status", data: { task_id: "t1", status: "done" } })
    expect(signals).toHaveLength(2)
    expect(signals[1].status).toBe("done")
  })

  it("无舱任务保持原路由（回归）", () => {
    const bridge = getChatEventBridge()
    bridge.handleSse({ event: "task_status", data: { task_id: "t2", status: "awaiting_review" } })
    expect(cards("s-task")).toHaveLength(1)
    expect(cards("s-cabin")).toHaveLength(0)
    expect(signals).toHaveLength(0)
  })
})
