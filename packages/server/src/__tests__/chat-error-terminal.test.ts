// packages/server/src/__tests__/chat-error-terminal.test.ts
//
// P0-3 契约（2026-11-01）：
//   1. 每一轮 SSE 的最后一帧恰好是 done 或 error；
//   2. 失败必须落一条持久 assistant 行（metadata.error），不再伪装成
//      「收到消息…」的 fallback 正文，也不会 partial + fallback 双气泡；
//   3. 心跳出现在中间，done/error 之后不再有心跳；
//   4. 用户停止仍是 interrupted 行，不是 error、不是 fallback。
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
import { createChatRoutes, type ChatRouteDeps } from "../routes/agent/chat-routes"
import { initAgentService } from "../services/agent/agent-service"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_chat_terminal"
const SESSION = "s-terminal-1"
const ROOT = path.join(os.tmpdir(), `chat-terminal-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const CLAUDE_DIR = path.join(ROOT, "claude")
const AGENT_DIR = path.join(HOME, "agent")

let db: Database.Database
let sessionDAO: AgentSessionDAO
/** Consumed once per chat() call. */
let behaviors: Array<"throw" | "idle-error" | "finish" | "slow-finish" | "hang">

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      _prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options?: { abortSignal?: AbortSignal },
    ) {
      const mode = behaviors.shift() ?? "finish"
      if (mode === "throw") {
        throw new Error("boom: provider exploded")
      }
      if (mode === "idle-error") {
        yield { type: "error", code: "IDLE_TIMEOUT", message: "模型流已 300000ms 没有新事件" }
        return
      }
      if (mode === "slow-finish") {
        await new Promise((r) => setTimeout(r, 40))
        yield { type: "text_delta", content: "慢一点" }
        yield { type: "result", content: "慢一点", sessionId: "sdk-slow" }
        return
      }
      if (mode === "hang") {
        yield { type: "text_delta", content: "半句输出" }
        while (!options?.abortSignal?.aborted) {
          await new Promise((r) => setTimeout(r, 15))
          if (options?.abortSignal?.aborted) break
          yield { type: "text_delta", content: "…" }
        }
        return
      }
      yield { type: "text_delta", content: "Hello" }
      yield { type: "result", content: "Hello", sessionId: "sdk-1" }
    },
  })) as never)
}

function app(overrides: Partial<ChatRouteDeps> = {}) {
  const a = new Hono()
  a.route("/api/agent", createChatRoutes({
    sessionDAO,
    safetyDAO: { insertSafetyEvent: vi.fn() } as never,
    scheduleConfigDAO: {} as never,
    tokenUsageDao: new TokenUsageDAO(db),
    ...overrides,
  }))
  return a
}

const HEADERS = { "Content-Type": "application/json", "X-Octopus-Org": ORG }

function chat(message: string, overrides?: Partial<ChatRouteDeps>) {
  return app(overrides).request(`/api/agent/sessions/${SESSION}/chat`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ message }),
  })
}

function stop() {
  return app().request(`/api/agent/sessions/${SESSION}/stop`, {
    method: "POST",
    headers: HEADERS,
  })
}

function parseFrames(text: string): Array<{ event: string; data: any }> {
  const frames: Array<{ event: string; data: any }> = []
  for (const block of text.split("\n\n")) {
    const event = /^event: (.+)$/m.exec(block)?.[1]
    const raw = /^data: (.*)$/m.exec(block)?.[1]
    if (!event || raw === undefined) continue
    try { frames.push({ event, data: JSON.parse(raw) }) } catch { frames.push({ event, data: raw }) }
  }
  return frames
}

function assistantRows() {
  return db.prepare(
    "SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC",
  ).all(SESSION) as Array<{ id: string; content: string; metadata: string | null }>
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

describe("main chat — terminal frame + persisted error", () => {
  it("a thrown provider error settles with `error` and persists an error row (no fallback)", async () => {
    behaviors.push("throw")
    const res = await chat("你好")
    expect(res.status).toBe(200)
    const frames = parseFrames(await res.text())

    const last = frames.at(-1)
    expect(last?.event).toBe("error")
    expect(last?.data.code).toBe("PROVIDER_ERROR")
    expect(last?.data.message).toContain("boom")
    // The canned fallback must be gone.
    expect(frames.some((f) => f.event === "done")).toBe(false)
    expect(frames.some((f) => f.event === "text_delta")).toBe(false)

    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("")
    const meta = JSON.parse(rows[0].metadata ?? "{}")
    expect(meta.error?.code).toBe("PROVIDER_ERROR")
    expect(meta.streaming).toBeUndefined()
  })

  it("an error chunk (IDLE_TIMEOUT) is terminal, retryable, and persisted", async () => {
    behaviors.push("idle-error")
    const res = await chat("你好")
    const frames = parseFrames(await res.text())

    const last = frames.at(-1)
    expect(last?.event).toBe("error")
    expect(last?.data.code).toBe("IDLE_TIMEOUT")

    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    const meta = JSON.parse(rows[0].metadata ?? "{}")
    expect(meta.error).toMatchObject({ code: "IDLE_TIMEOUT", retryable: true })
  })

  it("a successful turn still ends with `done` and has no error row", async () => {
    behaviors.push("finish")
    const res = await chat("你好")
    const frames = parseFrames(await res.text())

    expect(frames.at(-1)?.event).toBe("done")
    expect(frames.some((f) => f.event === "error")).toBe(false)

    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toBe("Hello")
    expect(JSON.parse(rows[0].metadata ?? "{}").error).toBeUndefined()
  })

  it("heartbeats appear mid-turn and never after the terminal frame", async () => {
    behaviors.push("slow-finish")
    const res = await chat("你好", { heartbeatMs: 10 })
    const frames = parseFrames(await res.text())

    const names = frames.map((f) => f.event)
    const doneAt = names.lastIndexOf("done")
    expect(doneAt).toBeGreaterThanOrEqual(0)
    expect(names.slice(0, doneAt)).toContain("heartbeat")
    expect(names.slice(doneAt + 1)).not.toContain("heartbeat")
    expect(names.filter((n) => n === "done" || n === "error")).toHaveLength(1)
  })

  it("stop still finalizes as interrupted — not an error, not a fallback", async () => {
    behaviors.push("hang")
    const res = await chat("写一篇长文")
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let acc = ""
    while (!acc.includes("text_delta")) {
      const { value, done } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
    }

    const stopped = await stop()
    expect(stopped.status).toBe(200)
    // Drain the rest so the route's finally completes.
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }

    const rows = assistantRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].content).toContain("半句输出")
    const meta = JSON.parse(rows[0].metadata ?? "{}")
    expect(meta.interrupted).toBe(true)
    expect(meta.error).toBeUndefined()
    expect(rows.some((r) => r.content.includes("Claude SDK 未配置"))).toBe(false)
  })
})
