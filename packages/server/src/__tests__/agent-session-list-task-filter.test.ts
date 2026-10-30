// packages/server/src/__tests__/agent-session-list-task-filter.test.ts
//
// GET /api/agent/sessions（对话侧栏的「会话」列表）——任务线程会话过滤。
//
// 一个任务 = 一条主对话线程（tasks.source_chat_session_id）。这条会话属于任务行
// 本身，不属于「会话」列表；列表里再出现一次，用户会以为是两个对话。客户端的
// 侧栏也有一层过滤，但它依赖任务列表先到 —— 任务列表还在加载（或请求失败）时
// 过滤条件为空，四个任务线程就会全部掉进「会话」（2026-10-30 用户报告）。所以
// 必须在 DAO 的 SQL 里就把它们排除。
//
// 钉三件事：
//   1. 被任务绑定的会话不出现在 listSessions；
//   2. 未被绑定的会话照常出现；
//   3. 任务软删后，会话释放回列表（与 clone 会话列表同一规则）。
//
// 反虚假跑测试：真 better-sqlite3 + applySchema，SQL 断言。

import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao/agent-session-dao"

const ORG = "e2e-aslt"

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

function seedSession(db: Database.Database, id: string, title = id): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sessions (id, org, title, clone_name, session_type, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'main', ?, ?)`,
  ).run(id, ORG, title, now, now)
}

function seedTask(
  db: Database.Database,
  id: string,
  sessionId: string | null,
  deletedAt: string | null = null,
): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'draft', ?, '{}', '[]', '[]', '[]', '[]', NULL, 1, ?, ?, ?, NULL)
  `).run(id, ORG, `E2E_ASLT ${id}`, sessionId, deletedAt, now, now)
}

describe("AgentSessionDAO.listSessions — 任务线程会话过滤", () => {
  let db: Database.Database
  let dao: AgentSessionDAO

  beforeEach(() => {
    db = newDb()
    dao = new AgentSessionDAO(db)
  })

  it("被任务绑定的会话不出现在列表，未绑定的照常出现", () => {
    seedSession(db, "s-bound")
    seedSession(db, "s-free")
    seedTask(db, "t-1", "s-bound")

    const ids = dao.listSessions({ limit: 50 }).items.map((s) => s.id)
    expect(ids).toContain("s-free")
    expect(ids).not.toContain("s-bound")
  })

  it("任务软删后，会话释放回列表", () => {
    seedSession(db, "s-bound")
    seedTask(db, "t-1", "s-bound", new Date().toISOString())

    const ids = dao.listSessions({ limit: 50 }).items.map((s) => s.id)
    expect(ids).toContain("s-bound")
  })

  it("软删的任务不会把别的任务线程一起放回来", () => {
    seedSession(db, "s-a")
    seedSession(db, "s-b")
    seedTask(db, "t-a", "s-a")
    seedTask(db, "t-b", "s-b", new Date().toISOString())

    const ids = dao.listSessions({ limit: 50 }).items.map((s) => s.id)
    expect(ids).toContain("s-b")
    expect(ids).not.toContain("s-a")
  })

  it("分页数量按过滤后的集合计（不因被过滤行少给一条）", () => {
    seedSession(db, "s-bound-1")
    seedSession(db, "s-bound-2")
    seedSession(db, "s-free-1")
    seedSession(db, "s-free-2")
    seedTask(db, "t-1", "s-bound-1")
    seedTask(db, "t-2", "s-bound-2")

    const page = dao.listSessions({ limit: 2 })
    expect(page.items.map((s) => s.id).sort()).toEqual(["s-free-1", "s-free-2"])
    expect(page.has_more).toBe(false)
  })
})
