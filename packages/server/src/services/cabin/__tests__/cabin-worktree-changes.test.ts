// v22 十三轮（问题 #1）：本舱变更窗 —— 本舱 cwd 的工作区改动（worktree vs HEAD + 未跟踪）。
// 口径 = cabin.path 本身这一个 git 仓库；登记在 config.json.repos 下的项目不参与。
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

function makeRepo(dir: string, branch = "main", files: Record<string, string> = {
  "a.txt": "hello\n",
  "src/reconcile.ts": "export const a = 1\n",
}): void {
  fs.mkdirSync(dir, { recursive: true })
  expect(git(dir, ["init", "-b", branch]).status).toBe(0)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  expect(git(dir, ["add", "."]).status).toBe(0)
  expect(git(dir, ["commit", "-m", "init"]).status).toBe(0)
}

describe("CabinService · 本舱变更（cwd 自身的工作区）", () => {
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

  it("干净 cwd 仓：零文件，分支 / HEAD 如实上报", async () => {
    makeRepo(cabinPath, "feat/cwd")
    const view = await svc.worktreeChanges(cabinId)
    expect(view.dir).toBe(path.resolve(cabinPath))
    expect(view.repos).toHaveLength(1)
    const repo = view.repos[0]!
    expect(repo.name).toBe("ledger")
    expect(repo.dir).toBe(path.resolve(cabinPath))
    expect(repo.error).toBeNull()
    expect(repo.branch).toBe("feat/cwd")
    expect(repo.head).toMatch(/^[0-9a-f]{7}$/)
    expect(repo.files).toEqual([])
  })

  it("改已跟踪文件 + 加未跟踪文件：M 带 ±行，未跟踪记 ?；patch 各自可拉", async () => {
    makeRepo(cabinPath)
    fs.writeFileSync(path.join(cabinPath, "src", "reconcile.ts"), "export const a = 2\nexport const b = 3\n")
    fs.writeFileSync(path.join(cabinPath, "src", "new-post.ts"), "export const post = 1\n")

    const view = await svc.worktreeChanges(cabinId)
    const repo = view.repos[0]!
    expect(repo.error).toBeNull()
    const modified = repo.files.find((f) => f.path === "src/reconcile.ts")
    expect(modified).toMatchObject({ status: "M", adds: 2, dels: 1 })
    expect(modified?.untracked).toBeUndefined()
    const untracked = repo.files.find((f) => f.path === "src/new-post.ts")
    expect(untracked).toMatchObject({ status: "?", untracked: true, adds: 1, dels: 0 })

    const tracked = await svc.worktreeChangePatch(cabinId, "ledger", "src/reconcile.ts", false)
    expect(tracked.patch).toContain("+export const b = 3")
    expect(tracked.patch).toContain("-export const a = 1")

    const fresh = await svc.worktreeChangePatch(cabinId, "ledger", "src/new-post.ts", true)
    expect(fresh.patch).toContain("+export const post = 1")
  })

  it("只认 cwd：登记在 config.json.repos 的舱外项目改动不算进来", async () => {
    makeRepo(cabinPath, "main", { "a.txt": "hello\n" })
    // 舱外登记项目（external）——旧口径会扫它；新口径只看 cwd。
    const outside = path.join(path.dirname(cabinPath), "external-repo")
    makeRepo(outside)
    svc.addRepo(cabinId, { source: "local", name: "edge", absolutePath: outside, external: true })
    fs.writeFileSync(path.join(outside, "a.txt"), "changed outside\n")
    fs.writeFileSync(path.join(outside, "src", "reconcile.ts"), "export const outside = 1\n")

    const view = await svc.worktreeChanges(cabinId)
    expect(view.repos).toHaveLength(1)
    const repo = view.repos[0]!
    expect(repo.dir).toBe(path.resolve(cabinPath))
    // 只有 cwd 自己因登记项目而改的 workspace 配置；外部仓的 a.txt / reconcile.ts 不出现。
    expect(repo.files.map((f) => f.path)).toEqual([".octopus/config.json"])
  })

  it("cwd 不是 git 仓：error 如实上报，files 为空", async () => {
    const view = await svc.worktreeChanges(cabinId)
    const repo = view.repos[0]!
    expect(repo.dir).toBe(path.resolve(cabinPath))
    expect(repo.error).toMatch(/不是 git 仓库/)
    expect(repo.files).toEqual([])
  })

  it("空仓（还没 commit）：head=null，但未跟踪文件照列", async () => {
    expect(git(cabinPath, ["init", "-b", "main"]).status).toBe(0)
    fs.writeFileSync(path.join(cabinPath, "draft.md"), "# draft\n")

    const view = await svc.worktreeChanges(cabinId)
    const repo = view.repos[0]!
    expect(repo.error).toBeNull()
    expect(repo.head).toBeNull()
    expect(repo.files.map((f) => f.path)).toContain("draft.md")
  })

  it("patch 守卫：越出仓库根 / 绝对路径 / 未知仓一律拒绝", async () => {
    makeRepo(cabinPath, "main", { "a.txt": "hello\n" })
    await expect(svc.worktreeChangePatch(cabinId, "ledger", "../escape.ts", false)).rejects.toThrow(/越出|非法/)
    await expect(svc.worktreeChangePatch(cabinId, "ledger", "/etc/passwd", false)).rejects.toThrow(/非法/)
    await expect(svc.worktreeChangePatch(cabinId, "nope", "a.txt", false)).rejects.toThrow(/repo not in cabin/)
  })
})
