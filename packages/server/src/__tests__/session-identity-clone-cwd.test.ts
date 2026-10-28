// packages/server/src/__tests__/session-identity-clone-cwd.test.ts
//
// 新建对话里选了分身（identity_clone）但没手动挑目录：会话要落在该分身自己的
// 工作区，而不是所有分身都挤在 Main Agent 的 cwd（需求 2026-10-28）。
// 分身目录在 ~/.octopus 下 —— 目录选择策略的黑名单，所以只写 cwd，不注册 workspace 行。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { WorkspaceDAO } from "../db/dao/workspace-dao"
import { createSessionRoutes } from "../routes/agent/sessions"
import { initSessionService } from "../services/agent/session-service"

const ORG = "E2E_TEST_identity_cwd"
const CLONE = "dev-clone"
const TEST_DIR = path.join(os.tmpdir(), `session-identity-cwd-${Date.now()}`)
const CLONE_DIR = path.join(TEST_DIR, "agent", "clones", CLONE)

let db: Database.Database

function post(body: Record<string, unknown>) {
  const app = new Hono()
  app.route("/api/agent", createSessionRoutes(new AgentSessionDAO(db)))
  return app.request("/api/agent/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify(body),
  })
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  initSessionService(new AgentSessionDAO(db))
  fs.mkdirSync(CLONE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(CLONE_DIR, "config.json"),
    JSON.stringify({ name: CLONE, display_name: "开发分身", type: "user" }),
  )
})

beforeEach(() => {
  db.prepare("DELETE FROM sessions").run()
  db.prepare("DELETE FROM workspaces").run()
  // getHome() 每次调用都读 env，所以逐条设；建会话与分身目录都落在临时 OCTOPUS_HOME 下。
  process.env.OCTOPUS_HOME = TEST_DIR
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
})

afterAll(() => {
  db.close()
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* non-fatal */ }
})

describe("POST /sessions — 分身默认工作区", () => {
  it("identity_clone 且未挑目录 → cwd = 分身自己的目录，不建 workspace 行", async () => {
    const res = await post({ identity_clone: CLONE })
    expect(res.status).toBe(201)
    const session = await res.json()

    expect(session.cwd).toBe(CLONE_DIR)
    expect(session.workspace_id).toBeNull()
    expect(session.clone_name).toBeNull()
    expect(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 0 })
  })

  it("显式选了工作空间 → 用户的选择优先，不被分身目录覆盖", async () => {
    const now = new Date().toISOString()
    const picked = {
      id: randomUUID(),
      name: "picked-repo",
      org: ORG,
      description: null,
      status: "active",
      path: path.join(TEST_DIR, "picked-repo"),
      source: "user",
      archive_status: null,
      created_at: now,
      updated_at: now,
    }
    new WorkspaceDAO(db).insert(picked)

    const session = await (await post({ workspace_id: picked.id, identity_clone: CLONE })).json()
    expect(session.workspace_id).toBe(picked.id)
    expect(session.cwd).toBe(picked.path)
  })

  it("分身不存在 → 回落 Main Agent 默认工作区（不 500）", async () => {
    const res = await post({ identity_clone: "ghost-clone" })
    expect(res.status).toBe(201)

    const session = await res.json()
    expect(session.workspace_id).not.toBeNull()
    expect(db.prepare("SELECT name FROM workspaces WHERE id = ?").get(session.workspace_id))
      .toEqual({ name: "main-agent" })
  })

  it("没选分身 → 维持原样：Main Agent 默认工作区", async () => {
    const session = await (await post({})).json()

    expect(session.workspace_id).not.toBeNull()
    expect(session.cwd).toBe(path.join(TEST_DIR, "agent"))
  })
})
