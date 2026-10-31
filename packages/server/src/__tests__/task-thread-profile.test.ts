// packages/server/src/__tests__/task-thread-profile.test.ts
//
// M1-1 — TaskThreadService: one main chat session per task, identity derived
// from the task's state. Pure profile resolution (no chat route involved).
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../db/schema"
import { TaskThreadService } from "../services/tasks/task-thread-service"
import { TaskHomeService } from "../services/tasks/task-home-service"

const ORG = "e2e-thread"
let db: Database.Database
let tmp: string
let wsDir: string
let taskHomeBase: string
let service: TaskThreadService
let seq = 0

const NOW = "2026-10-28T10:00:00.000Z"

function insertSession(id: string, cloneName: string | null): void {
  db.prepare(`
    INSERT INTO sessions (id, org, title, clone_name, session_type, is_active, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).run(id, ORG, "thread", cloneName, cloneName ? "clone_direct" : "main", NOW, NOW)
}

function insertTask(opts: {
  status: string
  sessionId: string
  workspaceId?: string | null
  spec?: unknown
}): string {
  const id = `task-${seq++}`
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec, created_at, updated_at, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, ORG, `任务 ${id}`, opts.status, opts.sessionId,
    JSON.stringify(opts.spec ?? {
      format: "v4",
      slug: "demo",
      phases: [{ index: 1, name: "P1", slug: "p-1", specPath: "./.scratch/demo/p-1/spec.md", workflowRef: "built-in/matt-spec-dev", inputValues: {} }],
    }),
    NOW, NOW, opts.workspaceId ?? null,
  )
  return id
}

function insertExec(taskId: string, opts: { status: string; phase?: number; round?: number } = { status: "completed" }): void {
  db.prepare(`
    INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status,
      task_id, phase_index, round_index, start_commit_id, end_commit_id,
      started_at, completed_at, created_at, updated_at)
    VALUES (?, 'ws-thread', ?, 'built-in/matt-spec-dev', 'dev', ?, ?, ?, ?,
      '{}', '{}', ?, ?, ?, ?)
  `).run(
    `exec-${seq++}`, ORG, opts.status, taskId,
    opts.phase ?? 1, opts.round ?? 1,
    NOW, opts.status === "completed" ? NOW : null, NOW, NOW,
  )
}

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "thread-profile-"))
  wsDir = path.join(tmp, "ws")
  taskHomeBase = path.join(tmp, "octopus")
  fs.mkdirSync(wsDir, { recursive: true })
  fs.mkdirSync(path.join(wsDir, ".scratch"), { recursive: true })
  db.prepare(`
    INSERT INTO workspaces (id, name, repo_group, path, created_at, updated_at)
    VALUES ('ws-thread', 'thread-ws', ?, ?, ?, ?)
  `).run(ORG, wsDir, NOW, NOW)
  service = new TaskThreadService({
    db,
    workspaceService: {
      getById: (id: string) => (id === "ws-thread" ? { id, path: wsDir } : undefined),
    } as never,
    taskHomeService: new TaskHomeService(taskHomeBase),
  })
})

afterAll(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("TaskThreadService — activation gate", () => {
  it("legacy clone sessions are never task threads", () => {
    insertSession("s-clone", "task-author")
    insertTask({ status: "draft", sessionId: "s-clone" })
    expect(service.resolveForSession({ id: "s-clone", clone_name: "task-author" })).toBeNull()
  })

  it("a main session without a bound task is not a thread", () => {
    insertSession("s-free", null)
    expect(service.resolveForSession({ id: "s-free", clone_name: null })).toBeNull()
  })
})

describe("TaskThreadService — identity / cwd / guard", () => {
  it("draft → author: task-home cwd, home fence, no auto-commit", async () => {
    insertSession("s-draft", null)
    const taskId = insertTask({ status: "draft", sessionId: "s-draft" })
    const home = path.join(taskHomeBase, "tasks", taskId)
    fs.mkdirSync(home, { recursive: true })
    const profile = service.resolveForSession({ id: "s-draft", clone_name: null })!
    expect(profile.identity).toBe("author")
    expect(profile.cwd).toBe(home)
    expect(profile.autoCommit).toBe(false)
    expect(profile.readOnly).toBe(false)
    expect(profile.context).toContain("任务作者")
    expect(profile.context).toContain(taskId)
    // inside home allowed
    await expect(profile.guard!("Write", { file_path: path.join(home, "spec.md") })).resolves.toBeUndefined()
    // outside home blocked
    const denied = await profile.guard!("Write", { file_path: path.join(wsDir, "projects", "app", "x.ts") })
    expect(denied?.allow).toBe(false)
  })

  it("ready without a workspace → doer but read-only", async () => {
    insertSession("s-ready", null)
    insertTask({ status: "ready", sessionId: "s-ready" })
    const profile = service.resolveForSession({ id: "s-ready", clone_name: null })!
    expect(profile.identity).toBe("doer")
    expect(profile.readOnly).toBe(true) // no execution workspace yet
    expect(profile.autoCommit).toBe(false) // no workspace yet
    const denied = await profile.guard!("Write", { file_path: path.join(wsDir, "projects", "app", "x.ts") })
    expect(denied?.allow).toBe(false)
  })

  it("running with a workspace → doer write, batch fence, auto-commit", async () => {
    insertSession("s-run", null)
    const taskId = insertTask({ status: "running", sessionId: "s-run", workspaceId: "ws-thread" })
    insertExec(taskId, { status: "running" })
    const profile = service.resolveForSession({ id: "s-run", clone_name: null })!
    expect(profile.identity).toBe("doer")
    expect(profile.cwd).toBe(wsDir)
    expect(profile.autoCommit).toBe(true)
    expect(profile.context).toContain(wsDir)
    // normal project write allowed
    await expect(profile.guard!("Write", { file_path: path.join(wsDir, "projects", "app", "x.ts") })).resolves.toBeUndefined()
    // batch mirror blocked
    const denied = await profile.guard!("Write", { file_path: path.join(wsDir, ".scratch", "demo", "spec.md") })
    expect(denied?.allow).toBe(false)
  })

  it("persisted running + completed round derives awaiting_review; identity stays doer", () => {
    insertSession("s-await", null)
    const taskId = insertTask({ status: "running", sessionId: "s-await", workspaceId: "ws-thread" })
    insertExec(taskId, { status: "completed" })
    const profile = service.resolveForSession({ id: "s-await", clone_name: null })!
    expect(profile.task.displayStatus).toBe("awaiting_review")
    expect(profile.task.awaitingReview).toBe(true)
    expect(profile.identity).toBe("doer")
    expect(profile.context).toContain("待验收")
    expect(profile.context).toContain("submit_acceptance_decision")
  })

  it("archiving → doer but read-only (archive owns git)", async () => {
    insertSession("s-arch", null)
    insertTask({ status: "archiving", sessionId: "s-arch", workspaceId: "ws-thread" })
    const profile = service.resolveForSession({ id: "s-arch", clone_name: null })!
    expect(profile.identity).toBe("doer")
    expect(profile.readOnly).toBe(true)
    expect(profile.autoCommit).toBe(false)
    // 2026-10-31 AI-native 归档：主 Chat 拿到归档引导上下文（播报 + 逐条问反思 + 口头执行）
    expect(profile.archiveGuide).toBe(true)
    expect(profile.context).toContain("归档引导")
    expect(profile.context).toContain("get_archive_state")
    const denied = await profile.guard!("Write", { file_path: path.join(wsDir, "projects", "app", "x.ts") })
    expect(denied?.allow).toBe(false)
    // reflection still needs read-only shell
    await expect(profile.guard!("Bash", { command: "git diff HEAD~1 --stat" })).resolves.toBeUndefined()
    const shellDenied = await profile.guard!("Bash", { command: "echo x > src/a.ts" })
    expect(shellDenied?.allow).toBe(false)
  })

  it("done → base read-only retrospective", async () => {
    insertSession("s-done", null)
    insertTask({ status: "done", sessionId: "s-done", workspaceId: "ws-thread" })
    const profile = service.resolveForSession({ id: "s-done", clone_name: null })!
    expect(profile.identity).toBe("base")
    expect(profile.readOnly).toBe(true)
    expect(profile.context).toContain("只读回顾")
  })
})
