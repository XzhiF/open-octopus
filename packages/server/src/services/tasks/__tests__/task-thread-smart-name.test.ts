// packages/server/src/services/tasks/__tests__/task-thread-smart-name.test.ts
//
// 新建开发任务的 AI 标题（2026-10-29）：客户端先落「首条消息的确定性截串」，
// 首轮结束后服务端把它换成 AI 总结的标题 —— 但只在名字仍是那个截串时替换。
// 用户改过名（或任务本来就有名字）→ 永不覆盖。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../../../db/schema"
import { TaskDAO } from "../../../db/dao"
import { TaskThreadService } from "../task-thread-service"
import { derivedTaskNameFromMessage } from "../task-title"

const MESSAGE = "我想开发一个手机号注册的功能，供应商还没对接好，先抽象接口 mock 实现"
const DERIVED = derivedTaskNameFromMessage(MESSAGE)

let db: Database.Database

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
})

afterEach(() => {
  db.close()
})

function seedTask(name: string, sessionId = "s-thread-1"): TaskDAO {
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO sessions (id, title, session_type, created_at, updated_at) VALUES (?, '新会话', 'main', ?, ?)",
  ).run(sessionId, now, now)
  const dao = new TaskDAO(db)
  dao.insert({ id: "t-1", name, source_chat_session_id: sessionId })
  return dao
}

function service(generate: (message: string) => Promise<string | null>) {
  return new TaskThreadService({ db, generateTaskTitle: generate })
}

describe("TaskThreadService.maybeAdoptSmartTaskName", () => {
  it("名字仍是首条消息的截串 → 换成 AI 标题（异步落库）", async () => {
    const dao = seedTask(DERIVED)
    const calls: string[] = []
    const svc = service(async (message) => { calls.push(message); return "手机号验证码注册" })

    svc.maybeAdoptSmartTaskName("s-thread-1", MESSAGE)

    await vi.waitFor(() => expect(dao.getById("t-1")!.name).toBe("手机号验证码注册"))
    expect(calls).toEqual([MESSAGE])
  })

  it("用户改过名 → 不调用模型、不改名", async () => {
    const dao = seedTask("我自己的任务名")
    const generate = vi.fn(async () => "AI 标题")
    service(generate).maybeAdoptSmartTaskName("s-thread-1", MESSAGE)

    await new Promise((r) => setTimeout(r, 30))
    expect(generate).not.toHaveBeenCalled()
    expect(dao.getById("t-1")!.name).toBe("我自己的任务名")
  })

  it("生成期间用户改了名 → 回写时再查一次，不覆盖", async () => {
    const dao = seedTask(DERIVED)
    const svc = service(async () => {
      dao.updateAutosave("t-1", "用户中途改的名字")
      return "AI 标题"
    })

    svc.maybeAdoptSmartTaskName("s-thread-1", MESSAGE)

    await new Promise((r) => setTimeout(r, 30))
    expect(dao.getById("t-1")!.name).toBe("用户中途改的名字")
  })
})
