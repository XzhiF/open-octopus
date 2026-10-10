// packages/server/src/__tests__/task-doer-batch-guard.test.ts
//
// 计划回写 票04 (S2): the doer reverse hard-gate is WIRED — integration level.
//
// path-guard/doer-batch-guard tests exercise the guard function in isolation;
// this file pins its WIRING, the two things the pure test cannot reach
// (same posture as clone-runtime-authoring-guard.test.ts for the author half):
//
//   1. **Scope.** The batch guard reaches the task-doer chat channel (POST
//      /api/tasks/:id/chat → TaskDoerService.streamTurn → runChatTurn) and is
//      NOT installed anywhere else: ws-chat turns (runChatTurn without the
//      option) and every CloneRuntime session — incl. task-doer's clone path —
//      pass no hook at all (the authoring-guard suite pins that half).
//   2. **The model-visible refusal.** Through the hook actually handed to the
//      provider, a batch-dir write comes back {allow:false} whose reason names
//      the real 票02 endpoint shape — the doer can act on it — while projects/
//      writes and reads sail through untouched (AC1/AC2).
//
// REAL better-sqlite3 (in-memory) + REAL tmp homes/workspaces; the ONLY stubbed
// collaborator is @octopus/providers (the LLM), capturing sendQuery options —
// the task-doer-chat.test.ts convention. The user's real ~/.octopus is
// redirect-replaced (HOME/USERPROFILE + agent/paths → temp) and never touched.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { PluginMaterializer } from "../services/tasks/plugin-materializer"
import { ChatService } from "../services/chat"
import { WorkspaceService } from "../services/workspace"
import { createTasksRoutes } from "../routes/tasks"
import { AgentSessionDAO, ChatDAO, WorkspaceDAO } from "../db/dao"
import { ResourceManager } from "@octopus/shared"

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cwd: string; options: Record<string, unknown> | undefined }>,
  reset: () => {
    h.calls.length = 0
  },
}))

vi.mock("@octopus/providers", async () => {
  const actual = await vi.importActual<typeof import("@octopus/providers")>("@octopus/providers")
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      getType: () => "claude",
      sendQuery: async function* (
        _content: string,
        cwd: string,
        _providerSessionId?: string,
        options?: Record<string, unknown>,
      ) {
        h.calls.push({ cwd, options })
        yield { type: "text_delta", content: "（测试默认回复）" }
        yield { type: "result", sessionId: "prov-guard-1", content: "（测试默认回复）" }
      },
    })),
  }
})

const MOCK_HOME = vi.hoisted(() => {
  const p = require("path") as typeof import("path")
  const o = require("os") as typeof import("os")
  return p.join(o.tmpdir(), `octopus-test-doer-guard-${process.pid}`)
})

vi.mock("../services/agent/paths", async () => {
  const p = require("path") as typeof import("path")
  const actual = await vi.importActual<typeof import("../services/agent/paths")>("../services/agent/paths")
  const builtInRoot = p.join(MOCK_HOME, "agent", "built-in")
  return {
    ...actual,
    getOctopusHome: () => MOCK_HOME,
    getAgentDir: () => p.join(MOCK_HOME, "agent"),
    getBuiltInClonesDir: () => builtInRoot,
    getBuiltInCloneDir: (name: string) => p.join(builtInRoot, name),
    getBuiltInCloneMemoryDir: (name: string) => p.join(builtInRoot, name, "memory"),
  }
})

import { createTaskChatRoutes } from "../routes/task-chat"
import { TaskDoerService } from "../services/tasks/task-doer-service"
import { runChatTurn, type ChatTurnStream } from "../services/chat-turn"

// ── fixtures ───────────────────────────────────────────────────────────

const ORG = "e2e-pwb04"
const BATCH_DATE = "20261008"

let db: Database.Database
let app: Hono
let chatSvc: ChatService
let sse: SSEService
let wsBase: string
let taskSeq = 0

function seedRunningTask(): { taskId: string; wsPath: string } {
  const taskId = `e2e-pwb04-task-${taskSeq++}`
  const now = new Date().toISOString()
  const rel = path.join(".scratch", BATCH_DATE, "p1-mvp")

  const home = taskHome.homePath(taskId)
  const dir = path.join(home, rel)
  fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
  fs.writeFileSync(path.join(dir, "spec.md"), "# spec p1\n")

  const workspaceId = `e2e-pwb04-ws-${taskSeq}`
  const wsPath = path.join(wsBase, workspaceId)
  // isomorphic ws batch copy (the mirror the guard fences off)
  const wsBatch = path.join(wsPath, rel, "issues")
  fs.mkdirSync(wsBatch, { recursive: true })
  fs.writeFileSync(path.join(wsPath, rel, "spec.md"), "# spec p1\n")
  fs.writeFileSync(path.join(wsBatch, "01-feature.md"), "# feature\n")

  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'task', 'active', ?, datetime('now'), datetime('now'))",
  ).run(workspaceId, `task:${taskId}`, ORG, wsPath, taskId)
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, 'running', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, ORG, `PWB04 ${taskId}`, JSON.stringify({
    format: "v4",
    slug: "pwb04-feat",
    task_type: "coding",
    skill_groups: [],
    phases: [{ index: 1, name: "P1", slug: "p1-mvp", specPath: path.join(rel, "spec.md"), workflowRef: "built-in/flow-p1", inputValues: {} }],
  }), now, now, workspaceId)

  return { taskId, wsPath }
}

let taskHome: TaskHomeService

beforeAll(() => {
  process.env.HOME = MOCK_HOME
  process.env.USERPROFILE = MOCK_HOME
  db = new Database(":memory:")
  applySchema(db)
  wsBase = fs.mkdtempSync(path.join(os.tmpdir(), "doer-guard-ws-"))
  const homeBase = fs.mkdtempSync(path.join(os.tmpdir(), "doer-guard-home-"))
  const rmBase = fs.mkdtempSync(path.join(os.tmpdir(), "doer-guard-rm-"))

  const rm = new ResourceManager({ basePath: rmBase })
  taskHome = new TaskHomeService(homeBase)
  sse = new SSEService()
  const tasksService = new TasksService(
    db,
    sse,
    new AgentSessionDAO(db),
    taskHome,
    new PluginMaterializer(rm),
    { get: (ref: string) => (ref.includes("built-in") ? { ref, content: "stub" } : null) } as never,
  )
  chatSvc = new ChatService(new ChatDAO(db), sse)
  const wsSvc = new WorkspaceService(new WorkspaceDAO(db))
  const doer = new TaskDoerService({ db, sse, tasksService, chatService: chatSvc, workspaceService: wsSvc, taskHomeService: taskHome })

  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(tasksService, sse))
  app.route("/api/tasks", createTaskChatRoutes(doer))
})

afterAll(() => {
  db.close()
  for (const base of [wsBase]) {
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(MOCK_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  h.reset()
})

/** Drive one real doer turn through the SSE route; return the captured hook. */
async function driveDoerTurn(taskId: string) {
  const res = await app.request(`/api/tasks/${taskId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "把批次 spec 改一下" }),
  })
  expect(res.status).toBe(200)
  await res.text() // drain the SSE stream so the turn completes
  expect(h.calls).toHaveLength(1)
  return h.calls[0]
}

type Guard = (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>

describe("票04 S2 wiring — the batch guard rides the doer chat turn", () => {
  it("POST /:id/chat hands the provider an onBeforeToolCall hook", async () => {
    const { taskId } = seedRunningTask()
    const { cwd, options } = await driveDoerTurn(taskId)
    expect(cwd).toBeTruthy()
    expect(typeof options!.onBeforeToolCall).toBe("function")
  })

  it("through the wired hook: batch write refused with the real REST pointer; projects/ and reads sail through", async () => {
    const { taskId, wsPath } = seedRunningTask()
    const { options } = await driveDoerTurn(taskId)
    const guard = options!.onBeforeToolCall as Guard

    const denial = (await guard("Write", {
      file_path: path.join(wsPath, ".scratch", BATCH_DATE, "p1-mvp", "spec.md"),
    }))!
    expect(denial.allow).toBe(false)
    // the reason must be actionable for the model: the actual 票02 endpoint
    expect(denial.reason).toContain(`POST /api/tasks/${taskId}/plan`)
    expect(denial.reason).toContain("batch")
    expect(denial.reason).toContain("reason")

    // AC1 「同路径读不受影响」/ AC2 「projects/ 写与每改即 commit 零变化」
    expect(await guard("Read", { file_path: path.join(wsPath, ".scratch", BATCH_DATE, "p1-mvp", "spec.md") })).toBeUndefined()
    expect(await guard("Bash", { command: "cat .scratch/20261008/p1-mvp/issues/01-feature.md" })).toBeUndefined()
    expect(await guard("Edit", { file_path: path.join(wsPath, "projects", "app", "src", "a.ts") })).toBeUndefined()
  })
})

describe("票04 S2 scope — the hook is not installed on other channels", () => {
  it("runChatTurn without the option (the ws-chat posture) passes no onBeforeToolCall at all", async () => {
    const ws = seedRunningTask()
    const session = chatSvc.createSession("any-ws", "plain chat")
    const noopStream: ChatTurnStream = {
      writeSSE: async () => {},
      onAbort: () => {},
      close: () => {},
    }
    await runChatTurn({
      stream: noopStream,
      chatService: chatSvc,
      sseService: sse,
      sessionId: session.id,
      notifyChannel: "any-ws",
      content: "hi",
      cwd: ws.wsPath,
    })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].options!.onBeforeToolCall).toBeUndefined()
  })

  it("the wired guard is scoped to THIS task's workspace mirror, not a global .scratch ban", async () => {
    // CloneRuntime sessions (author path, and task-doer's own clone path) stay
    // unguarded on this channel — that half is pinned by the authoring-guard
    // suite ("leaves task-doer unguarded", run together in `pnpm test`); this
    // case only proves the doer-chat hook fences its ONE ws, nothing else.
    const { taskId, wsPath } = seedRunningTask()
    const { options } = await driveDoerTurn(taskId)
    const guard = options!.onBeforeToolCall as Guard
    // sanity: the wired instance is scoped to THIS ws + THIS task
    const foreign = await guard("Write", { file_path: path.join(path.dirname(wsPath), "other-ws", ".scratch", "x", "spec.md") })
    expect(foreign).toBeUndefined()
    const mine = await guard("Write", { file_path: path.join(wsPath, ".scratch", "x", "spec.md") })
    expect(mine!.reason).toContain(taskId)
  })
})
