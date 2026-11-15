import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { applySchema } from "../../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../../db/dao"
import { WorkspaceService } from "../../workspace"
import { initSessionService } from "../../agent/session-service"
import { CabinService, WorktreeConflictError } from "../cabin-service"
import { readCabinConfig } from "../cabin-repos"

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd, encoding: "utf-8",
  })
}

function makeRepo(dir: string, branch = "main"): void {
  fs.mkdirSync(dir, { recursive: true })
  expect(git(dir, ["init", "-b", branch]).status).toBe(0)
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n")
  expect(git(dir, ["add", "."]).status).toBe(0)
  expect(git(dir, ["commit", "-m", "init"]).status).toBe(0)
}

describe("CabinService · 项目关联 / 工作树 / 锚点", () => {
  let db: Database.Database
  let dao: CabinDAO
  let svc: CabinService
  let cabinPath: string
  let outsideDir: string
  let cabinId: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new CabinDAO(db)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-projects-"))
    cabinPath = path.join(tmp, "cabins", "ledger")
    outsideDir = path.join(tmp, "outside")
    fs.mkdirSync(cabinPath, { recursive: true })
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    svc = new CabinService(dao)
    svc.bindInfra({
      workspaceService: new WorkspaceService(new WorkspaceDAO(db)),
      workspaceDAO: new WorkspaceDAO(db),
      agentSessionDAO,
      taskDAO: new TaskDAO(db),
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
    } as never)
    cabinId = svc.create({ name: "账务舱", path: cabinPath }).id
  })

  afterEach(() => {
    db.close()
    fs.rmSync(path.dirname(path.dirname(cabinPath)), { recursive: true, force: true })
  })

  function addLocal(name = "console", branch = "feat/console") {
    const abs = path.join(cabinPath, "apps", name)
    makeRepo(abs, branch)
    return svc.addRepo(cabinId, { source: "local", name, localPath: path.join("apps", name) })
  }

  it("addRepo(本地)：只登记，不建工作树", () => {
    const entry = addLocal()
    expect(entry.source).toBe("local")
    expect(entry.worktree_path).toBeUndefined()
    expect(entry.branch).toBeUndefined()
    expect(entry.mainline_branch).toBe("feat/console")
    // workspace.create 会先 scaffold 空 projects/；关键是没有这个项目的工作树。
    expect(fs.existsSync(path.join(cabinPath, "projects", "console"))).toBe(false)

    const view = svc.repoViews(cabinId)[0]
    expect(view.key).toBe("local:apps/console")
    expect(view.source).toBe("local")
    expect(view.external).toBe(false)
  })

  it("addRepo(舱外)：没带 external 拒绝；带了就登记为外部只读引用", () => {
    const abs = path.join(outsideDir, "shared")
    makeRepo(abs)
    expect(() => svc.addRepo(cabinId, {
      source: "local", name: "shared", absolutePath: abs,
    })).toThrow(/external/)
    const entry = svc.addRepo(cabinId, {
      source: "local", name: "shared", absolutePath: abs, external: true,
    })
    expect(entry.external).toBe(true)
    expect(svc.repoViews(cabinId)[0].external).toBe(true)
  })

  it("openRepoWorktree：主实例落 projects/<name>，source/local 字段不丢", () => {
    addLocal()
    const entry = svc.openRepoWorktree(cabinId, "console")
    expect(entry.worktree_path).toBe(path.join(cabinPath, "projects", "console"))
    expect(entry.branch).toMatch(/^cabin-/)
    expect(entry.source).toBe("local")
    expect(entry.local_path).toBe("apps/console")
    expect(fs.existsSync(path.join(entry.worktree_path!, "a.txt"))).toBe(true)
    // 主仓没有被改动：仍是干净的主线。
    const status = git(path.join(cabinPath, "apps", "console"), ["status", "--porcelain"])
    expect(status.stdout.trim()).toBe("")
  })

  it("重复开同分支 → WorktreeConflictError，且不删已有工作树", () => {
    addLocal()
    const first = svc.openRepoWorktree(cabinId, "console")
    expect(() => svc.openRepoWorktree(cabinId, "console")).toThrow(WorktreeConflictError)
    expect(fs.existsSync(path.join(first.worktree_path!, "a.txt"))).toBe(true)
  })

  it("换分支 → 并行实例落 projects/<instance>/<name> 并登记 worktrees[]", () => {
    addLocal()
    svc.openRepoWorktree(cabinId, "console")
    const second = svc.openRepoWorktree(cabinId, "console", { branch: "feat/parallel", instance: "job-7" })
    expect(second.worktrees).toHaveLength(1)
    expect(second.worktrees![0].instance).toBe("job-7")
    expect(second.worktrees![0].path).toBe(
      path.join(cabinPath, "projects", "job-7", "console"),
    )
    expect(fs.existsSync(path.join(second.worktrees![0].path, "a.txt"))).toBe(true)
    // 主实例还在。
    expect(fs.existsSync(path.join(cabinPath, "projects", "console", "a.txt"))).toBe(true)
  })

  it("removeRepo：无活跃任务时只删 config，不动磁盘", () => {
    const entry = addLocal()
    const wt = svc.openRepoWorktree(cabinId, "console")
    expect(svc.removeRepo(cabinId, "console").removed).toBe(true)
    expect(readCabinConfig(cabinPath).repos).toHaveLength(0)
    expect(fs.existsSync(path.join(cabinPath, "apps", "console"))).toBe(true)
    expect(fs.existsSync(wt.worktree_path!)).toBe(true)
    expect(entry.name).toBe("console")
  })

  it("removeRepo：项目上有活跃任务 → 拒绝", () => {
    addLocal()
    const ts = new Date().toISOString()
    db.prepare(
      `INSERT INTO tasks (id, repo_group, name, status, project_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("t-live", "console", "活跃任务", "running", JSON.stringify(["console"]), ts, ts)
    db.prepare("UPDATE tasks SET cabin_id = ? WHERE id = ?").run(cabinId, "t-live")
    expect(() => svc.removeRepo(cabinId, "console")).toThrow(/活跃任务/)
  })

  it("listJobsView：task 按 repo_group / project_ids 落项目锚点；零命中 = []", () => {
    addLocal()
    const ts = new Date().toISOString()
    db.prepare(
      `INSERT INTO tasks (id, repo_group, name, status, project_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("t-1", "console", "对齐尾差", "running", JSON.stringify(["console"]), ts, ts)
    db.prepare("UPDATE tasks SET cabin_id = ? WHERE id = ?").run(cabinId, "t-1")
    db.prepare(
      `INSERT INTO tasks (id, repo_group, name, status, project_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("t-2", null, "杂活", "running", "[]", ts, ts)
    db.prepare("UPDATE tasks SET cabin_id = ? WHERE id = ?").run(cabinId, "t-2")

    svc.dispatchJob(cabinId, { kind: "task", ref_id: "t-1", title: "对齐尾差" })
    svc.dispatchJob(cabinId, { kind: "task", ref_id: "t-2", title: "杂活" })

    const view = svc.listJobsView(cabinId)
    const anchored = view.find((j) => j.ref_id === "t-1")!
    const loose = view.find((j) => j.ref_id === "t-2")!
    expect(anchored.project_keys).toEqual(["local:apps/console"])
    expect(loose.project_keys).toEqual([])
  })

  it("listJobsView：workflow 经 execution → workspace config 归属；多个/零个不算", () => {
    addLocal()
    const ts = new Date().toISOString()
    const wsPath = path.join(path.dirname(cabinPath), "task-ws")
    fs.mkdirSync(wsPath, { recursive: true })
    fs.writeFileSync(path.join(wsPath, "config.json"), JSON.stringify({
      repos: [{ name: "console" }, { name: "other" }],
    }))
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run("ws-1", "task-ws", wsPath, ts, ts)
    db.prepare(
      "INSERT INTO executions (id, workspace_id, workflow_ref, workflow_name, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("ex-1", "ws-1", "w.yaml", "wf", ts, ts)
    svc.dispatchJob(cabinId, { kind: "workflow", ref_id: "ex-1", title: "跑流" })

    // 舱里只有一个项目 console 命中 → 归属。
    const one = svc.listJobsView(cabinId).find((j) => j.ref_id === "ex-1")!
    expect(one.project_keys).toEqual(["local:apps/console"])

    // 再加一个同名可达项目 → 命中两个，不猜，返回空。
    makeRepo(path.join(cabinPath, "apps", "other"), "feat/other")
    svc.addRepo(cabinId, {
      source: "local", name: "other",
      localPath: path.join("apps", "other"),
    })
    const many = svc.listJobsView(cabinId).find((j) => j.ref_id === "ex-1")!
    expect(many.project_keys).toEqual([])
  })

  it("listJobsView：subagent 按 cwd 前缀归属，唯一命中才认", () => {
    addLocal()
    const ts = new Date().toISOString()
    db.prepare(
      `INSERT INTO sessions (id, cwd, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run("s-1", path.join(cabinPath, "apps", "console", "src"), ts, ts)
    db.prepare(
      `INSERT INTO subagent_runs (id, session_id, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("r-1", "s-1", "running", ts, ts, ts)
    svc.dispatchJob(cabinId, { kind: "subagent", ref_id: "r-1", title: "子代理" })
    const job = svc.listJobsView(cabinId).find((j) => j.ref_id === "r-1")!
    expect(job.project_keys).toEqual(["local:apps/console"])
  })
})