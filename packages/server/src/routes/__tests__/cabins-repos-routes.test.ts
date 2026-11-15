import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { Hono } from "hono"
import { applySchema } from "../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../db/dao"
import { WorkspaceService } from "../../services/workspace"
import { initSessionService } from "../../services/agent/session-service"
import { SSEService } from "../../services/sse"
import { CabinService } from "../../services/cabin/cabin-service"
import { CabinInitService } from "../../services/cabin/cabin-init-service"
import { createCabinRoutes } from "../cabins"

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd, encoding: "utf-8",
  })
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  expect(git(dir, ["init", "-b", "main"]).status).toBe(0)
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n")
  expect(git(dir, ["add", "."]).status).toBe(0)
  expect(git(dir, ["commit", "-m", "init"]).status).toBe(0)
}

describe("/api/cabins repos routes · 舱籍第三轮", () => {
  let db: Database.Database
  let app: Hono
  let tmpDir: string
  let cabin: Record<string, any>

  beforeEach(async () => {
    db = new Database(":memory:")
    applySchema(db)
    const dao = new CabinDAO(db)
    const sse = new SSEService()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-repo-routes-"))
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    const svc = new CabinService(dao)
    const initService = new CabinInitService({
      cabin: dao, sse, runOrchestratorTurn: vi.fn(async () => {}),
    })
    svc.bindInfra({
      workspaceService: new WorkspaceService(new WorkspaceDAO(db)),
      workspaceDAO: new WorkspaceDAO(db),
      agentSessionDAO,
      taskDAO: new TaskDAO(db),
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
      initService,
    })
    app = new Hono()
    app.route("/api/cabins", createCabinRoutes(svc, initService, sse))

    const res = await app.request("/api/cabins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "账务舱", path: path.join(tmpDir, "cabin") }),
    })
    cabin = (await res.json()).cabin
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const post = (url: string, body?: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  function addLocalViaApi(name = "console") {
    makeRepo(path.join(cabin.path, "apps", name))
    return post(`/api/cabins/${cabin.id}/repos`, {
      source: "local", name, localPath: path.join("apps", name),
    })
  }

  it("GET /local-projects 扫绝对路径；相对路径 400", async () => {
    makeRepo(path.join(tmpDir, "scanme"))
    const ok = await app.request(`/api/cabins/local-projects?path=${encodeURIComponent(tmpDir)}`)
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.projects.map((p: { name: string }) => p.name)).toContain("scanme")

    expect((await app.request("/api/cabins/local-projects?path=relative/dir")).status).toBe(400)
    expect((await app.request("/api/cabins/local-projects")).status).toBe(400)
  })

  it("POST /repos 只登记；GET /repos 富化回落到主仓；?enrich=0 不打 git", async () => {
    const created = await addLocalViaApi()
    expect(created.status).toBe(201)
    const entry = (await created.json()).repo
    expect(entry.source).toBe("local")
    expect(entry.worktree_path).toBeUndefined()

    const enriched = await app.request(`/api/cabins/${cabin.id}/repos`)
    const [repo] = (await enriched.json()).repos
    expect(repo.key).toBe("local:apps/console")
    expect(repo.source).toBe("local")
    expect(repo.worktree_path).toBeNull()
    // 无 worktree 也要有分支信息（项目面看仓库）。
    expect(repo.git.branch).toBe("main")
    expect(repo.git.commit).toMatch(/^[0-9a-f]{8}$/)

    const lean = await app.request(`/api/cabins/${cabin.id}/repos?enrich=0`)
    expect((await lean.json()).repos[0].git).toBeUndefined()
  })

  it("POST /repos/:name/worktree 建在主实例；重复开同分支 409", async () => {
    await addLocalViaApi()
    const first = await post(`/api/cabins/${cabin.id}/repos/console/worktree`, {})
    expect(first.status).toBe(201)
    const entry = (await first.json()).repo
    expect(entry.worktree_path).toBe(path.join(cabin.path, "projects", "console"))
    expect(fs.existsSync(path.join(entry.worktree_path, "a.txt"))).toBe(true)

    const again = await post(`/api/cabins/${cabin.id}/repos/console/worktree`, {})
    expect(again.status).toBe(409)
    expect((await again.json()).error).toContain("worktree_exists")
  })

  it("DELETE /repos/:name 解绑不动磁盘", async () => {
    await addLocalViaApi()
    const wt = await post(`/api/cabins/${cabin.id}/repos/console/worktree`, {})
    const wtPath = (await wt.json()).repo.worktree_path
    const del = await app.request(`/api/cabins/${cabin.id}/repos/console`, { method: "DELETE" })
    expect(del.status).toBe(200)
    expect((await del.json()).removed).toBe(true)
    expect(fs.existsSync(path.join(cabin.path, "apps", "console"))).toBe(true)
    expect(fs.existsSync(wtPath)).toBe(true)
    const repos = await app.request(`/api/cabins/${cabin.id}/repos?enrich=0`)
    expect((await repos.json()).repos).toHaveLength(0)
  })

  it("POST /repos 舱外目录没带 external → 400", async () => {
    const outside = path.join(tmpDir, "outside")
    makeRepo(path.join(outside, "ext"))
    const res = await post(`/api/cabins/${cabin.id}/repos`, {
      source: "local", name: "ext", absolutePath: path.join(outside, "ext"),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("external")
  })
})