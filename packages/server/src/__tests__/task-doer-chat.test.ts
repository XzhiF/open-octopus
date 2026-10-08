// packages/server/src/__tests__/task-doer-chat.test.ts
//
// taskboard-modal-v2 ticket 01 — the task-level doer chat seam (S1).
//
// Seam: GET/POST /api/tasks/:id/chat via Hono app.request against REAL
// better-sqlite3 + applySchema + REAL tmp workspaces (git repos) + REAL task
// homes; the only stubbed collaborator is @octopus/providers (the LLM itself —
// same posture as chat-route.test.ts). Expected values come from the ticket /
// ADR-0025 / spec S1, not from the implementation (防自证).
//
// Covers (ticket checkboxes):
//   [2] GET lazily creates ONE doer session bound to tasks.doer_session_id,
//       idempotent on the second call; the draft-phase task-author session
//       (source_chat_session_id, sessions table) is untouched.
//   [3] POST answers via task-doer over SSE; the assembled prompt carries the
//       injected task context (phase/round, batch dir spec family incl.
//       fix-feedback, runbook, 写纪律) — asserted on the captured sendQuery.
//   [4] an effective edit produces ONE [quick-edit] commit on the execution
//       branch of the edited repo.
//   [5] a deflected big-change (model says no) leaves no commit; no keyword
//       table — persona-side (see task-doer-clone.test.ts).
//   [6] task isolation: A's chat edits never land in B's workspace.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import fs from "fs"
import path from "path"
import os from "os"
import { execFileSync } from "child_process"
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

// ── provider stub (the ONLY mocked collaborator) ───────────────────────
// Each queued turn: sideEffect runs first (simulates what the agent's tools
// would do to the real workspace), then the chunks stream out.

const h = vi.hoisted(() => ({
  calls: [] as Array<{
    content: string
    cwd: string
    providerSessionId?: string
    options: Record<string, unknown> | undefined
  }>,
  queue: [] as Array<{ sideEffect?: (cwd: string) => void; chunks: unknown[] }>,
  reset: () => {
    h.calls.length = 0
    h.queue.length = 0
  },
}))

vi.mock("@octopus/providers", async () => {
  const actual = await vi.importActual<typeof import("@octopus/providers")>("@octopus/providers")
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      getType: () => "claude",
      sendQuery: async function* (
        content: string,
        cwd: string,
        providerSessionId?: string,
        options?: Record<string, unknown>,
      ) {
        h.calls.push({ content, cwd, providerSessionId, options })
        const turn = h.queue.shift() ?? { chunks: [textResult("（测试默认回复）")] }
        turn.sideEffect?.(cwd)
        for (const chunk of turn.chunks) yield chunk
      },
    })),
  }
})

// Built-in clone paths → temp home (CloneRuntime must never touch the real
// ~/.octopus; clone-init-service.test.ts convention).
const MOCK_HOME = vi.hoisted(() => {
  const p = require("path") as typeof import("path")
  const o = require("os") as typeof import("os")
  return p.join(o.tmpdir(), `octopus-test-task-doer-chat-${process.pid}`)
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

// ── chunk builders (shapes mirror chat.ts consumption) ─────────────────

function textResult(text: string): unknown[] {
  return [
    { type: "text_delta", content: text },
    { type: "result", sessionId: "prov-doer-1", content: text },
  ] as unknown[]
}

/** A successful Edit tool card + a file write in the repo under the ws. */
function editTurn(summary: string, relPathInRepo: string, newContent: string): {
  sideEffect: (cwd: string) => void
  chunks: unknown[]
} {
  return {
    sideEffect: (cwd: string) => {
      const abs = path.join(cwd, "projects", relPathInRepo)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, newContent, "utf-8")
    },
    chunks: [
      { type: "tool_call_start", toolCallId: "tc-1", toolName: "Edit" },
      { type: "tool_call", toolCallId: "tc-1", toolName: "Edit", toolInput: { file_path: relPathInRepo } },
      { type: "tool_result", toolCallId: "tc-1", content: "ok", isError: false },
      ...textResult(summary),
    ],
  }
}

// ── fixtures ───────────────────────────────────────────────────────────

const ORG = "e2e-dc"
const BATCH_DATE = "20261008"

let db: Database.Database
let app: Hono
let taskHome: TaskHomeService
let chatSvc: ChatService
let wsSvc: WorkspaceService
let sse: SSEService
let wsBase: string
let taskSeq = 0

function mkGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "doer-test@example.com"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "doer-test"], { cwd: dir, stdio: "ignore" })
  fs.writeFileSync(path.join(dir, "README.md"), "# seed\n")
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "seed"], { cwd: dir, stdio: "ignore" })
}

function gitLogSubjects(dir: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf-8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
}

interface SeedResult {
  taskId: string
  workspaceId: string
  wsPath: string
  repoPath: string
  homeBatchDir: string
  wsBatchDir: string
}

/**
 * A v4 task with two phase defs, parked mid-flight. `running` lays one RUNNING
 * round (phase 1, round 1); `awaiting_review` lays one terminal unreviewed
 * round. Batch dirs exist BOTH in home and (isomorphically) in the ws, incl. a
 * fix-feedback-r1.md in phase 1's dir (rejection history) — the injected context
 * must surface them by name. The bound workspace hosts a real git repo at
 * projects/app checked out to the execution branch.
 */
function seedV4Task(opts: { kind: "running" | "awaiting_review" | "draft" }): SeedResult {
  const taskId = `e2e-dc-task-${taskSeq++}`
  const now = new Date().toISOString()
  const slug1 = "p1-mvp"
  const slug2 = "p2-story"
  const rel1 = path.join(".scratch", BATCH_DATE, slug1)
  const rel2 = path.join(".scratch", BATCH_DATE, slug2)

  const home = taskHome.homePath(taskId)
  for (const rel of [rel1, rel2]) {
    const dir = path.join(home, rel)
    fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
    fs.writeFileSync(path.join(dir, "spec.md"), `# spec ${rel}\n`)
    fs.writeFileSync(path.join(dir, "issues", "01-feature.md"), "# feature\n")
  }
  fs.writeFileSync(path.join(home, rel1, "fix-feedback-r1.md"), "# 打回反馈 · Round 1\n")

  const spec = {
    format: "v4",
    slug: "e2e-dc-feat",
    task_type: "coding",
    skill_groups: [],
    phases: [
      { index: 1, name: "P1 MVP", slug: slug1, specPath: path.join(rel1, "spec.md"), workflowRef: "built-in/flow-p1", inputValues: {} },
      { index: 2, name: "P2 Story", slug: slug2, specPath: path.join(rel2, "spec.md"), workflowRef: "built-in/flow-p2", inputValues: {} },
    ],
    acceptance_runbook: {
      up: { command: "pnpm -C projects/app dev", cwd: "." },
      ready: { command: "curl -s -o /dev/null http://localhost:3999/health" },
      views: [{ url: "http://localhost:3999" }],
    },
  }

  // workspace row + dir with a REAL git repo (execution branch checked out).
  const workspaceId = `e2e-dc-ws-${taskSeq}`
  const wsPath = path.join(wsBase, workspaceId)
  const repoPath = path.join(wsPath, "projects", "app")
  mkGitRepo(repoPath)
  execFileSync("git", ["checkout", "-b", `feat-${slug1}-20261008`], { cwd: repoPath, stdio: "ignore" })

  if (opts.kind !== "draft") {
    // isomorphic batch copy inside the ws (seed copies home → {ws}/{rel})
    for (const rel of [rel1, rel2]) {
      const dir = path.join(wsPath, rel)
      fs.mkdirSync(path.join(dir, "issues"), { recursive: true })
      fs.writeFileSync(path.join(dir, "spec.md"), fs.readFileSync(path.join(home, rel, "spec.md"), "utf-8"))
      fs.copyFileSync(path.join(home, rel, "issues", "01-feature.md"), path.join(dir, "issues", "01-feature.md"))
    }
    fs.copyFileSync(path.join(home, rel1, "fix-feedback-r1.md"), path.join(wsPath, rel1, "fix-feedback-r1.md"))
  }

  db.prepare(
    "INSERT INTO workspaces (id, name, org, path, source, status, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'task', 'active', ?, datetime('now'), datetime('now'))",
  ).run(workspaceId, `task:${taskId}`, ORG, wsPath, taskId)

  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
    VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', '["app"]', NULL, 1, NULL, ?, ?, NULL, ?)
  `).run(taskId, ORG, `E2E_DC ${taskId}`, opts.kind === "draft" ? "draft" : "running",
    JSON.stringify(spec), now, now, opts.kind === "draft" ? null : workspaceId)

  if (opts.kind !== "draft") {
    const execStatus = opts.kind === "running" ? "running" : "completed"
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
         status, completed_at, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
       VALUES (?, ?, '0', 0, 'built-in/flow-p1', 'built-in/flow-p1', ?, ?, '{}', '{}', ?, datetime('now'), datetime('now'), ?, 1, 1)`,
    ).run(
      `e2e-dc-exec-${taskSeq}`, workspaceId, execStatus,
      execStatus === "completed" ? new Date().toISOString() : null,
      ORG, taskId,
    )
  }

  return { taskId, workspaceId, wsPath, repoPath, homeBatchDir: path.join(home, rel1), wsBatchDir: path.join(wsPath, rel1) }
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  wsBase = fs.mkdtempSync(path.join(os.tmpdir(), "task-doer-ws-"))
  const homeBase = fs.mkdtempSync(path.join(os.tmpdir(), "task-doer-home-"))
  const rmBase = fs.mkdtempSync(path.join(os.tmpdir(), "task-doer-rm-"))

  const rm = new ResourceManager({ basePath: rmBase })
  taskHome = new TaskHomeService(homeBase)
  sse = new SSEService()
  const agentSessionDAO = new AgentSessionDAO(db)
  const tasksService = new TasksService(
    db,
    sse,
    agentSessionDAO,
    taskHome,
    new PluginMaterializer(rm),
    { get: (ref: string) => (ref.includes("built-in") ? { ref, content: "stub" } : null) } as never,
  )
  chatSvc = new ChatService(new ChatDAO(db), sse)
  wsSvc = new WorkspaceService(new WorkspaceDAO(db))

  const doer = new TaskDoerService({ db, sse, tasksService, chatService: chatSvc, workspaceService: wsSvc, taskHomeService: taskHome })

  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(tasksService, sse))
  app.route("/api/tasks", createTaskChatRoutes(doer))
})

afterAll(() => {
  db.close()
  for (const dir of [wsBase, path.join(os.tmpdir(), "task-doer-home-")]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(MOCK_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  h.reset()
})

describe("S1: GET /api/tasks/:id/chat — lazy-create + idempotent binding", () => {
  it("creates ONE doer session on first call, persists tasks.doer_session_id, returns the same session on the second call", async () => {
    const { taskId, workspaceId } = seedV4Task({ kind: "awaiting_review" })

    const res = await app.request(`/api/tasks/${taskId}/chat`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task_id: string; session_id: string; workspace_id: string; created: boolean }
    expect(body.task_id).toBe(taskId)
    expect(body.session_id).toBeTruthy()
    expect(body.workspace_id).toBe(workspaceId)
    expect(body.created).toBe(true)

    // persisted binding on the task row (contract for 07/08: doer_session_id)
    const row = db.prepare("SELECT doer_session_id FROM tasks WHERE id = ?").get(taskId) as { doer_session_id: string | null }
    expect(row.doer_session_id).toBe(body.session_id)

    // the session lives on the task's BOUND workspace (workspace-chat channel)
    const sess = db.prepare("SELECT workspace_id FROM chat_sessions WHERE id = ?").get(body.session_id) as { workspace_id: string }
    expect(sess.workspace_id).toBe(workspaceId)

    // second call → same session, no second create
    const res2 = await app.request(`/api/tasks/${taskId}/chat`)
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { session_id: string; created: boolean }
    expect(body2.session_id).toBe(body.session_id)
    expect(body2.created).toBe(false)
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM chat_sessions WHERE workspace_id = ?").get(workspaceId) as { c: number }
    expect(cnt.c).toBe(1)
  })

  it("the Task read model surfaces doer_session_id (GET /api/tasks/:id)", async () => {
    const { taskId } = seedV4Task({ kind: "awaiting_review" })
    await app.request(`/api/tasks/${taskId}/chat`)
    const res = await app.request(`/api/tasks/${taskId}`)
    expect(res.status).toBe(200)
    const task = (await res.json()) as { doer_session_id?: string | null }
    expect(task.doer_session_id).toBeTruthy()
  })

  it("a draft task is refused (谈 belongs to task-author) — no session created, source_chat_session_id untouched", async () => {
    // seed a real author session row + bind it
    const sessionId = `e2e-dc-author-${taskSeq}`
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO sessions (id, org, title, clone_name, perspective_clone_name, session_type,
        is_active, is_deleted, scope_id, provider_session_id, last_message_at, created_at, updated_at)
      VALUES (?, ?, 'E2E_DC author', NULL, NULL, 'task-author', 1, 0, NULL, NULL, ?, ?, ?)
    `).run(sessionId, ORG, now, now, now)
    const t = seedV4Task({ kind: "draft" })
    db.prepare("UPDATE tasks SET source_chat_session_id = ? WHERE id = ?").run(sessionId, t.taskId)

    const res = await app.request(`/api/tasks/${t.taskId}/chat`)
    expect(res.status).toBe(409)

    const row = db.prepare("SELECT doer_session_id, source_chat_session_id FROM tasks WHERE id = ?").get(t.taskId) as
      { doer_session_id: string | null; source_chat_session_id: string | null }
    expect(row.doer_session_id).toBeNull()
    expect(row.source_chat_session_id).toBe(sessionId)
  })

  it("unknown task → 404", async () => {
    const res = await app.request(`/api/tasks/e2e-dc-nope/chat`)
    expect(res.status).toBe(404)
  })

  it("K3 manual-gate: a task parked at persisted 'ready' with an unreviewed terminal round still opens the chat (待验收入口)", async () => {
    const t = seedV4Task({ kind: "awaiting_review" })
    db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(t.taskId)

    const res = await app.request(`/api/tasks/${t.taskId}/chat`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { created: boolean }
    expect(body.created).toBe(true)
  })

  it("terminal states (done / aborted / archiving) refuse — the ledger is the record, not a chat", async () => {
    for (const status of ["done", "aborted", "archiving"]) {
      const t = seedV4Task({ kind: "awaiting_review" })
      db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, t.taskId)
      const res = await app.request(`/api/tasks/${t.taskId}/chat`)
      expect(res.status).toBe(409)
      const row = db.prepare("SELECT doer_session_id FROM tasks WHERE id = ?").get(t.taskId) as { doer_session_id: string | null }
      expect(row.doer_session_id).toBeNull()
    }
  })
})

describe("S1: POST /api/tasks/:id/chat — task-doer answers over SSE with injected context", () => {
  it("streams the doer reply, stores user+assistant messages, and threads the provider session across turns", async () => {
    const { taskId } = seedV4Task({ kind: "awaiting_review" })
    h.queue.push({ chunks: textResult("已把按钮圆角改成 8px。") })

    const res = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "把提交按钮圆角改成 8px" }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const sseText = await res.text()
    expect(sseText).toContain("event: text_delta")
    expect(sseText).toContain("event: result")

    // both sides persisted on the bound session (history = plain ws-chat reads)
    const bound = db.prepare("SELECT doer_session_id FROM tasks WHERE id = ?").get(taskId) as { doer_session_id: string }
    const msgs = chatSvc.getAllMessages(bound.doer_session_id)
    const roles = msgs.map((m) => m.role)
    expect(roles).toContain("user")
    expect(roles).toContain("assistant")
    const assistant = msgs.find((m) => m.role === "assistant" && m.content.includes("8px"))
    expect(assistant).toBeDefined()

    // second turn continues the SAME provider session (跨轮延续 — 会话不裂变)
    h.queue.push({ chunks: textResult("收到") })
    const res2 = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "再深一点" }),
    })
    expect(res2.status).toBe(200)
    await res2.text()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[0].providerSessionId).toBeUndefined()
    expect(h.calls[1].providerSessionId).toBe("prov-doer-1")
  })

  it("the assembled prompt carries the task-doer persona + phase/round, batch spec family, runbook and 写纪律", async () => {
    const { taskId, wsBatchDir } = seedV4Task({ kind: "awaiting_review" })
    h.queue.push({ chunks: textResult("好的") })

    const res = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "把标题文案改一下" }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(h.calls).toHaveLength(1)
    const call = h.calls[0]

    // cwd = the task's bound execution workspace (workspace-chat 通道)
    expect(path.resolve(call.cwd)).toBe(path.resolve(wsBatchDir, "..", "..", ".."))

    const opts = call.options as {
      systemPrompt?: { type: string; preset?: string; append?: string }
      plugins?: Array<{ type: string; path: string }>
    }
    // same protocol shape as ws-chat (no new chat protocol)
    expect(opts.systemPrompt?.type).toBe("preset")
    expect(opts.systemPrompt?.preset).toBe("claude_code")
    expect(Array.isArray(opts.plugins)).toBe(true)

    const append = opts.systemPrompt?.append ?? ""
    // persona (task-doer, fallback copy = builtin-clones.ts registration)
    expect(append).toContain("任务执行者")
    // phase/round of the live现场
    expect(append).toContain("P1 MVP")
    expect(append).toMatch(/round\s*1/i)
    // batch 目录 spec 家族 —— spec.md 与打回反馈按名注入
    // (K10 同构相对位, posix 分隔符)
    expect(append).toContain([".scratch", BATCH_DATE, "p1-mvp"].join("/"))
    expect(append).toContain("spec.md")
    expect(append).toContain("fix-feedback-r1.md")
    // 启动 Runbook —— up/ready 命令原样带上
    expect(append).toContain("pnpm -C projects/app dev")
    expect(append).toContain("curl -s -o /dev/null")
    // 写纪律 —— 快改每改即 commit 的标记词就在上下文里
    expect(append).toContain("[quick-edit]")
    expect(append).toContain("快速修改")
  })

  it("empty content → 400; draft task → 409 before the stream starts", async () => {
    const { taskId } = seedV4Task({ kind: "awaiting_review" })
    const res = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application.json" },
      body: JSON.stringify({ content: "   " }),
    })
    expect(res.status).toBe(400)

    const t = seedV4Task({ kind: "draft" })
    const res2 = await app.request(`/api/tasks/${t.taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    })
    expect(res2.status).toBe(409)
    expect(h.calls).toHaveLength(0)
  })
})

describe("S1: 快速修改每改即 commit — [quick-edit] 落在执行分支", () => {
  it("an effective edit (dirty repo after the turn) lands exactly one [quick-edit] commit on the execution branch and is announced over SSE", async () => {
    const { taskId, repoPath, wsPath } = seedV4Task({ kind: "running" })
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim()
    expect(branch).toBe("feat-p1-mvp-20261008") // 执行分支就位
    const before = gitLogSubjects(repoPath)

    h.queue.push(editTurn("已把标题改为「提交」。", path.join("app", "src", "ui.ts"), "export const title = '提交'\n"))
    const res = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "把提交按钮的文案改成「提交」" }),
    })
    expect(res.status).toBe(200)
    const sseText = await res.text()
    expect(sseText).toContain("event: quick_edit_commit")

    const after = gitLogSubjects(repoPath)
    expect(after.length).toBe(before.length + 1)
    const [subject, ...rest] = after
    expect(subject.startsWith("[quick-edit]")).toBe(true)
    // 独立事实校验：提交里带的是任务自己的现场（不是实现常量的回声）
    expect(subject).toContain("把提交按钮的文案改成「提交」")
    const body = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: repoPath, encoding: "utf-8" })
    expect(body).toContain(`task: ${taskId}`)
    expect(body).toContain("doer_session:")

    // commit 落在执行分支上（HEAD 未动、工作区干净）
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim()).toBe(branch)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf-8" }).trim()).toBe("")
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim()
    expect(sseText).toContain(sha.slice(0, 8))
    void wsPath
  })

  it("a deflected big-change reply (model judges, no edit happens) produces NO commit — and nothing keyword-gates it", async () => {
    const { taskId, repoPath } = seedV4Task({ kind: "running" })
    const before = gitLogSubjects(repoPath)

    // 这条「大改动」指令里没有任何服务端会匹配的关键词表可依赖 ——
    // server 只做「回合后仓库是否变脏」的机械判断。
    h.queue.push({
      chunks: textResult(
        "这个改动跨三个模块、还要新增接口，属结构性变更。建议不要在此对话直接动手：请走「打回 → 修复轮」，反馈指令草稿我已替你整理好：「为订单域新增批量改价接口并同步改造前端表单」。",
      ),
    })
    const res = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "重写订单模块并加批量改价接口" }),
    })
    expect(res.status).toBe(200)
    const sseText = await res.text()
    expect(sseText).not.toContain("event: quick_edit_commit")

    expect(gitLogSubjects(repoPath)).toEqual(before)
    // 劝退回复照常持久化，人看得见
    const bound = db.prepare("SELECT doer_session_id FROM tasks WHERE id = ?").get(taskId) as { doer_session_id: string }
    const msgs = chatSvc.getAllMessages(bound.doer_session_id)
    expect(msgs.some((m) => m.role === "assistant" && m.content.includes("修复轮"))).toBe(true)
  })

  it("接管回合的有效编辑落 [takeover-edit]（不双计快改列），尾帧名与 awaiting 契约逐字不变", async () => {
    // 票10 review-1（spec US30 / ADR-0025）：接管中（takeover_at 已写、未交付）
    // 的对话回合落 [takeover-edit] —— 台账「快速修改」列只数 [quick-edit]，
    // 接管列认 executions.takeover_* DB 源，三本账不互抄、不双计。
    const { taskId, repoPath } = seedV4Task({ kind: "running" })
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim()
    db.prepare("UPDATE executions SET takeover_at = ? WHERE task_id = ?")
      .run(new Date().toISOString(), taskId)
    const before = gitLogSubjects(repoPath)

    h.queue.push(editTurn("接管改一处。", path.join("app", "src", "tk.ts"), "export const tk = 1\n"))
    const res = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "按钮圆角从 8px 收到 6px" }),
    })
    expect(res.status).toBe(200)
    const sseText = await res.text()
    // 尾帧事件名不变（票07/10 契约）；payload 的 message 换成接管标记。
    expect(sseText).toContain("event: quick_edit_commit")

    const after = gitLogSubjects(repoPath)
    expect(after.length).toBe(before.length + 1)
    expect(after[0].startsWith("[takeover-edit]")).toBe(true)
    expect(after[0]).not.toMatch(/^\[quick-edit\]/)
    expect(after[0]).toContain("按钮圆角从 8px 收到 6px")
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath, encoding: "utf-8" }).trim()).toBe(branch)

    // 注入的写纪律同步换词 —— 模型看到的每回合纪律与 server 实际落的标记一致。
    const call = h.calls[0]
    const append = (call.options as { systemPrompt?: { append?: string } }).systemPrompt?.append ?? ""
    expect(append).toContain("[takeover-edit]")
  })

  it("接管交付后的回合回到 [quick-edit]（待验收小改 = 快速修改，票01 契约字符串）", async () => {
    const { taskId, repoPath } = seedV4Task({ kind: "awaiting_review" })
    const now = new Date().toISOString()
    db.prepare("UPDATE executions SET takeover_at = ?, takeover_delivered_at = ? WHERE task_id = ?")
      .run(now, now, taskId)

    h.queue.push(editTurn("交付后再小改。", path.join("app", "src", "post.ts"), "export const p = 1\n"))
    const res = await app.request(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "文案再收一下" }),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(gitLogSubjects(repoPath)[0].startsWith("[quick-edit]")).toBe(true)
  })

  it("task isolation: chatting on A never touches B's workspace or session", async () => {
    const a = seedV4Task({ kind: "awaiting_review" })
    const b = seedV4Task({ kind: "awaiting_review" })
    const bLogBefore = gitLogSubjects(b.repoPath)
    const bUiExists = fs.existsSync(path.join(b.repoPath, "src", "ui.ts"))

    h.queue.push(editTurn("A 已改。", path.join("app", "src", "ui.ts"), "export const x = 1\n"))
    const res = await app.request(`/api/tasks/${a.taskId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "改一下 A 的 ui" }),
    })
    expect(res.status).toBe(200)
    await res.text()

    // A 的仓有了 [quick-edit] 提交
    expect(gitLogSubjects(a.repoPath)[0].startsWith("[quick-edit]")).toBe(true)
    // B 的仓纹丝不动 —— 提交数、工作区、文件都不变
    expect(gitLogSubjects(b.repoPath)).toEqual(bLogBefore)
    expect(fs.existsSync(path.join(b.repoPath, "src", "ui.ts"))).toBe(bUiExists)
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: b.repoPath, encoding: "utf-8" }).trim()).toBe("")
    // B 的会话独立（未因 A 的对话产生消息）
    const bRow = db.prepare("SELECT doer_session_id FROM tasks WHERE id = ?").get(b.taskId) as { doer_session_id: string | null }
    expect(bRow.doer_session_id).toBeNull()
  })
})
