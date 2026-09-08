// packages/server/src/__tests__/tasks-trigger-prebuild.test.ts
//
// 特性B：「触发执行」当场同步预建 workspace+worktree（trigger-prebuild 2026-09-08）。
//   1. v4 成功链：waitUntilIdle 先行 → createFromSpec → 绑定 tasks.workspace_id
//      → triggerTask 翻 queued/running；worktree 真实落盘、分支名 taskpool-<schedId>-*。
//   2. 预建失败 → 409：task 保持 ready、信封保持 draft、wake 不调用。
//   3. 半途失败回滚：第二项目不可解析 → ws 目录与 DB 行都不留（B0 顺序翻转）。
//   4. 已绑定复用：createFromSpec 0 调用；worktree 手删后 trigger 自愈重建。
//   5. 闸门：v3 / composite / 无真实项目 → 预建整体跳过，原 trigger 语义不变。
//
// Anti-fake-run: fake HOME + 真 git repo（init+commit）+ 真 WorkspaceService +
// better-sqlite3 applySchema；仅 repoSync 用记录 stub（其内部逻辑在
// repo-sync-service.test.ts 单独锁）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, ScheduleConfigDAO, WorkspaceDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskStatusConflictError } from "../services/tasks/tasks-service"
import { WorkspaceService } from "../services/workspace"
import { COMPOSITION_WF_REF } from "../services/scheduler/orchestration-strategy"
import type { RepoSyncService } from "../services/tasks/repo-sync-service"

const ORG = "prebuild-org"
const REPO = "demo-repo"

let realHome: string | undefined
let realProfile: string | undefined
let fakeHome: string
let repoDir: string
let db: Database.Database
let wsService: WorkspaceService
let service: TasksService
let order: string[]

function initSourceRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main", dir])
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir })
  writeFileSync(join(dir, "README.md"), "# demo")
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir })
}

function writeIndex(localPath: string): void {
  const reposDir = join(fakeHome, ".octopus", "orgs", ORG, "repos")
  mkdirSync(reposDir, { recursive: true })
  writeFileSync(
    reposDir + "/index.md",
    `# GitRepo Index\n\n## ${ORG} (${ORG})\n\n### ${REPO}\n- git: git@example.com:${REPO}.git\n- local: ${localPath} ✓ cloned\n`,
  )
}

function insertTask(id: string, projectIds: string[]): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO tasks (id, org, name, status, task_spec, authoring_resources, resources,
      skills, project_ids, version, created_at, updated_at)
     VALUES (?, ?, 'E2E_TD prebuild', 'ready', '{"format":"v4"}', '[]', '[]', '[]', ?, 1, ?, ?)`,
  ).run(id, ORG, JSON.stringify(projectIds), now, now)
}

function insertParkedEnvelope(scheduleId: string, taskId: string, config: unknown): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO schedules (id, org, name, job_type, config, status, origin_type, origin_id,
      origin_role, created_at, updated_at)
     VALUES (?, ?, ?, 'workflow', ?, 'draft', 'task', ?, 'primary', ?, ?)`,
  ).run(scheduleId, ORG, `E2E_TD env ${scheduleId}`, JSON.stringify(config), taskId, now, now)
}

function v4Config(projects: Array<{ name: string; source_path?: string }>): unknown {
  return {
    schema_version: "3.0",
    type: "workflow",
    format: "v4",
    workspace_spec: {
      org: ORG,
      branch_prefix: `taskpool-${ORG}`,
      projects: projects.map((p) => ({ name: p.name, source_path: p.source_path ?? "", group: "" })),
    },
    workflow_chain: [{ workflow_ref: "demo/wf", input_values: {} }],
  }
}

const stubRepoSync = (): RepoSyncService =>
  ({
    waitUntilIdle: async () => { order.push("wait") },
    syncProjectsForTask: () => {},
    hasSnapshot: () => true,
    freshnessNotes: () => undefined,
    isBusy: () => false,
  }) as unknown as RepoSyncService

beforeAll(() => {
  db = new Database(":memory:")
  applySchema(db)
})

beforeEach(() => {
  order = []
  realHome = process.env.HOME
  realProfile = process.env.USERPROFILE
  fakeHome = mkdtempSync(join(tmpdir(), "prebuild-home-"))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  repoDir = mkdtempSync(join(tmpdir(), "prebuild-repo-"))
  initSourceRepo(repoDir)
  writeIndex(repoDir)

  const sse = new SSEService()
  wsService = new WorkspaceService(new WorkspaceDAO(db))
  service = new TasksService(
    db, sse, new AgentSessionDAO(db), undefined, undefined, null,
    stubRepoSync(), wsService,
  )
})

afterEach(() => {
  process.env.HOME = realHome
  process.env.USERPROFILE = realProfile
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

afterAll(() => { db.close() })

function taskRow(id: string): { status: string; workspace_id: string | null } {
  return db.prepare("SELECT status, workspace_id FROM tasks WHERE id = ?").get(id) as {
    status: string; workspace_id: string | null
  }
}
function schedRow(id: string): { status: string } {
  return db.prepare("SELECT status FROM schedules WHERE id = ?").get(id) as { status: string }
}

describe("trigger 预建 workspace+worktree", () => {
  it("v4 成功链：wait 先行 → 预建 → 绑定 → 翻 queued/running，worktree 真实存在", async () => {
    insertTask("t-ok", [REPO])
    insertParkedEnvelope("s-ok", "t-ok", v4Config([{ name: REPO }]))
    const wake = vi.fn()
    service.setWakeScheduler(wake)

    const dto = await service.triggerTaskWithPrebuild("t-ok")
    expect(dto.status).toBe("running")

    // A/B 汇合点：等待镜像同步发生在任何建动作之前
    expect(order[0]).toBe("wait")

    const row = taskRow("t-ok")
    expect(row.workspace_id).toBeTruthy()
    const ws = wsService.getById(row.workspace_id!)!
    expect(ws.name).toContain("E2E_TD prebuild") // taskWorkspaceName 展示名口径
    const wt = join(ws.path, "projects", REPO)
    expect(existsSync(join(wt, ".git"))).toBe(true)
    expect(existsSync(join(wt, "README.md"))).toBe(true)
    const branch = execFileSync("git", ["-C", wt, "branch", "--show-current"]).toString().trim()
    expect(branch.startsWith("taskpool-s-ok-")).toBe(true) // requirement 派生 branchPrefix
    const config = JSON.parse(require("fs").readFileSync(join(ws.path, "config.json"), "utf-8"))
    expect(config.repos[0]).toMatchObject({ name: REPO, main_path: repoDir })

    expect(schedRow("s-ok").status).toBe("queued")
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it("镜像路径删除 → 409：task 仍 ready、信封仍 draft、wake 不调", async () => {
    insertTask("t-409", [REPO])
    insertParkedEnvelope("s-409", "t-409", v4Config([{ name: REPO }]))
    const wake = vi.fn()
    service.setWakeScheduler(wake)
    rmSync(repoDir, { recursive: true, force: true }) // 镜像消失 → resolveRepoPath throw

    await expect(service.triggerTaskWithPrebuild("t-409")).rejects.toThrow(TaskStatusConflictError)
    await expect(service.triggerTaskWithPrebuild("t-409")).rejects.toThrow(/预建工作区失败/)
    expect(taskRow("t-409").status).toBe("ready")
    expect(schedRow("s-409").status).toBe("draft")
    expect(wake).not.toHaveBeenCalled()
  })

  it("第二项目不可解析 → 回滚：ws 目录与 DB 行都不留", async () => {
    insertTask("t-rb", [REPO])
    insertParkedEnvelope("s-rb", "t-rb", v4Config([{ name: REPO }, { name: "ghost-repo" }]))
    const wsCountBefore = (db.prepare("SELECT COUNT(*) n FROM workspaces").get() as { n: number }).n

    await expect(service.triggerTaskWithPrebuild("t-rb")).rejects.toThrow(/预建工作区失败/)
    const wsCountAfter = (db.prepare("SELECT COUNT(*) n FROM workspaces").get() as { n: number }).n
    expect(wsCountAfter).toBe(wsCountBefore)
    // 目录零残留（回滚 rmSync）
    const wsRoot = join(fakeHome, ".octopus", "orgs", ORG, "workspaces")
    const lingering = existsSync(wsRoot) ? require("fs").readdirSync(wsRoot) : []
    expect(lingering).toEqual([])
    expect(taskRow("t-rb").workspace_id).toBeNull()
  })

  it("已绑定复用：createFromSpec 0 调用；worktree 手删 → trigger 自愈重建且换绑不发生", async () => {
    insertTask("t-re", [REPO])
    insertParkedEnvelope("s-re", "t-re", v4Config([{ name: REPO }]))
    await service.triggerTaskWithPrebuild("t-re")
    const boundId = taskRow("t-re").workspace_id!
    const ws = wsService.getById(boundId)!
    rmSync(join(ws.path, "projects", REPO), { recursive: true, force: true }) // 带外删 worktree

    const spy = vi.spyOn(wsService, "createFromSpec")
    // 模拟再次触发：task 回 ready、信封回 draft
    db.prepare("UPDATE tasks SET status='ready' WHERE id='t-re'").run()
    db.prepare("UPDATE schedules SET status='draft' WHERE id='s-re'").run()

    await service.triggerTaskWithPrebuild("t-re")
    expect(spy).not.toHaveBeenCalled()
    expect(taskRow("t-re").workspace_id).toBe(boundId) // 不换绑
    expect(existsSync(join(ws.path, "projects", REPO, ".git"))).toBe(true) // 自愈重建
    expect(taskRow("t-re").status).toBe("running")
    spy.mockRestore()
  })

  it("闸门：v3 信封 / composite 信封 / 无真实项目 → 预建跳过、原翻转照常", async () => {
    const spy = vi.spyOn(wsService, "createFromSpec")

    // v3（config 无 format）
    insertTask("t-v3", [REPO])
    db.prepare("UPDATE tasks SET task_spec='{\"task_type\":\"generic\"}' WHERE id='t-v3'").run()
    insertParkedEnvelope("s-v3", "t-v3", {
      schema_version: "3.0", type: "workflow",
      workspace_spec: { org: ORG, branch_prefix: "taskpool-x", projects: [{ name: REPO, source_path: "", group: "" }] },
      workflow_chain: [{ workflow_ref: "wf", input_values: {} }],
    })
    await service.triggerTaskWithPrebuild("t-v3")
    expect(spy).not.toHaveBeenCalled()
    expect(taskRow("t-v3").status).toBe("running")

    // composite（chain[0] 指向 composition wf）
    insertTask("t-co", [REPO])
    insertParkedEnvelope("s-co", "t-co", {
      ...(v4Config([{ name: REPO }]) as object),
      workflow_chain: [{ workflow_ref: COMPOSITION_WF_REF, input_values: {} }],
    })
    await service.triggerTaskWithPrebuild("t-co")
    expect(spy).not.toHaveBeenCalled()

    // v4 但仅 default 占位项目
    insertTask("t-df", [REPO])
    insertParkedEnvelope("s-df", "t-df", v4Config([{ name: "default" }]))
    await service.triggerTaskWithPrebuild("t-df")
    expect(spy).not.toHaveBeenCalled()
    expect(taskRow("t-df").status).toBe("running")

    spy.mockRestore()
  })
})

describe("ready gate 项目预检（B1）", () => {
  it("v4 + 不可解析 project_ids → TaskReadyGateError missing 含 project:<name>", () => {
    insertTask("t-gate", ["ghost-repo"])
    db.prepare("UPDATE tasks SET status='draft' WHERE id='t-gate'").run()
    expect(() => service.readyTask("t-gate")).toThrow(/project:ghost-repo/)
  })

  it("v4 + 可解析项目（无 phase 缺陷可过）→ missing 不含 project:", () => {
    insertTask("t-gate2", [REPO])
    db.prepare("UPDATE tasks SET status='draft' WHERE id='t-gate2'").run()
    try {
      service.readyTask("t-gate2")
    } catch (e: unknown) {
      // phase 缺陷照常报，但仓库预检不误伤
      const missing = (e as { missing?: string[] }).missing ?? []
      expect(missing.some((m) => m.startsWith("project:"))).toBe(false)
    }
  })
})
