// design 23 §3.2/§3.3/§4 — 舱任务的三个归属约束：
//
//   1. 舱内本地 / 外部项目不在 org `repos/index.md` 里 → 任务解析项目路径时
//      回落到 `<cabin>/config.json.repos[]`（context.md 与入队门都吃同一解析）。
//   2. 入队政策：无项目的舱允许 v4 任务不绑项目（没有 worktree 可开）；有项目的
//      舱仍必须绑至少一个。
//   3. 每个舱任务建自己的 workspace（不再复用舱 workspace）—— `.task` home
//      不会互相覆盖。
//
// 真实 better-sqlite3 + applySchema + 临时任务 home，不 mock 解析逻辑。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { resolveTaskProjectPath } from "../services/tasks/task-project-resolver"
import { buildTaskLaunchConfig } from "../services/tasks/task-materialize"
import type { WorkspaceService } from "../services/workspace"

const NOW = "2026-11-16T09:00:00.000Z"
const CABIN_ID = "cabin-proj"

let db: Database.Database
let tmpDir: string
let cabinDir: string
let taskHome: TaskHomeService
let service: TasksService
let wsSeq = 0

const builtIn = {
  get(ref: string) {
    return ref === "built-in/smoke" ? { ref, content: "name: smoke\n" } : null
  },
}

function newDb(): Database.Database {
  const d = new Database(":memory:")
  applySchema(d)
  return d
}

function writeCabinConfig(repos: unknown[]): void {
  fs.writeFileSync(path.join(cabinDir, "config.json"), JSON.stringify({ name: "舱", repos }), "utf-8")
}

function insertCabin(): void {
  db.prepare(`
    INSERT INTO cabins (id, name, path, workspace_id, main_session_id, requirements, status,
      mainline_strategy, org, init_state, cockpit_prefs, focused_job_id, version,
      created_at, updated_at, last_active_at, archived_at, deleted_at)
    VALUES (?, '舱', ?, NULL, NULL, '', 'active', 'clean-main', 'org', NULL, NULL, NULL, 1, ?, ?, ?, NULL, NULL)
  `).run(CABIN_ID, cabinDir, NOW, NOW, NOW)
}

function insertDraftTask(id: string, opts: { workspaceId: string | null; projectIds: string[] }): void {
  const spec = {
    format: "v4",
    phases: [{
      index: 1, name: "Phase 1", slug: "p1",
      specPath: path.join(".scratch", "v4d", "p1", "spec.md"),
      workflowRef: "built-in/smoke", inputValues: {},
    }],
    acceptance_verify: { command: "true" },
  }
  db.prepare(`
    INSERT INTO tasks (id, repo_group, name, status, task_spec, project_ids, workspace_id,
      cabin_id, workflow_ref, version, created_at, updated_at)
    VALUES (?, NULL, ?, 'draft', ?, ?, ?, ?, NULL, 1, ?, ?)
  `).run(id, `任务 ${id}`, JSON.stringify(spec), JSON.stringify(opts.projectIds), opts.workspaceId, CABIN_ID, NOW, NOW)

  const home = taskHome.homePath(id)
  const specAbs = path.join(home, ".scratch", "v4d", "p1", "spec.md")
  fs.mkdirSync(path.dirname(specAbs), { recursive: true })
  fs.writeFileSync(specAbs, "# spec\n", "utf-8")
  const ticketAbs = path.join(home, ".scratch", "v4d", "p1", "issues", "01-plan.md")
  fs.mkdirSync(path.dirname(ticketAbs), { recursive: true })
  fs.writeFileSync(ticketAbs, "# ticket\n", "utf-8")
}

function fakeWorkspaceService(): WorkspaceService {
  return {
    createFromSpec: vi.fn(() => {
      wsSeq += 1
      return { id: `ws-${wsSeq}`, path: path.join(tmpDir, `ws-${wsSeq}`) }
    }),
    getById: vi.fn(),
    attachDirectory: vi.fn(),
  } as unknown as WorkspaceService
}

beforeAll(() => {
  db = newDb()
  tmpDir = path.join(os.tmpdir(), `test-cabin-proj-${Date.now()}`)
  cabinDir = path.join(tmpDir, "cabin")
  fs.mkdirSync(cabinDir, { recursive: true })
  taskHome = new TaskHomeService(path.join(tmpDir, "octopus-home"))
  service = new TasksService(
    db, new SSEService(), undefined, taskHome, undefined, builtIn, null,
    fakeWorkspaceService(),
  )
  insertCabin()
})

afterAll(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("舱项目解析（design 23 §3.2）", () => {
  it("createTask：本地项目从舱 config 解析进 context.md（repo_group 为空也能解析）", () => {
    const repoDir = path.join(cabinDir, "apps", "console")
    fs.mkdirSync(repoDir, { recursive: true })
    writeCabinConfig([{ name: "console", source: "local", local_path: "apps/console" }])

    const task = service.createTask({
      name: "舱本地任务",
      cabin_id: CABIN_ID,
      task_spec: { format: "v4" },
      preset: { projects: ["console"] },
    })
    const ctx = fs.readFileSync(path.join(taskHome.homePath(task.id), "context.md"), "utf-8")
    expect(ctx).toContain(`project: console  →  ${repoDir}`)
  })

  it("readyTask：舱本地项目（repos/index.md 无此条目）通过 project 门", () => {
    insertDraftTask("task-local-ok", { workspaceId: "ws-cabin", projectIds: ["console"] })
    expect(() => service.readyTask("task-local-ok")).not.toThrow()
  })

  it("readyTask：解析不到的项目仍然挡住入队", () => {
    insertDraftTask("task-local-bad", { workspaceId: "ws-cabin", projectIds: ["missing-repo"] })
    expect(() => service.readyTask("task-local-bad")).toThrow(/project:missing-repo/)
  })
})

describe("无项目舱的入队政策（design 23 §3.3）", () => {
  it("舱有项目但任务没绑 → project-binding", () => {
    writeCabinConfig([{ name: "console", source: "local", local_path: "apps/console" }])
    insertDraftTask("task-no-binding", { workspaceId: "ws-cabin", projectIds: [] })
    expect(() => service.readyTask("task-no-binding")).toThrow(/project-binding/)
  })

  it("舱一个项目都没有 → 放行（无 worktree 可开）", () => {
    writeCabinConfig([])
    insertDraftTask("task-empty-cabin", { workspaceId: "ws-cabin", projectIds: [] })
    expect(() => service.readyTask("task-empty-cabin")).not.toThrow()
    // 后续用例恢复「有项目」的舱口径。
    writeCabinConfig([{ name: "console", source: "local", local_path: "apps/console" }])
  })
})

describe("任务 workspace 隔离（design 23 §4）", () => {
  it("两个舱任务各自建 workspace（不再复用同一个舱 workspace）", () => {
    writeCabinConfig([])
    const a = service.createTask({ name: "A", cabin_id: CABIN_ID, task_spec: { format: "v4" } })
    const b = service.createTask({ name: "B", cabin_id: CABIN_ID, task_spec: { format: "v4" } })
    expect(a.workspace_id).toBeTruthy()
    expect(b.workspace_id).toBeTruthy()
    expect(a.workspace_id).not.toBe(b.workspace_id)
  })
})

describe("舱项目解析与 org 注册表共存", () => {
  it("resolveProjectRefs 非舱任务行为不变（无 repo_group 且无舱 → 只有名字）", () => {
    // 直接走一次 createTask（无 cabin_id）：项目解析不应借用任何舱 config。
    const task = service.createTask({ name: "普通任务", task_spec: { format: "v4" }, preset: { projects: ["console"] } })
    const ctx = fs.readFileSync(path.join(taskHome.homePath(task.id), "context.md"), "utf-8")
    expect(ctx).toContain("project: console  (路径未解析)")
  })

  it("resolveTaskProjectPath：非舱任务不借用舱 config；舱任务可解析", () => {
    const repoDir = path.join(cabinDir, "apps", "console")
    fs.mkdirSync(repoDir, { recursive: true })
    writeCabinConfig([{ name: "console", source: "local", local_path: "apps/console" }])
    expect(resolveTaskProjectPath(db, { repo_group: null, cabin_id: CABIN_ID }, "console")).toBe(repoDir)
    expect(resolveTaskProjectPath(db, { repo_group: null, cabin_id: null }, "console")).toBeNull()
  })

  it("buildTaskLaunchConfig：projectSources → workspace_spec.projects[].source_path", () => {
    const config = buildTaskLaunchConfig(
      {} as never, ["console"], "org", undefined, undefined, undefined, undefined, undefined, undefined,
      { console: "/tmp/cabin/apps/console" },
    )
    expect(config.workspace_spec.projects[0]).toEqual({
      name: "console", source_path: "/tmp/cabin/apps/console", group: "",
    })
  })
})
