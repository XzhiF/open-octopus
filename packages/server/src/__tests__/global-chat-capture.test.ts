// packages/server/src/__tests__/global-chat-capture.test.ts
//
// billing-coverage-2 票03 —— 全局聊天 / Main Agent 入账与委托去重（US2/KD23）。
// Anti-fake-run：真实 better-sqlite3 + applySchema + 真实路由 + 真实 CloneRuntime，
// 只在 provider 边界 mock（getProvider.sendQuery 吐预置 chunk 流）——行数 = 真实
// provider 调用数由「第几次 sendQuery 被调」独立核对（callCounts），不以被测代码内部状态自证。
// cost 手算：{3,15,3.75,0.3}:1000×3+500×15+100×3.75+200×0.3=10935→0.010935；
//           {1,2,0.5,0.1}:400×1+200×2+50×0.5+25×0.1=827.5→0.0008275。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { BillingDAO } from "../db/dao/billing-dao"
import { globalChatRoutes } from "../routes/global-chat"
import { createMainAgentRoute } from "../routes/agent/main-agent-route"
import * as providers from "@octopus/providers"

const PRIMARY = "E2E_TEST_g-primary"
const SECONDARY = "E2E_TEST_g-secondary"
const ORG = "E2E_TEST_g-org"
const TEST_DIR = path.join(os.tmpdir(), `g-chat-capture-${Date.now()}`)

const USAGE_P = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheCreationTokens: 100 }
const USAGE_S = { inputTokens: 400, outputTokens: 200, cacheReadTokens: 25, cacheCreationTokens: 50 }

function resultChunk(model: string, usage = USAGE_P): Record<string, unknown> {
  return {
    type: "result", sessionId: "provider-sess-1",
    usage, modelUsages: [{ model, ...usage }],
  }
}

let db: Database.Database
let tokenDao: TokenUsageDAO
let sessionDAO: AgentSessionDAO
let sendQueryCalls: number
let streamQueue: Array<Array<Record<string, unknown>>>

function installProvider(chunks: Array<Array<Record<string, unknown>>>) {
  streamQueue = chunks
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* () {
      sendQueryCalls += 1
      const next = streamQueue.shift() ?? []
      for (const c of next) yield c
    },
  })) as never)
}

function llmRows(): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM llm_calls ORDER BY timestamp, call_index").all() as Array<Record<string, unknown>>
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tokenDao = new TokenUsageDAO(db)
  sessionDAO = new AgentSessionDAO(db)
  const billing = new BillingDAO(db)
  billing.createPrice({
    id: "OC-gp", vendor: "e2e", model_id: PRIMARY,
    input_unit_price: 3, output_unit_price: 15, cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
    currency: "USD",
  })
  billing.createPrice({
    id: "OC-gs", vendor: "e2e", model_id: SECONDARY,
    input_unit_price: 1, output_unit_price: 2, cache_write_unit_price: 0.5, cache_read_unit_price: 0.1,
    currency: "USD",
  })
})

beforeEach(() => {
  db.prepare("DELETE FROM llm_calls").run()
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM sessions").run()
  sendQueryCalls = 0
  // Main Agent 委托链需要 built-in clone 在盘可解析（同 delegate-mention 惯例）
  process.env.OCTOPUS_HOME = TEST_DIR
  for (const name of ["scheduler"]) {
    const dir = path.join(process.env.OCTOPUS_HOME, "agent", "built-in", name)
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true })
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ name, display_name: "定时任务管理", type: "built-in", skills: [], memoryScope: "shared" }), "utf-8")
    fs.writeFileSync(path.join(dir, "persona.md"), `# 定时任务管理\n\nPersona for ${name}`, "utf-8")
  }
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  vi.restoreAllMocks()
})

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* non-fatal */ }
  db.close()
})

// ── 全局聊天（routes/global-chat.ts） ─────────────────────────────

function globalChatApp() {
  const fakeChatService = {
    getSession: (id: string) => ({ id, workspaceId: "ws-g", provider: "claude", providerSessionId: null }),
    addMessage: (_id: string, m: Record<string, unknown>) => ({ id: `m-${String(m.content).length}`, ...m }),
    updateProviderSession: () => {},
  }
  const app = new Hono()
  app.route("/api/chat/global", globalChatRoutes({} as never, fakeChatService as never, tokenDao))
  return app
}

describe("全局聊天入账（global_chat）", () => {
  it("直发一轮（无委托）→ 恰一条 global_chat 行，session/org 归属正确，cost 手算一致", async () => {
    installProvider([[{ type: "text_delta", content: "ok" }, resultChunk(PRIMARY)]])
    const app = globalChatApp()
    const res = await app.request("/api/chat/global/sessions/gc-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({ content: "E2E_TEST hello" }),
    })
    await res.text()

    expect(sendQueryCalls).toBe(1)
    const rows = llmRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source_path: "global_chat",
      session_id: "gc-1",
      org: ORG,
      workspace_id: "ws-g",
      model: PRIMARY,
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
      price_status: "priced",
      cost_usd: expect.closeTo(0.010935, 6),
    })
    // 聊天行无执行链路 → 归属列如实 NULL（KD17）
    expect(rows[0].node_execution_id).toBeNull()
    expect(rows[0].execution_id).toBeNull()
  })

  it("error-only 流（无 result）→ 零行（有真值才记）", async () => {
    installProvider([[{ type: "text_delta", content: "half" }, { type: "error", code: "X", message: "boom" }]])
    const app = globalChatApp()
    const res = await app.request("/api/chat/global/sessions/gc-2/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "E2E_TEST err" }),
    })
    await res.text()
    expect(llmRows()).toHaveLength(0)
  })
})

// ── Main Agent 统一入口 + 委托去重（routes/agent/main-agent-route.ts） ──

function mainApp() {
  const app = new Hono()
  app.route("/api/agent", createMainAgentRoute({ sessionDAO, tokenUsageDao: tokenDao }))
  return app
}

function makeSession(id: string, cloneName: string | null) {
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id, org: ORG, title: "T", clone_name: cloneName, session_type: "main",
    created_at: now, updated_at: now,
  })
}

async function mainChat(app: Hono, body: Record<string, unknown>) {
  const res = await app.request("/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify(body),
  })
  await res.text()
  return res
}

describe("Main Agent 入账与委托去重（US2/KD23）", () => {
  it("统一入口直答（无委托）→ 恰一条 global_chat 行", async () => {
    makeSession("ma-1", null)
    installProvider([[{ type: "text_delta", content: "direct answer" }, resultChunk(PRIMARY)]])
    await mainChat(mainApp(), { message: "E2E_TEST direct", session_id: "ma-1" })

    expect(sendQueryCalls).toBe(1)
    const rows = llmRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source_path: "global_chat", session_id: "ma-1", org: ORG, model: PRIMARY,
      cost_usd: expect.closeTo(0.010935, 6),
    })
  })

  it("@@mention 委托（无自引用）→ Main 不产生路由调用，恰一条 clone_chat 行归分身（node_id=clone）", async () => {
    makeSession("ma-2", "workspace")
    installProvider([[{ type: "text_delta", content: "clone answer" }, resultChunk(SECONDARY, USAGE_S)]])
    await mainChat(mainApp(), { message: "E2E_TEST @scheduler do it", session_id: "ma-2", delegate_to: "scheduler" })

    expect(sendQueryCalls).toBe(1) // Main Agent 路由轮未发起 provider 调用 → 不该有 global_chat 行
    const rows = llmRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source_path: "clone_chat", session_id: "ma-2", org: ORG,
      node_id: "scheduler", model: SECONDARY,
      cost_usd: expect.closeTo(0.0008275, 6),
    })
  })

  it("工具化委托（delegate_to_*）→ Main 路由轮 + 分身应答轮各一行，行数=真实调用数=2，无双计", async () => {
    makeSession("ma-3", null)
    installProvider([
      [ // main 路由轮：发起 delegate 工具调用 + 自身 result（真实调用 #1）
        { type: "tool_call_start", toolCallId: "tc1", toolName: "delegate_to_scheduler" },
        { type: "tool_call", toolCallId: "tc1", toolName: "delegate_to_scheduler", toolInput: { task: "cron please" } },
        { type: "tool_result", toolCallId: "tc1", toolName: "delegate_to_scheduler", content: "ok" },
        resultChunk(PRIMARY),
      ],
      [ // 分身应答轮（真实调用 #2，经 CloneRuntime 同一 provider 边界）
        { type: "text_delta", content: "delegated answer" },
        resultChunk(SECONDARY, USAGE_S),
      ],
    ])
    await mainChat(mainApp(), { message: "E2E_TEST delegate via tool", session_id: "ma-3" })

    expect(sendQueryCalls).toBe(2) // 独立计数：两次真实 provider 调用（KD23）
    const rows = llmRows()
    expect(rows).toHaveLength(2)
    expect(rows.filter(r => r.source_path === "global_chat")).toHaveLength(1)
    expect(rows.filter(r => r.source_path === "clone_chat")).toHaveLength(1)
    expect(rows.every(r => r.session_id === "ma-3" && r.org === ORG)).toBe(true)
    const costs = rows.map(r => Number(r.cost_usd)).sort((a, b) => a - b)
    expect(costs[0]).toBeCloseTo(0.0008275, 6)
    expect(costs[1]).toBeCloseTo(0.010935, 6)
  })

  it("多轮：同一会话两轮各一次直答 → 两行，一 chunk 一行不叠写", async () => {
    makeSession("ma-4", null)
    installProvider([[resultChunk(PRIMARY)]])
    await mainChat(mainApp(), { message: "E2E_TEST r1", session_id: "ma-4" })
    installProvider([[resultChunk(SECONDARY)]])
    await mainChat(mainApp(), { message: "E2E_TEST r2", session_id: "ma-4" })
    const rows = llmRows()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.id)).size).toBe(2)
    expect(rows.every(r => r.source_path === "global_chat" && r.session_id === "ma-4")).toBe(true)
  })
})
