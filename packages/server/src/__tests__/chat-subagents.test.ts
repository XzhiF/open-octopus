// packages/server/src/__tests__/chat-subagents.test.ts
//
// ① 子代理 chunk → subagent_runs（作业坞「子代理」列表 / 详情端点）；
// ② 后台唤醒轮：SDK 每个 result 给的是整个 query 的**累计** modelUsage，
//    逐 result 入账会重复记账 —— 这里验证账本只记增量（末轮累计 = 账本合计）。

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
import { initSessionService } from "../services/agent/session-service"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_chat-subagents"
const TEST_DIR = path.join(os.tmpdir(), `chat-subagents-${Date.now()}`)

let db: Database.Database
let tokenDao: TokenUsageDAO
let sessionDAO: AgentSessionDAO

function installProvider(chunks: Array<Record<string, unknown>>) {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* () {
      for (const chunk of chunks) yield chunk
    },
  })) as never)
}

function app() {
  const a = new Hono()
  a.route("/api/agent", createChatRoutes({
    sessionDAO,
    safetyDAO: { insertSafetyEvent: vi.fn() } as never,
    scheduleConfigDAO: {} as never,
    tokenUsageDao: tokenDao,
  }))
  return a
}

function chat() {
  return app().request("/api/agent/sessions/s-1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ system_prompt: "test", message: "hi" }),
  })
}

function ledgerTotals() {
  return db.prepare(`
    SELECT COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheRead
    FROM llm_calls WHERE source_path = 'global_chat'
  `).get() as { input: number; output: number; cacheRead: number }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tokenDao = new TokenUsageDAO(db)
  sessionDAO = new AgentSessionDAO(db)
  initSessionService(sessionDAO)
})

beforeEach(() => {
  db.prepare("DELETE FROM llm_calls").run()
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM subagent_runs").run()
  db.prepare("DELETE FROM sessions").run()
  process.env.OCTOPUS_HOME = TEST_DIR
  fs.mkdirSync(path.join(TEST_DIR, "agent", "memory"), { recursive: true })
  fs.mkdirSync(path.join(TEST_DIR, "agent", "experiences"), { recursive: true })
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: "s-1", repo_group: ORG, title: "T", clone_name: null, session_type: "main",
    created_at: now, updated_at: now,
  })
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  vi.restoreAllMocks()
})

afterAll(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* non-fatal */ }
})

describe("主对话 · 子代理作业", () => {
  it("subagent chunk → 列表与详情端点（prompt / 日志 / 最终汇报）", async () => {
    installProvider([
      { type: 'subagent', event: {
        id: 'agent-1', parentToolUseId: 'tu-1', agentType: 'general-purpose',
        description: '审查登录模块', prompt: '审查登录模块的鉴权边界',
        phase: 'started', status: 'running', sdkSessionId: 'sdk-1',
      } },
      { type: 'subagent', event: {
        id: 'agent-1', phase: 'log',
        blocks: [
          { kind: 'tool_use', toolName: 'Grep', toolUseId: 't1', input: { pattern: 'auth' } },
          { kind: 'tool_result', toolUseId: 't1', content: 'src/auth.ts' },
        ],
      } },
      { type: 'subagent', event: {
        id: 'agent-1', phase: 'completed', status: 'completed',
        summary: '鉴权边界正常', toolUses: 1, durationMs: 2600,
      } },
      { type: 'result', content: '好的', sessionId: 'sdk-1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    ])

    const res = await chat()
    expect(res.status).toBe(200)
    await res.text()

    const list = await app().request("/api/agent/sessions/s-1/subagents")
    expect(list.status).toBe(200)
    const { runs } = await list.json() as { runs: Array<Record<string, unknown>> }
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      id: 'agent-1',
      agent_type: 'general-purpose',
      description: '审查登录模块',
      prompt: '审查登录模块的鉴权边界',
      status: 'completed',
      summary: '鉴权边界正常',
      step_count: 2,
    })

    const detail = await app().request("/api/agent/sessions/s-1/subagents/agent-1")
    expect(detail.status).toBe(200)
    const { run } = await detail.json() as { run: { steps: Array<{ kind: string }> } }
    expect(run.steps.map((s) => s.kind)).toEqual(['tool_use', 'tool_result'])
  })

  it("后台唤醒轮只记增量：账本合计 = 末轮累计值（不重复记账）", async () => {
    installProvider([
      // 首轮：有后台任务在跑 → 收轮后继续消费
      { type: 'background_tasks', tasks: [{ id: 'bg-1', description: 'mvn build' }] },
      { type: 'result', content: '先跑着', sessionId: 'sdk-1',
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 0 },
        modelUsages: [{ model: 'm', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 0 }] },
      // 后台结束 → 唤醒续轮，result 是**整个 query 的累计**
      { type: 'background_tasks', tasks: [] },
      { type: 'message_start', messageId: 'm2' },
      { type: 'text_delta', content: '跑完了', messageId: 'm2' },
      { type: 'result', content: '跑完了', sessionId: 'sdk-1',
        usage: { inputTokens: 160, outputTokens: 80, cacheReadTokens: 30, cacheCreationTokens: 0 },
        modelUsages: [{ model: 'm', inputTokens: 160, outputTokens: 80, cacheReadTokens: 30, cacheCreationTokens: 0 }] },
    ])

    const res = await chat()
    expect(res.status).toBe(200)
    await res.text()

    // 旧行为会记成 100+160 / 50+80；正确行为只记累计增量（= 末轮累计）。
    expect(ledgerTotals()).toEqual({ input: 160, output: 80, cacheRead: 30 })
  })
})
