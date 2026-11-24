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

  it("PATCH /repos/:name 改落点分支（mainline_branch）：可改 / 非法或缺失 400 / null 清空", async () => {
    await addLocalViaApi()
    expect(git(path.join(cabin.path, "apps", "console"), ["branch", "feat/landing"]).status).toBe(0)

    const patch = (body: unknown) => app.request(`/api/cabins/${cabin.id}/repos/console`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    const ok = await patch({ mainline: "feat/landing" })
    expect(ok.status).toBe(200)
    expect((await ok.json()).repo.mainline_branch).toBe("feat/landing")

    // 本地与 origin 都没有 → 400；非法分支名 → 400；缺键 → 400（清空必须显式 null）。
    expect((await patch({ mainline: "feat/missing" })).status).toBe(400)
    expect((await patch({ mainline: "bad branch" })).status).toBe(400)
    expect((await patch({})).status).toBe(400)

    const cleared = await patch({ mainline: null })
    expect(cleared.status).toBe(200)
    expect((await cleared.json()).repo.mainline_branch).toBeUndefined()
  })

  it("POST /repos 可带 mainline 指定落点；不存在的分支 400", async () => {
    makeRepo(path.join(cabin.path, "apps", "console"))
    expect(git(path.join(cabin.path, "apps", "console"), ["branch", "feat/landing"]).status).toBe(0)
    const ok = await post(`/api/cabins/${cabin.id}/repos`, {
      source: "local", name: "console", localPath: path.join("apps", "console"),
      mainline: "feat/landing",
    })
    expect(ok.status).toBe(201)
    expect((await ok.json()).repo.mainline_branch).toBe("feat/landing")

    makeRepo(path.join(cabin.path, "apps", "risk"))
    const bad = await post(`/api/cabins/${cabin.id}/repos`, {
      source: "local", name: "risk", localPath: path.join("apps", "risk"),
      mainline: "feat/nope",
    })
    expect(bad.status).toBe(400)
  })

  // ── v20（design 29 §6 ws）：工作树只读查阅 tree / file ────────────────
  it("GET /repos/:name/tree 磁盘直扫（跳 node_modules/.git）；未绑定 404", async () => {
    await addLocalViaApi()
    const root = path.join(cabin.path, "apps", "console")
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "b.ts"), "export {}\n")
    fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true })
    fs.writeFileSync(path.join(root, "node_modules", "x", "hide.js"), "no\n")

    const res = await app.request(`/api/cabins/${cabin.id}/repos/console/tree`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const paths = body.entries.map((e: { path: string }) => e.path)
    expect(paths).toContain("a.txt")
    expect(paths).toContain("src/")
    expect(paths).toContain("src/b.ts")
    expect(paths.some((p: string) => p.startsWith("node_modules"))).toBe(false)
    expect(paths.some((p: string) => p.startsWith(".git"))).toBe(false)

    expect((await app.request(`/api/cabins/${cabin.id}/repos/nope/tree`)).status).toBe(404)
  })

  it("GET /repos/:name/file 只读常规文件；出根 403 / 目录 404 / 缺参 400 / 超大 413", async () => {
    await addLocalViaApi()
    const root = path.join(cabin.path, "apps", "console")
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    const ok = await app.request(`/api/cabins/${cabin.id}/repos/console/file?path=a.txt`)
    expect(ok.status).toBe(200)
    expect((await ok.json()).content).toBe("hello\n")

    expect((await app.request(`/api/cabins/${cabin.id}/repos/console/file?path=../escape`)).status).toBe(403)
    expect((await app.request(`/api/cabins/${cabin.id}/repos/console/file?path=src`)).status).toBe(404)
    expect((await app.request(`/api/cabins/${cabin.id}/repos/console/file`)).status).toBe(400)

    fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(512 * 1024 + 1))
    expect((await app.request(`/api/cabins/${cabin.id}/repos/console/file?path=big.bin`)).status).toBe(413)
  })

  // ── v22 九轮：本舱 cwd 只读目录树（右栏「目录」）────────────────────
  it("GET /tree 以舱目录为根（跳 node_modules）；GET /file 文本只读", async () => {
    const root = cabin.path
    fs.mkdirSync(path.join(root, "docs"), { recursive: true })
    fs.writeFileSync(path.join(root, "cabin.md"), "# 本舱\n")
    fs.writeFileSync(path.join(root, "docs", "接口约定.md"), "- 只读\n")
    fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true })
    fs.writeFileSync(path.join(root, "node_modules", "x", "hide.js"), "no\n")

    const tree = await app.request(`/api/cabins/${cabin.id}/tree`)
    expect(tree.status).toBe(200)
    const body = await tree.json()
    expect(body.dir).toBe(path.resolve(root))
    const paths = body.entries.map((e: { path: string }) => e.path)
    expect(paths).toContain("cabin.md")
    expect(paths).toContain("docs/")
    expect(paths).toContain("docs/接口约定.md")
    expect(paths.some((p: string) => p.startsWith("node_modules"))).toBe(false)

    const file = await app.request(`/api/cabins/${cabin.id}/file?path=cabin.md`)
    expect(file.status).toBe(200)
    expect((await file.json()).content).toBe("# 本舱\n")
  })

  it("GET /file 守卫：缺参 400 / 出根 403 / 目录 404 / 超大 413", async () => {
    fs.mkdirSync(cabin.path, { recursive: true })
    fs.writeFileSync(path.join(cabin.path, "big.md"), Buffer.alloc(512 * 1024 + 1))
    expect((await app.request(`/api/cabins/${cabin.id}/file`)).status).toBe(400)
    expect((await app.request(`/api/cabins/${cabin.id}/file?path=../escape`)).status).toBe(403)
    expect((await app.request(`/api/cabins/${cabin.id}/file?path=.`)).status).toBe(404)
    expect((await app.request(`/api/cabins/${cabin.id}/file?path=big.md`)).status).toBe(413)
  })

  it("GET /raw 只给图片（含 nosniff）；非图片 415 / 出根 403", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    fs.mkdirSync(path.join(cabin.path, "docs"), { recursive: true })
    fs.writeFileSync(path.join(cabin.path, "docs", "a.png"), png)
    fs.writeFileSync(path.join(cabin.path, "cabin.md"), "# 本舱\n")

    const res = await app.request(`/api/cabins/${cabin.id}/raw?path=docs/a.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(png.byteLength)

    expect((await app.request(`/api/cabins/${cabin.id}/raw?path=cabin.md`)).status).toBe(415)
    expect((await app.request(`/api/cabins/${cabin.id}/raw?path=../x.png`)).status).toBe(403)
  })
})