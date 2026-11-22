// POST /api/cabins 的 v4 契约（plan §4）：
//   · path 省略 → 服务端自动建 ~/.octopus/workspaces/cabin-…
//   · projects[] → config.json.repos[].group（跨 org 关联）
//   · 同目录第二次 create → created:false，同一个 id，不新增行
//   · 老调用（org+repos / 必填 path）行为不变

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { applySchema } from "../../../db/schema"
import {
  CabinDAO, WorkspaceDAO, AgentSessionDAO, TaskDAO, ExecutionDAO, AcceptanceDAO,
} from "../../../db/dao"
import { WorkspaceService } from "../../workspace"
import { initSessionService } from "../../agent/session-service"
import { SSEService } from "../../sse"
import { CabinService } from "../cabin-service"
import { CabinInitService } from "../cabin-init-service"
import { UNNAMED_CABIN_NAME } from "../cabin-naming"

describe("CabinService.createWithResult — v4 建舱契约", () => {
  let db: Database.Database
  let dao: CabinDAO
  let workspaceDAO: WorkspaceDAO
  let svc: CabinService
  let tmpDir: string
  let homeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    dao = new CabinDAO(db)
    workspaceDAO = new WorkspaceDAO(db)
    const agentSessionDAO = new AgentSessionDAO(db)
    initSessionService(agentSessionDAO)
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabin-create-v2-"))
    // 自动目录落在 ~/.octopus/workspaces → 把 home 指到临时目录，别写真实家目录。
    homeSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpDir)
    const sse = new SSEService()
    const initService = new CabinInitService({
      cabin: dao, sse, runOrchestratorTurn: vi.fn(async () => {}),
    })
    svc = new CabinService(dao)
    svc.bindInfra({
      workspaceService: new WorkspaceService(workspaceDAO),
      workspaceDAO,
      agentSessionDAO,
      taskDAO: new TaskDAO(db),
      executionDAO: new ExecutionDAO(db),
      acceptanceDAO: new AcceptanceDAO(db),
      initService,
    })
  })

  afterEach(() => {
    homeSpy.mockRestore()
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("path 省略 → 自动工作空间 cabin-<MMDD>-<HHmmss>-<rand6>，目录真的建出来", () => {
    const { cabin, created } = svc.createWithResult({ name: "电商舱", requirements: "做电商" })
    expect(created).toBe(true)
    expect(cabin.path).toMatch(/\/\.octopus\/workspaces\/cabin-\d{4}-\d{6}-[0-9a-f]{6}$/)
    expect(fs.existsSync(cabin.path)).toBe(true)
    // workspaceSlug 不再产出 cabin-cabin-…
    const ws = workspaceDAO.findById(cabin.workspace_id!)!
    expect(ws.name).not.toMatch(/^cabin-cabin-/)
    expect(ws.name).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it("v5：name 可省略 —— 先落「未命名舱」，等 init 按需求取名", () => {
    const { cabin, created } = svc.createWithResult({ requirements: "做一个电商后台，长期维护订单" })
    expect(created).toBe(true)
    expect(cabin.name).toBe(UNNAMED_CABIN_NAME)
  })

  it("projects[] 写进 config.json 的 group（跨 org 关联），舱级 org 取第一条", () => {
    const cabinPath = path.join(tmpDir, "ledger-dir")
    fs.mkdirSync(cabinPath, { recursive: true })
    const { cabin } = svc.createWithResult({
      name: "账本舱",
      path: cabinPath,
      projects: [
        { org: "XzhiF", repo: "ledger" },
        { org: "acme", repo: "billing" },
      ],
    })
    expect(cabin.org).toBe("XzhiF")
    const config = JSON.parse(fs.readFileSync(path.join(cabinPath, ".octopus", "workspace.json"), "utf-8"))
    // 2026-11-15 舱籍契约：source/org 显式落盘（本地/外部项目同表不同源）。
    expect(config.repos).toEqual([
      { name: "ledger", source: "org", org: "XzhiF", group: "XzhiF", repoName: "ledger" },
      { name: "billing", source: "org", org: "acme", group: "acme", repoName: "billing" },
    ])
  })

  it("projects 优先于老 org+repos", () => {
    const cabinPath = path.join(tmpDir, "mixed-dir")
    fs.mkdirSync(cabinPath, { recursive: true })
    svc.createWithResult({
      name: "混合舱",
      path: cabinPath,
      org: "legacy",
      repos: ["old-repo"],
      projects: [{ org: "XzhiF", repo: "ledger" }],
    })
    const config = JSON.parse(fs.readFileSync(path.join(cabinPath, ".octopus", "workspace.json"), "utf-8"))
    expect(config.repos.map((r: { name: string }) => r.name)).toEqual(["ledger"])
  })

  it("同一目录第二次 create → created:false，同一个 cabin，不新增行", () => {
    const cabinPath = path.join(tmpDir, "dup-dir")
    fs.mkdirSync(cabinPath, { recursive: true })
    const first = svc.createWithResult({ name: "第一舱", path: cabinPath })
    const second = svc.createWithResult({ name: "第二舱", path: cabinPath })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.cabin.id).toBe(first.cabin.id)
    expect(dao.list().filter((c) => c.path === cabinPath)).toHaveLength(1)
  })

  it("老调用 create() 仍只返回行，org+repos 语义不变", () => {
    const cabinPath = path.join(tmpDir, "legacy-dir")
    fs.mkdirSync(cabinPath, { recursive: true })
    const row = svc.create({ name: "老舱", path: cabinPath, org: "XzhiF", repos: ["a", "b"] })
    expect(row.name).toBe("老舱")
    const config = JSON.parse(fs.readFileSync(path.join(cabinPath, ".octopus", "workspace.json"), "utf-8"))
    expect(config.repos).toEqual([
      { group: "", name: "a", repoName: "a" },
      { group: "", name: "b", repoName: "b" },
    ])
  })
})