/**
 * Chat-route wiring for the in-process memory tools.
 *
 * Pins the scope decision: free main chats mount `octopus-memory`; task threads
 * do not (their write surface is owned by the path guard).
 *
 * Anti-fake-run: real better-sqlite3 + applySchema, Hono app.request, provider
 * stubbed only at the SDK boundary so the route's real assembly path runs.
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

const ORG = "E2E_TEST_chat_memory_tool"
const SESSION = "s-mem-1"
const ROOT = path.join(os.tmpdir(), `chat-memory-tool-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const CLAUDE_DIR = path.join(ROOT, "claude")
const AGENT_DIR = path.join(HOME, "agent")

let db: Database.Database
let sessionDAO: AgentSessionDAO
let captured: Array<{ mcpServers?: Record<string, unknown> }>

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      _prompt: string,
      _cwd: string,
      _resume: string | undefined,
      options?: { mcpServers?: Record<string, unknown> },
    ) {
      captured.push({ mcpServers: options?.mcpServers })
      yield { type: "text_delta", content: "好的。" }
      yield { type: "result", content: "好的。", sessionId: "sdk-mem-1" }
    },
  })) as never)
}

function app(taskThread?: unknown) {
  const a = new Hono()
  a.route(
    "/api/agent",
    createChatRoutes({
      sessionDAO,
      safetyDAO: { insertSafetyEvent: vi.fn() } as never,
      scheduleConfigDAO: {} as never,
      tokenUsageDao: new TokenUsageDAO(db),
      ...(taskThread ? { taskThread: taskThread as never } : {}),
    }),
  )
  return a
}

function chat(message: string, taskThread?: unknown) {
  return app(taskThread).request(`/api/agent/sessions/${SESSION}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message }),
  })
}

/** Minimal task-thread profile — createTaskToolServer only reads these at build time. */
const fakeProfile = {
  identity: "doer",
  cwd: AGENT_DIR,
  readOnly: false,
  acceptanceGuide: false,
  archiveConsent: false,
  autoCommit: false,
  context: "",
  plugins: [],
  guard: undefined,
  task: { id: "t-1", workspaceId: null, displayStatus: "running" },
}

const fakeTaskThread = {
  resolveForSession: () => fakeProfile,
  maybeAdoptSmartTaskName: vi.fn(),
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

  for (const table of [
    "messages",
    "sessions",
    "session_prompt_snapshots",
    "session_expert_rosters",
    "session_role_states",
    "llm_calls",
  ]) {
    db.prepare(`DELETE FROM ${table}`).run()
  }

  captured = []
  installProvider()
  initAgentService(sessionDAO, { insertSafetyEvent: vi.fn() } as never)

  const now = new Date().toISOString()
  sessionDAO.insertSession({
    id: SESSION,
    title: "T",
    clone_name: null,
    session_type: "main",
    created_at: now,
    updated_at: now,
  })
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

describe("main chat — memory tool wiring", () => {
  it("free main chat mounts octopus-memory (and not the task tools)", async () => {
    const res = await chat("这个很重要，帮我记下来：我偏好 pnpm")
    await res.text()

    expect(captured).toHaveLength(1)
    const keys = Object.keys(captured[0].mcpServers ?? {})
    expect(keys).toContain("octopus-memory")
    expect(keys).not.toContain("octopus-task")
  })

  it("task threads do NOT mount octopus-memory", async () => {
    const res = await chat("继续处理任务", fakeTaskThread)
    await res.text()

    expect(captured).toHaveLength(1)
    const keys = Object.keys(captured[0].mcpServers ?? {})
    expect(keys).toContain("octopus-task")
    expect(keys).not.toContain("octopus-memory")
  })
})
