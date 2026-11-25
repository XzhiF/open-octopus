// packages/server/src/__tests__/chat-inject.test.ts
//
// 2026-11-23 用户 #8：
//   1. 后台任务（run_in_background 的 dev 服务）在跑、模型空闲等唤醒时，
//      会话不能被当成「忙」——用户消息经 POST /chat/inject 注进**同一条**
//      provider 查询，后台任务不被打断；
//   2. 注入开启的新一轮换一条新的 assistant 行，转录顺序是
//      「助手(前半) → 用户(追加) → 助手(回答)」；
//   3. 生成中 / 没有活跃流时 inject 一律 409，且消息不落库；
//   4. /running 暴露 phase（background-wait），客户端据此解锁输入。
//
// Anti-fake-run: 真 better-sqlite3 + applySchema，Hono app.request，mock provider。

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
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_chat_inject"
const SESSION = "s-inj-1"
const ROOT = path.join(os.tmpdir(), `chat-inject-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const CLAUDE_DIR = path.join(ROOT, "claude")
const AGENT_DIR = path.join(HOME, "agent")

let db: Database.Database
let sessionDAO: AgentSessionDAO
let behaviors: Array<"park" | "hang">

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      _prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options?: {
        abortSignal?: AbortSignal
        onInputChannel?: (push: (text: string) => boolean) => void
      },
    ) {
      const mode = behaviors.shift() ?? "hang"
      if (mode === "hang") {
        yield { type: "message_start", messageId: "m-hang" }
        yield { type: "text_delta", content: "正在跑…", messageId: "m-hang" }
        while (!options?.abortSignal?.aborted) {
          await new Promise((r) => setTimeout(r, 15))
        }
        return
      }

      // 'park'：首轮结束但后台任务还在 → 等注入；注入后跑第二轮。
      // 队列语义与真 provider 的输入流一致：任何时刻 push 都能收下。
      const pending: string[] = []
      let notify: (() => void) | null = null
      options?.onInputChannel?.((text) => {
        pending.push(text)
        notify?.()
        notify = null
        return true
      })
      yield { type: "background_tasks", tasks: [{ id: "bg-1", description: "dev server" }] }
      yield { type: "message_start", messageId: "m-1" }
      yield { type: "text_delta", content: "STARTED", messageId: "m-1" }
      yield { type: "result", content: "STARTED", sessionId: "sdk-inj-1" }

      const injected = await new Promise<string>((resolve) => {
        if (pending.length > 0) { resolve(pending.shift()!); return }
        notify = () => resolve(pending.shift()!)
      })
      yield { type: "message_start", messageId: "m-2" }
      yield { type: "text_delta", content: `PONG:${injected}`, messageId: "m-2" }
      yield { type: "result", content: `PONG:${injected}`, sessionId: "sdk-inj-1" }
      yield { type: "background_tasks", tasks: [] }
    },
  })) as never)
}

function app() {
  const a = new Hono()
  a.route("/api/agent", createChatRoutes({
    sessionDAO,
    safetyDAO: { insertSafetyEvent: vi.fn() } as never,
    scheduleConfigDAO: {} as never,
    tokenUsageDao: new TokenUsageDAO(db),
  }))
  return a
}

const HEADERS = { "Content-Type": "application/json", "X-Octopus-Org": ORG }

function chat(message: string) {
  return app().request(`/api/agent/sessions/${SESSION}/chat`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ message }),
  })
}

function inject(message: string) {
  return app().request(`/api/agent/sessions/${SESSION}/chat/inject`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ message }),
  })
}

function running() {
  return app().request(`/api/agent/sessions/${SESSION}/running`, { headers: HEADERS })
}

function stop() {
  return app().request(`/api/agent/sessions/${SESSION}/stop`, {
    method: "POST",
    headers: HEADERS,
  })
}

/** 读 SSE 直到累计文本里出现 `needle`；返回 reader 供继续读。 */
async function readUntil(res: Response, needle: string): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; text: string }> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let acc = ""
  while (!acc.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    acc += decoder.decode(value, { stream: true })
  }
  return { reader, text: acc }
}

/** 继续读同一个 reader 直到出现 `needle`。 */
async function readReaderUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder()
  let acc = ""
  while (!acc.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) acc += decoder.decode(value, { stream: true })
  }
  return acc
}

function userRows() {
  return db.prepare(
    "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC",
  ).all(SESSION) as Array<{ content: string }>
}

function assistantRows() {
  return db.prepare(
    "SELECT id, content, created_at, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC",
  ).all(SESSION) as Array<{ id: string; content: string; created_at: string; metadata: string | null }>
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
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM sessions").run()
  db.prepare("DELETE FROM session_prompt_snapshots").run()
  db.prepare("DELETE FROM session_expert_rosters").run()
  db.prepare("DELETE FROM session_role_states").run()
  db.prepare("DELETE FROM llm_calls").run()
  behaviors = []
  installProvider()
  initAgentService(sessionDAO, { insertSafetyEvent: vi.fn() } as never)
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION, title: "T", clone_name: null, session_type: "main",
    created_at: now, updated_at: now,
  })
})

afterEach(() => {
  delete process.env.OCTOPUS_HOME
  delete process.env.CLAUDE_CONFIG_DIR
  vi.restoreAllMocks()
})

afterAll(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { /* non-fatal */ }
  db.close()
})

describe("main chat — 后台等待期注入（#8）", () => {
  it("后台等待 → /running phase=background-wait；inject 202 且注入同一查询、换新 assistant 行", async () => {
    behaviors.push("park")
    const first = await chat("起个服务")
    expect(first.status).toBe(200)
    const { reader } = await readUntil(first, '"phase":"background-wait"')

    const probe = await running()
    const probeBody = (await probe.json()) as { running: boolean; phase: string }
    expect(probeBody.running).toBe(true)
    expect(probeBody.phase).toBe("background-wait")

    const injected = await inject("服务起来了吗？")
    expect(injected.status).toBe(202)
    expect(((await injected.json()) as { injected: boolean }).injected).toBe(true)

    // 第一条 SSE 继续把注入轮的回答送回来。
    await readReaderUntil(reader, "event: done")

    expect(userRows().map((u) => u.content)).toEqual(["起个服务", "服务起来了吗？"])
    const rows = assistantRows()
    expect(rows.map((r) => r.content)).toEqual(["STARTED", "PONG:服务起来了吗？"])
    // 前半行在注入时已收口（不再挂 streaming），顺序也早于用户消息之后的回答行。
    expect(rows[0].created_at <= rows[1].created_at).toBe(true)
    expect(JSON.parse(rows[0].metadata ?? "{}").streaming).toBeUndefined()
    try { await reader.cancel() } catch { /* already closed */ }
  })

  it("生成中（没有 background-wait）→ inject 409，消息不落库", async () => {
    behaviors.push("hang")
    const first = await chat("跑个长任务")
    const { reader } = await readUntil(first, "text_delta")

    const rejected = await inject("插一句")
    expect(rejected.status).toBe(409)
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe("STREAM_IN_PROGRESS")
    expect(userRows().map((u) => u.content)).toEqual(["跑个长任务"])

    await stop()
    try { await reader.cancel() } catch { /* already closed */ }
  })

  it("没有活跃流 → inject 409，消息不落库", async () => {
    const rejected = await inject("插一句")
    expect(rejected.status).toBe(409)
    expect(userRows()).toEqual([])
  })
})
