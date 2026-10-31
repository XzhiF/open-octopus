// packages/server/src/__tests__/task-thread-route.test.ts
//
// M1-3 — the chat route actually APPLIES a task-thread profile:
//   draft  → author cwd (task home) + author guard + task context
//   running → workspace cwd + doer guard + plugins + [quick-edit] commit
//   legacy clone session → untouched (no thread options)
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { execFileSync } from "child_process"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, TaskDAO } from "../db/dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createChatRoutes } from "../routes/agent/chat-routes"
import { TaskThreadService } from "../services/tasks/task-thread-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import * as providers from "@octopus/providers"

const ORG = "E2E_TEST_task_thread"
const ROOT = path.join(os.tmpdir(), `task-thread-route-${Date.now()}`)
const HOME = path.join(ROOT, "octopus")
const WS = path.join(ROOT, "ws")
const AGENT_DIR = path.join(HOME, "agent")

interface CallRecord {
  prompt: string
  cwd: string
  plugins?: Array<{ type: string; path: string }>
  guard?: (tool: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>
  append: string
}

interface Behavior {
  writeFile?: { rel: string; content: string }
}

let db: Database.Database
let sessionDAO: AgentSessionDAO
let taskDAO: TaskDAO
let taskThread: TaskThreadService
let calls: CallRecord[]
let behaviors: Behavior[]

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

function installProvider() {
  vi.spyOn(providers, "getProvider").mockImplementation((() => ({
    sendQuery: async function* (
      prompt: string,
      cwd: string,
      _resume: string | undefined,
      options: Record<string, unknown>,
    ) {
      calls.push({
        prompt,
        cwd,
        plugins: options.plugins as CallRecord["plugins"],
        guard: options.onBeforeToolCall as CallRecord["guard"],
        append: (options.systemPrompt as { append?: string } | undefined)?.append ?? "",
      })
      const behavior = behaviors.shift() ?? {}
      if (behavior.writeFile) {
        const abs = path.join(WS, "projects", "app", behavior.writeFile.rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, behavior.writeFile.content)
      }
      yield { type: "text_delta", content: "ok" }
      yield { type: "result", content: "ok", sessionId: "sdk-thread-1" }
    },
  })) as never)
}

function newApp() {
  const a = new Hono()
  a.route("/api/agent", createChatRoutes({
    sessionDAO,
    safetyDAO: { insertSafetyEvent: vi.fn() } as never,
    scheduleConfigDAO: {} as never,
    tokenUsageDao: new TokenUsageDAO(db),
    taskThread,
  }))
  return a
}

function chat(sessionId: string, message: string) {
  return newApp().request(`/api/agent/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Octopus-Org": ORG },
    body: JSON.stringify({ message }),
  })
}

const NOW = new Date().toISOString()

function insertSession(id: string, opts: { clone?: string | null; cwd?: string | null } = {}): void {
  sessionDAO.insertSession({
    id, repo_group: ORG, title: "T", clone_name: opts.clone ?? null,
    session_type: opts.clone ? "clone_direct" : "main",
    cwd: opts.cwd ?? AGENT_DIR,
    created_at: NOW, updated_at: NOW,
  })
}

function insertTask(opts: {
  id: string
  status: string
  sessionId: string
  workspaceId?: string | null
}): void {
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, created_at, updated_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id, ORG, `任务 ${opts.id}`, opts.status, opts.sessionId,
    JSON.stringify({
      format: "v4",
      slug: "demo",
      phases: [{ index: 1, name: "P1", slug: "p-1", specPath: "./.scratch/demo/p-1/spec.md", workflowRef: "built-in/matt-spec-dev", inputValues: {} }],
    }),
    NOW, NOW, opts.workspaceId ?? null,
  )
}

beforeAll(() => {
  fs.mkdirSync(AGENT_DIR, { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "memory"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "experiences"), { recursive: true })
  fs.mkdirSync(path.join(AGENT_DIR, "skills"), { recursive: true })
  const repo = path.join(WS, "projects", "app")
  fs.mkdirSync(repo, { recursive: true })
  git(repo, "init", "-b", "main")
  git(repo, "config", "user.email", "t@t.io")
  git(repo, "config", "user.name", "T")
  fs.writeFileSync(path.join(repo, "seed.txt"), "s\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-m", "seed")

  db = new Database(":memory:")
  applySchema(db)
  db.prepare(`INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at) VALUES ('ws-thread','ws',?,?,?,?)`)
    .run(ORG, WS, NOW, NOW)
  sessionDAO = new AgentSessionDAO(db)
  taskDAO = new TaskDAO(db)
  taskThread = new TaskThreadService({
    db,
    workspaceService: {
      getById: (id: string) => (id === "ws-thread" ? { id, path: WS } : undefined),
    } as never,
    taskHomeService: new TaskHomeService(HOME),
  })
})

beforeEach(() => {
  process.env.OCTOPUS_HOME = HOME
  process.env.CLAUDE_CONFIG_DIR = path.join(ROOT, "claude")
  fs.mkdirSync(path.join(ROOT, "claude", "projects"), { recursive: true })
  const ordered = ["messages", "executions", "tasks", "session_prompt_snapshots", "sessions", "llm_calls"]
  for (const table of ordered) {
    db.prepare(`DELETE FROM ${table}`).run()
  }
  calls = []
  behaviors = []
  installProvider()
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

describe("task-thread chat route", () => {
  it("draft: author cwd = task home, author guard, task context in the prompt", async () => {
    insertSession("s-draft")
    insertTask({ id: "t-draft", status: "draft", sessionId: "s-draft" })
    fs.mkdirSync(path.join(HOME, "tasks", "t-draft"), { recursive: true })

    const res = await chat("s-draft", "我想做昵称过滤")
    expect(res.status).toBe(200)
    await res.text()

    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(path.join(HOME, "tasks", "t-draft"))
    expect(calls[0].prompt).toContain("[任务线程]")
    expect(calls[0].prompt).toContain("任务作者")
    expect(calls[0].plugins?.some((p) => p.path.endsWith(path.join("tasks", "t-draft")))).toBe(true)
    const denied = await calls[0].guard!("Write", { file_path: path.join(WS, "projects", "app", "x.ts") })
    expect(denied?.allow).toBe(false)
  })

  it("running: workspace cwd, doer guard, plugins, and a [quick-edit] commit + SSE", async () => {
    insertSession("s-run", { cwd: AGENT_DIR })
    insertTask({ id: "t-run", status: "running", sessionId: "s-run", workspaceId: "ws-thread" })
    db.prepare(`
      INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
        task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, created_at, updated_at)
      VALUES ('e-run','ws-thread',?, 'built-in/matt-spec-dev','dev','running','t-run',1,1,'{}','{}',?,?,?)
    `).run(ORG, NOW, NOW, NOW)
    behaviors.push({ writeFile: { rel: "nickname.ts", content: "export const n = '*'\n" } })
    const profile = taskThread.resolveForSession({ id: "s-run", clone_name: null })!
    expect(profile.autoCommit).toBe(true)
    expect(profile.task.wsPath).toBe(WS)

    const res = await chat("s-run", "加一个替换为 * 的逻辑")
    const body = await res.text()

    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(WS)
    expect(calls[0].prompt).toContain("任务执行者")
    expect(calls[0].prompt).toContain(WS)
    const denied = await calls[0].guard!("Write", { file_path: path.join(WS, ".scratch", "demo", "spec.md") })
    expect(denied?.allow).toBe(false)
    const subject = git(path.join(WS, "projects", "app"), "log", "-1", "--pretty=%s")
    expect(subject.startsWith("[quick-edit]")).toBe(true)
    expect(body).toContain("quick_edit_commit")
  })

  it("awaiting_review derives from a completed round (still doer, context says human decides)", async () => {
    insertSession("s-await", { cwd: AGENT_DIR })
    insertTask({ id: "t-await", status: "running", sessionId: "s-await", workspaceId: "ws-thread" })
    db.prepare(`
      INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
        task_id, phase_index, round_index, start_commit_id, end_commit_id, started_at, completed_at, created_at, updated_at)
      VALUES ('e-await','ws-thread',?, 'built-in/matt-spec-dev','dev','completed','t-await',1,1,'{}','{}',?,?,?,?)
    `).run(ORG, NOW, NOW, NOW, NOW)

    const res = await chat("s-await", "这轮怎么样？")
    await res.text()
    expect(calls[0].prompt).toContain("待验收")
    expect(calls[0].prompt).toContain("submit_acceptance_decision")
  })

  it("legacy clone session bound to a task is NOT a thread (no plugins/guard/context)", async () => {
    insertSession("s-clone", { clone: "task-author", cwd: AGENT_DIR })
    insertTask({ id: "t-legacy", status: "draft", sessionId: "s-clone" })
    const res = await chat("s-clone", "继续")
    await res.text()
    expect(calls[0].cwd).toBe(AGENT_DIR)
    expect(calls[0].plugins).toBeUndefined()
    expect(calls[0].guard).toBeUndefined()
    expect(calls[0].prompt).not.toContain("[任务线程]")
  })

  it("bindThread rebinds a task to a main session", () => {
    insertSession("s-bind")
    insertTask({ id: "t-bind", status: "draft", sessionId: "s-bind" })
    expect(taskThread.resolveForSession({ id: "s-bind", clone_name: null })?.task.id).toBe("t-bind")
    expect(taskThread.bindThread("t-bind", null)).toBe(true)
    expect(taskThread.resolveForSession({ id: "s-bind", clone_name: null })).toBeNull()
  })
})
