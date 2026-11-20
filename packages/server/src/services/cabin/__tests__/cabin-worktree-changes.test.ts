// v22 十三轮（问题 #1）：本舱变更窗 —— 受管目录工作区改动（worktree vs HEAD + 未跟踪）。
// 真实 git 仓库 + 真实 DB（applySchema）；慢一点但口径就是 git 本身。
import { describe, it, expect, beforeEach, afterEach } from "vitest"
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
import { CabinService } from "../cabin-service"

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd, encoding: "utf-8",
  })
}

function makeRepo(dir: string, branch = "main"): void {
  fs.mkdirSync(dir, { recursive: true })
  expect(git(dir, ["init", "-b", branch]).status).toBe(0)
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n")
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src", "reconcile.ts"), "export const a = 1\n")
  expect(git(dir, ["add", "."]).status).toBe(0)
  expect(git(dir, ["commit", "-m", "init"]).status).toBe(0)
}

describe("CabinService · 本舱变更（受管目录工作区）", () => {
  let db: Database.Database
  let svc: CabinService
  let cabinPath: string
  let cabinId: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-changes-"))
    cabinPath = path.join(tmp, "cabins", "ledger")
    fs.mkdirSync(cabinPath, { recursive: true })
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    svc = new CabinService(new CabinDAO(db))
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

  function addLocal(name: string, branch = "main") {
    const abs = path.join(cabinPath, "apps", name)
    makeRepo(abs, branch)
    return { abs, entry: svc.addRepo(cabinId, { source: "local", name, localPath: path.join("apps", name) }) }
  }

  it("干净仓：零文件，分支 / HEAD 如实上报", async () => {
    const { entry } = addLocal("console", "feat/console")
    const view = await svc.worktreeChanges(cabinId)
    expect(view.dir).toBe(path.resolve(cabinPath))
    expect(view.repos).toHaveLength(1)
    const repo = view.repos[0]!
    expect(repo.name).toBe("console")
    expect(repo.dir).toBe(entry.main_path)
    expect(repo.error).toBeNull()
    expect(repo.branch).toBe("feat/console")
    expect(repo.head).toMatch(/^[0-9a-f]{7}$/)
    expect(repo.files).toEqual([])
  })

  it("改已跟踪文件 + 加未跟踪文件：M 带 ±行，未跟踪记 ?；patch 各自可拉", async () => {
    const { abs } = addLocal("console")
    fs.writeFileSync(path.join(abs, "src", "reconcile.ts"), "export const a = 2\nexport const b = 3\n")
    fs.writeFileSync(path.join(abs, "src", "new-post.ts"), "export const post = 1\n")

    const view = await svc.worktreeChanges(cabinId)
    const repo = view.repos[0]!
    expect(repo.error).toBeNull()
    const modified = repo.files.find((f) => f.path === "src/reconcile.ts")
    expect(modified).toMatchObject({ status: "M", adds: 2, dels: 1 })
    expect(modified?.untracked).toBeUndefined()
    const untracked = repo.files.find((f) => f.path === "src/new-post.ts")
    expect(untracked).toMatchObject({ status: "?", untracked: true, adds: 1, dels: 0 })

    const tracked = await svc.worktreeChangePatch(cabinId, "console", "src/reconcile.ts", false)
    expect(tracked.patch).toContain("+export const b = 3")
    expect(tracked.patch).toContain("-export const a = 1")

    const fresh = await svc.worktreeChangePatch(cabinId, "console", "src/new-post.ts", true)
    expect(fresh.patch).toContain("+export const post = 1")
  })

  it("优先比对 worktree_path；目录不在 / 非 git 仓 → 单仓 error，不连累别的仓", async () => {
    const { abs } = addLocal("console")
    // 手工登记一个 worktree_path —— 变更应当从它读，而不是 main_path。
    const wt = path.join(cabinPath, "projects", "console")
    makeRepo(wt, "feat/wt")
    fs.writeFileSync(path.join(wt, "a.txt"), "changed in worktree\n")
    const configPath = path.join(cabinPath, "config.json")
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { repos: Array<Record<string, unknown>> }
    const hit = config.repos.find((r) => r.name === "console")!
    hit.worktree_path = wt
    // 另一个仓的目录直接不存在（stale 登记）—— 不能连累 console。
    config.repos.push({ name: "ghost", source: "local", main_path: path.join(cabinPath, "nope") })
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

    // worktree 里的改动必须在 —— main_path 里的工作区没动。
    fs.writeFileSync(path.join(abs, "a.txt"), "changed in main\n")

    const view = await svc.worktreeChanges(cabinId)
    const consoleRepo = view.repos.find((r) => r.name === "console")!
    expect(consoleRepo.dir).toBe(wt)
    expect(consoleRepo.files.map((f) => f.path)).toContain("a.txt")
    expect(consoleRepo.files.find((f) => f.path === "a.txt")?.adds).toBe(1)

    const ghost = view.repos.find((r) => r.name === "ghost")!
    expect(ghost.error).toBeTruthy()
    expect(ghost.files).toEqual([])
  })

  it("空仓（还没 commit）：head=null，但未跟踪文件照列", async () => {
    const abs = path.join(cabinPath, "apps", "empty")
    fs.mkdirSync(abs, { recursive: true })
    expect(git(abs, ["init", "-b", "main"]).status).toBe(0)
    fs.writeFileSync(path.join(abs, "draft.md"), "# draft\n")
    svc.addRepo(cabinId, { source: "local", name: "empty", localPath: path.join("apps", "empty") })

    const view = await svc.worktreeChanges(cabinId)
    const repo = view.repos[0]!
    expect(repo.error).toBeNull()
    expect(repo.head).toBeNull()
    expect(repo.files.map((f) => f.path)).toContain("draft.md")
  })

  it("patch 守卫：越出仓库根 / 绝对路径 / 未知仓一律拒绝", async () => {
    addLocal("console")
    await expect(svc.worktreeChangePatch(cabinId, "console", "../escape.ts", false)).rejects.toThrow(/越出|非法/)
    await expect(svc.worktreeChangePatch(cabinId, "console", "C:\\Windows\\win.ini", false)).rejects.toThrow(/非法/)
    await expect(svc.worktreeChangePatch(cabinId, "nope", "a.txt", false)).rejects.toThrow(/repo not in cabin/)
  })
})
