/**
 * 事项投递正文（2026-11-26 用户事故）：
 *   #IT-1 标题 18 字、正文 1368 字，投递消息只有标题 —— 汐音只能凭标题猜需求，
 *   回头问用户「你贴给我」。
 *
 * 钉住三层：
 *   1) 客户端带正文（shared 格式，单测在 packages/shared）；
 *   2) 服务端按 cabin_items 真源兜底：旧客户端只发标题时正文补进消息；
 *   3) 落库内容 = 喂给模型的内容（转录与实际输入不打架），事项标记 delivered。
 *
 * Anti-fake-run：真 better-sqlite3 + applySchema + 真 Hono 路由，只在 SDK 边界打桩。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createChatRoutes } from "../routes/agent/chat-routes"
import { initAgentService } from "../services/agent/agent-service"
import { getConfigManager } from "../services/agent/config-manager"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_chat_items"
const SESSION = "s-items-1"
const CABIN = "c-items"
const OTHER_CABIN = "c-items-other"
const ROOT = path.join(os.tmpdir(), `chat-items-delivery-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const CLAUDE_DIR = path.join(ROOT, "claude")
const AGENT_DIR = path.join(HOME, "agent")

let db: Database.Database
let sessionDAO: AgentSessionDAO
let lastPrompt = ""

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (prompt: string) {
      lastPrompt = prompt
      yield { type: "text_delta", content: "好的。" }
      yield { type: "result", content: "好的。", sessionId: "sdk-items-1" }
    },
  })) as never)
}

function app() {
  const a = new Hono()
  a.route(
    "/api/agent",
    createChatRoutes({
      sessionDAO,
      safetyDAO: { insertSafetyEvent: vi.fn() } as never,
      scheduleConfigDAO: {} as never,
      tokenUsageDao: new TokenUsageDAO(db),
    }),
  )
  return a
}

function chat(message: string, meta?: { via: "items"; itemIds: string[] }) {
  return app().request(`/api/agent/sessions/${SESSION}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message, ...(meta ? { meta } : {}) }),
  })
}

function insertCabin(id: string, name: string) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO cabins
       (id, name, path, requirements, status, mainline_strategy, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, name, path.join(ROOT, id), "", "active", "clean-main", 1, now, now)
}

function insertItem(
  cabinId: string,
  id: string,
  seq: number,
  title: string,
  body: string,
  status = "todo",
) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO cabin_items
       (id, cabin_id, seq, kind, status, title, body, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, cabinId, seq, "optimize", status, title, body, now, now)
}

function insertSession(cabinId: string | null) {
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION,
    title: "事项投递",
    clone_name: null,
    session_type: "main",
    cabin_id: cabinId,
    created_at: now,
    updated_at: now,
  })
}

function lastUserMessage(): { id: string; content: string; metadata: string | null } {
  return db.prepare(
    "SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
  ).get(SESSION) as { id: string; content: string; metadata: string | null }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
})

beforeEach(() => {
  fs.mkdirSync(path.join(AGENT_DIR, "memory"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "experiences"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "skills"), { recursive: true })
  fs.mkdirSync(path.join(CLAUDE_DIR, "projects"), { recursive: true })
  process.env.OCTOPUS_HOME = HOME
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR
  getConfigManager().clearCache()
  lastPrompt = ""

  for (const table of [
    "messages", "sessions", "session_prompt_snapshots", "session_expert_rosters",
    "session_role_states", "llm_calls", "cabin_items", "cabins",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run()
  }

  installProvider()
  initAgentService(sessionDAO, { insertSafetyEvent: vi.fn() } as never)
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  vi.restoreAllMocks()
})

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true })
  } catch {
    /* non-fatal */
  }
  db.close()
})

describe("事项投递 — 正文必须到模型手里", () => {
  it("旧客户端只发标题 → 服务端按库补全正文；落库 = 喂模型；事项标 delivered", async () => {
    const body = "现在需求是需要做 PC 端的密码登录，参考原来验证码登录的实现，通过 dubbo 接口引入 miyuan-user 的登录服务。"
    insertCabin(CABIN, "素材库v舱")
    insertSession(CABIN)
    insertItem(CABIN, "ci-1", 1, "开始第一个登录需求与环境说明", body)

    const res = await chat("处理这几条事项：\n- #IT-1 开始第一个登录需求与环境说明", {
      via: "items", itemIds: ["ci-1"],
    })
    await res.text()

    const msg = lastUserMessage()
    expect(msg.content).toContain(body)
    expect(msg.content).toContain("【事项正文 · 服务端按数据库补全】")
    expect(lastPrompt).toContain(body)

    const item = db.prepare("SELECT status, delivery_message_id FROM cabin_items WHERE id = ?").get("ci-1") as {
      status: string; delivery_message_id: string | null
    }
    expect(item.status).toBe("delivered")
    expect(item.delivery_message_id).toBe(msg.id)
  })

  it("客户端已带正文 → 原样落库，不追加补全块", async () => {
    const body = "长提交时间被截成「2026-11-23 ...」；按原型给时间列固定宽度。"
    insertCabin(CABIN, "事项舱")
    insertSession(CABIN)
    insertItem(CABIN, "ci-2", 2, "时间列太窄", body)

    const sent = `处理这几条事项：\n### #IT-2 时间列太窄（优化）\n${body}`
    const res = await chat(sent, { via: "items", itemIds: ["ci-2"] })
    await res.text()

    const msg = lastUserMessage()
    expect(msg.content).toBe(sent)
    expect(msg.content).not.toContain("服务端按数据库补全")
    expect(msg.metadata).toContain('"via":"items"')
  })

  it("跨舱事项 id 不会把别的舱正文带进来", async () => {
    insertCabin(CABIN, "本舱")
    insertCabin(OTHER_CABIN, "别舱")
    insertSession(CABIN)
    insertItem(OTHER_CABIN, "ci-x", 1, "别舱事项", "别舱的正文不该出现。")

    const sent = "处理这几条事项：\n- #IT-1 别舱事项"
    const res = await chat(sent, { via: "items", itemIds: ["ci-x"] })
    await res.text()

    expect(lastUserMessage().content).toBe(sent)
    expect(lastPrompt).not.toContain("别舱的正文不该出现。")
    const item = db.prepare("SELECT status FROM cabin_items WHERE id = ?").get("ci-x") as { status: string }
    expect(item.status).toBe("todo")
  })
})
