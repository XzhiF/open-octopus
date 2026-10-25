// Main-chat cache contract:
//   1. native resume: result.sessionId is persisted and replayed next turn;
//   2. the system prompt is frozen per session (memory drift must not touch it);
//   3. a dead resume pointer degrades to a cold turn (and is cleared);
//   4. a resume failure is retried once without resume.

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
import { hashPrompt, SessionCacheContextDAO } from "../db/dao/session-cache-context-dao"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_chat_resume"
const ROOT = path.join(os.tmpdir(), `chat-resume-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const CLAUDE_DIR = path.join(ROOT, "claude")
const AGENT_DIR = path.join(HOME, "agent")

interface CallRecord {
  prompt: string
  resume: string | undefined
  append: string
  agents: string[]
}

interface Behavior {
  failOnResume?: boolean
  sessionId?: string
}

let db: Database.Database
let sessionDAO: AgentSessionDAO
let calls: CallRecord[]
let behaviors: Behavior[]

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      prompt: string,
      _cwd: string,
      resume: string | undefined,
      options: Record<string, unknown>,
    ) {
      const sys = options.systemPrompt as { append?: string } | undefined
      const agents = options.agents as Record<string, unknown> | undefined
      calls.push({
        prompt,
        resume,
        append: sys?.append ?? "",
        agents: Object.keys(agents ?? {}),
      })
      const behavior = behaviors.shift() ?? {}
      if (behavior.failOnResume && resume) {
        throw new Error(`No conversation found with session ID: ${resume}`)
      }
      yield { type: "text_delta", content: "ok" }
      yield {
        type: "result",
        content: "ok",
        sessionId: behavior.sessionId ?? "sdk-1",
      }
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

function chat(message: string) {
  return app().request("/api/agent/sessions/s-1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message }),
  })
}

function writeTranscript(sessionId: string) {
  const dir = path.join(CLAUDE_DIR, "projects", "-tmp-agent")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "")
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  sessionDAO = new AgentSessionDAO(db)
})

beforeEach(() => {
  fs.mkdirSync(path.join(AGENT_DIR, "memory"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "experiences"), { recursive: true })
  fs.mkdirSync(path.join(CLAUDE_DIR, "projects"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "skills"), { recursive: true })
  process.env.OCTOPUS_HOME = HOME
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR
  db.prepare("DELETE FROM messages").run()
  db.prepare("DELETE FROM sessions").run()
  db.prepare("DELETE FROM session_prompt_snapshots").run()
  db.prepare("DELETE FROM session_expert_rosters").run()
  db.prepare("DELETE FROM session_role_states").run()
  db.prepare("DELETE FROM llm_calls").run()
  calls = []
  behaviors = []
  installProvider()
  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: "s-1", org: ORG, title: "T", clone_name: null, session_type: "main",
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

describe("main chat — native resume + frozen system prompt", () => {
  it("persists the provider session and resumes it on the next turn", async () => {
    const first = await chat("hello")
    expect(first.status).toBe(200)
    await first.text()

    expect(calls).toHaveLength(1)
    expect(calls[0].resume).toBeUndefined()
    expect(sessionDAO.findById("s-1")?.provider_session_id).toBe("sdk-1")

    writeTranscript("sdk-1")
    const second = await chat("again")
    expect(second.status).toBe(200)
    await second.text()

    expect(calls).toHaveLength(2)
    expect(calls[1].resume).toBe("sdk-1")
  })

  it("freezes the system prompt even when memory changes between turns", async () => {
    const ltPath = path.join(AGENT_DIR, "memory", "long-term.md")
    fs.writeFileSync(ltPath, "# 长期记忆\n\nsnapshot-v1")
    const first = await chat("hello")
    await first.text()

    const append1 = calls[0].append
    expect(append1).toContain("snapshot-v1")
    const hash1 = sessionDAO.getDb()
      .prepare("SELECT prompt_hash FROM session_prompt_snapshots WHERE session_id = ?")
      .get("s-1") as { prompt_hash: string }
    expect(hash1.prompt_hash).toBe(hashPrompt(append1))

    // Another session appends to shared memory — the resumed session must not
    // rebuild (that would invalidate the provider's cached transcript).
    fs.writeFileSync(ltPath, "# 长期记忆\n\nsnapshot-v2")
    writeTranscript("sdk-1")
    const second = await chat("again")
    await second.text()

    expect(calls[1].resume).toBe("sdk-1")
    expect(calls[1].append).toBe(append1)
    expect(calls[1].append).not.toContain("snapshot-v2")
    const hash2 = sessionDAO.getDb()
      .prepare("SELECT prompt_hash FROM session_prompt_snapshots WHERE session_id = ?")
      .get("s-1") as { prompt_hash: string }
    expect(hash2.prompt_hash).toBe(hash1.prompt_hash)
  })

  it("treats a pointer with no local transcript as cold and clears it", async () => {
    sessionDAO.updateProviderSession("s-1", "missing-sdk")
    behaviors.push({ sessionId: "sdk-fresh" })

    const res = await chat("hello")
    await res.text()

    expect(calls[0].resume).toBeUndefined()
    expect(sessionDAO.findById("s-1")?.provider_session_id).toBe("sdk-fresh")
  })

  it("retries once without resume when the provider rejects the session", async () => {
    sessionDAO.updateProviderSession("s-1", "sdk-stale")
    writeTranscript("sdk-stale")
    behaviors.push({ failOnResume: true }, { sessionId: "sdk-new" })

    const res = await chat("hello")
    const body = await res.text()

    // First attempt resumed the stale id and threw; the retry went cold.
    expect(calls).toHaveLength(2)
    expect(calls[0].resume).toBe("sdk-stale")
    expect(calls[1].resume).toBeUndefined()
    expect(body).toContain("ok")
    expect(sessionDAO.findById("s-1")?.provider_session_id).toBe("sdk-new")
  })

  it("delivers a role card once and keeps the system prompt/tools stable", async () => {
    const dao = new SessionCacheContextDAO(db)
    dao.setActiveExpert("s-1", "engineering-sre")

    const first = await chat("@产品经理 帮我看下这个方案")
    await first.text()

    // Role card + @ dispatch reminder ride the user message.
    expect(calls[0].prompt).toContain('name="SRE"')
    expect(calls[0].prompt).toContain("<expert id=\"engineering-sre\"")
    expect(calls[0].prompt).toContain("用户本轮通过 @ 指定了以下专家：产品经理")
    // Full stable roster is registered → @ never mutates `agents` per turn.
    expect(calls[0].agents).toEqual(expect.arrayContaining(["product-manager", "engineering-sre"]))
    expect(calls[0].agents.length).toBeGreaterThanOrEqual(10)
    // System prompt does not carry the persona.
    expect(calls[0].append).not.toContain('name="SRE"')

    // Role revision is marked delivered after a successful result.
    expect(dao.getRoleState("s-1")).toMatchObject({ activeExpert: "engineering-sre", revision: 1, deliveredRevision: 1 })

    writeTranscript("sdk-1")
    const second = await chat("继续")
    await second.text()
    // No replay of the card, no system-prompt change.
    expect(calls[1].prompt).not.toContain("<expert id=")
    expect(calls[1].append).toBe(calls[0].append)
    expect(calls[1].agents).toEqual(calls[0].agents)

    // Switching identity appends a new card; the cached prefix stays identical.
    dao.setActiveExpert("s-1", "engineering-code-reviewer")
    const third = await chat("再看看代码")
    await third.text()
    expect(calls[2].prompt).toContain('name="代码审查员"')
    expect(calls[2].prompt).not.toContain('name="SRE"')
    expect(calls[2].append).toBe(calls[0].append)
    expect(calls[2].agents).toEqual(calls[0].agents)
  })

  it("@expert dispatches a subagent without changing the session identity", async () => {
    const res = await chat("@代码审查员 检查一下边界条件")
    await res.text()

    expect(calls[0].prompt).toContain("用户本轮通过 @ 指定了以下专家：代码审查员")
    expect(calls[0].agents).toEqual(expect.arrayContaining(["engineering-code-reviewer"]))
    const role = new SessionCacheContextDAO(db).getRoleState("s-1")
    expect(role.activeExpert).toBeNull()
    expect(role.revision).toBe(0)
  })
})
