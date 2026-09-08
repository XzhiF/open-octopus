// packages/server/src/__tests__/clone-ask-user-question.test.ts
//
// AskUserQuestion 在 clone chat（草稿 task-author 等）链路上的两段承重：
//   ① routes/clone/index.ts 把 provider 的 ask_user_question chunk 转成同名
//      SSE 事件（2026-09-09 前该 chunk 被 switch 静默丢弃 —— 前端只拿到
//      headless 回显的 tool_result，问题卡永远不可回答）；
//   ② 回合落库行的 metadata.tool_calls 带 AskUserQuestion + questions input
//      （ChatArea.findUnansweredAsk 刷新/重开恢复的数据源）。
//
// 手法与 clone-spec-notice.test.ts 同构：真 DB + 真路由 + mock CloneRuntime /
// clone-resolver / task-home-service。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, TaskDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { createCloneSessionRoutes } from "../routes/clone"

const QUESTIONS = {
  questions: [
    {
      question: "E2E_AQ 币种怎么定？",
      header: "货币口径",
      multiSelect: false,
      options: [
        { label: "多币种共存", description: "行存原币+币种字段" },
        { label: "全面切 CNY", description: "库内单一币种" },
      ],
    },
  ],
}

vi.mock("../services/tasks/task-home-service", () => {
  const homeTmp = path.join(os.tmpdir(), `octopus-aq-home-${Date.now()}`)
  return {
    TaskHomeService: class {
      homePath(id: string) { return path.join(homeTmp, "tasks", id) }
      artifactsDir(id: string) { return path.join(homeTmp, "tasks", id, "artifacts") }
      createHome(id: string) { return path.join(homeTmp, "tasks", id) }
      writeContextFile(): void {}
      ensureContextFile(): void {}
      ensureRulesFile(): void {}
    },
  }
})

vi.mock("../services/agent/clone-runtime", () => ({
  CloneRuntime: class {
    constructor(_cloneDef: unknown, _org: string) {}
    getDefaultCwd(): string { return "/tmp/fake-cwd" }
    async *chat() {
      // deny 路径下 provider 事件形态：tool_use 块先流式（start/input），
      // PreToolUse hook 捕获问题 → ask_user_question chunk；canUseTool deny
      // 不产生 tool_result（PostToolUseFailure 对 AskUserQuestion 跳过入队）。
      yield { type: "tool_call_start", toolCallId: "tu-aq-1", toolName: "AskUserQuestion" }
      yield { type: "tool_call", toolCallId: "tu-aq-1", toolName: "AskUserQuestion", toolInput: QUESTIONS }
      yield { type: "ask_user_question", toolCallId: "tu-aq-1", questions: QUESTIONS }
      yield { type: "result", sessionId: "fake-provider-session" }
    }
  },
}))

vi.mock("../services/agent/clone-resolver", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/agent/clone-resolver")>()
  return {
    ...real,
    resolveCloneInfo: (name: string) => {
      if (name !== "task-author") return null
      return {
        name,
        display_name: "Task Author",
        type: "built-in" as const,
        persona: `# task-author\n\nFake persona for test.`,
        skills: [],
        memory_scope: "shared" as const,
      }
    },
  }
})

const ORG = "e2e-aq-09"

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

describe("clone chat — ask_user_question SSE + 持久化", () => {
  let db: Database.Database
  let app: Hono
  let sessionDAO: AgentSessionDAO

  beforeAll(() => {
    process.env.OCTOPUS_HOME = path.join(os.tmpdir(), `octopus-aq-test-${Date.now()}`)
    db = newDb()
    sessionDAO = new AgentSessionDAO(db)
    const taskDAO = new TaskDAO(db)
    app = new Hono()
    app.route("/api/clones", createCloneSessionRoutes({ sessionDAO, taskDAO }))
  })

  afterAll(() => {
    db.close()
    delete process.env.OCTOPUS_HOME
    if (fs.existsSync(process.env.OCTOPUS_HOME ?? "")) fs.rmSync(process.env.OCTOPUS_HOME as string, { recursive: true, force: true })
  })

  async function createSessionAndChat(): Promise<{ sessionId: string; sse: string }> {
    const createRes = await app.request("/api/clones/task-author/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
      body: JSON.stringify({}),
    })
    expect(createRes.status).toBe(201)
    const session = (await createRes.json()) as { id: string }
    const r = await app.request(
      `/api/clones/task-author/sessions/${session.id}/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
        body: JSON.stringify({ message: "E2E_AQ 开始" }),
      },
    )
    expect(r.status).toBe(200)
    return { sessionId: session.id, sse: await r.text() }
  }

  it("S1: ask_user_question chunk 转成同名 SSE 事件，带 tool_call_id + questions", async () => {
    const { sse } = await createSessionAndChat()
    expect(sse).toContain("event: ask_user_question")
    // 按 SSE 事件块取（tool_call input 块含同样的 id/questions，逐行搜会误配）
    const block = sse
      .split("\n\n")
      .find((b) => b.split("\n").some((l) => l.trim() === "event: ask_user_question"))
    expect(block, "存在 ask_user_question 事件块").toBeDefined()
    const dataLine = (block as string).split("\n").find((l) => l.startsWith("data: "))
    expect(dataLine).toBeDefined()
    const payload = JSON.parse((dataLine as string).slice(6))
    expect(payload).toEqual({ tool_call_id: "tu-aq-1", questions: QUESTIONS })
  })

  it("S2: 回合落库行 metadata.tool_calls 含 AskUserQuestion + questions（刷新恢复源）", async () => {
    const { sessionId, sse } = await createSessionAndChat()
    expect(sse).toContain("event: tool_call") // start/input 照发（流内 QuestionCard）
    const msgs = sessionDAO.findAllMessages(sessionId)
    const assistant = msgs.find((m) => m.role === "assistant")
    expect(assistant).toBeDefined()
    const meta = JSON.parse(assistant!.metadata ?? "{}") as {
      tool_calls?: Array<{ id: string; name: string; status: string; input?: { questions?: unknown[] } }>
    }
    const ask = (meta.tool_calls ?? []).find((tc) => tc.name === "AskUserQuestion")
    expect(ask, "AskUserQuestion 应持久化在 metadata.tool_calls").toBeDefined()
    expect(ask!.input?.questions).toHaveLength(1)
    // 非终态记录落库前被标 'fail'（防刷新后 spinner 永转）——findUnansweredAsk 不依赖 status
    expect(ask!.status).toBe("fail")
  })
})
