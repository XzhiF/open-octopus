// packages/server/src/__tests__/agent-session-list-cabin-filter.test.ts
//
// GET /api/agent/sessions（对话侧栏的「会话」列表）——舱主会话过滤。
//
// 作战舱的 orchestrator chat 是一个舱绑定的单线程（cabins.main_session_id），
// 入口是左栏的「作战舱」行，不是「会话」列表里的一行对话。以前它作为普通会话
// 出现在列表里，和左侧某个会话看起来「同步」，用户读成两个对话共用一份历史
// （2026-11-13 反馈）。所以与任务线程同一处理：DAO 的 SQL 直接排除。
//
// 钉三件事：
//   1. 舱主会话不出现在 listSessions；
//   2. 普通会话照常出现；
//   3. 任务线程 + 舱主会话两种过滤可同时生效，分页仍按过滤后的集合计。

import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao/agent-session-dao"

const ORG = "e2e-aslc"

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

function seedTask(db: Database.Database, id: string, sessionId: string | null): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'draft', ?, '{}', '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL)
  `).run(id, ORG, `E2E_ASLC ${id}`, sessionId, now, now)
}

function seedCabin(db: Database.Database, id: string, mainSessionId: string | null): void {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO cabins (id, name, path, main_session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(id, `E2E_ASLC ${id}`, `/tmp/${id}`, mainSessionId, now, now)
}

describe("AgentSessionDAO.listSessions — 舱主会话过滤", () => {
  let db: Database.Database
  let dao: AgentSessionDAO

  beforeEach(() => {
    db = newDb()
    dao = new AgentSessionDAO(db)
  })

  it("舱主会话不出现在列表，普通会话照常出现", () => {
    seedSession(db, "s-cabin-main")
    seedSession(db, "s-free")
    seedCabin(db, "c-1", "s-cabin-main")

    const ids = dao.listSessions({ limit: 50 }).items.map((s) => s.id)
    expect(ids).toContain("s-free")
    expect(ids).not.toContain("s-cabin-main")
  })

  it("舱还没绑主会话时（main_session_id NULL）不影响任何会话", () => {
    seedSession(db, "s-free")
    seedCabin(db, "c-1", null)

    const ids = dao.listSessions({ limit: 50 }).items.map((s) => s.id)
    expect(ids).toContain("s-free")
  })

  it("任务线程与舱主会话两种过滤可同时生效", () => {
    seedSession(db, "s-task")
    seedSession(db, "s-cabin-main")
    seedSession(db, "s-free")
    seedTask(db, "t-1", "s-task")
    seedCabin(db, "c-1", "s-cabin-main")

    const ids = dao.listSessions({ limit: 50 }).items.map((s) => s.id)
    expect(ids).toEqual(["s-free"])
  })

  it("分页数量按过滤后的集合计", () => {
    seedSession(db, "s-cabin-main")
    seedSession(db, "s-free-1")
    seedSession(db, "s-free-2")
    seedCabin(db, "c-1", "s-cabin-main")

    const page = dao.listSessions({ limit: 2 })
    expect(page.items.map((s) => s.id).sort()).toEqual(["s-free-1", "s-free-2"])
    expect(page.has_more).toBe(false)
  })
})
