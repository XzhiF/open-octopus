// packages/server/src/__tests__/tasks-trigger-prebuild.test.ts
//
// 特性B（trigger-prebuild 2026-09-08）：「触发执行」当场同步预建 workspace+worktree。
//
// 票03 (ADR-0021) 之后这件事的**语义一字未改**，只是搬了地方：预建从
// `TasksService.triggerTaskWithPrebuild` 里的私有实现，变成 `triggerTask →
// TaskLifecycleService.armTask → prepareWorkspace` 的一环 —— 按钮按下就知道建不出来，
// 而不是等一分钟在 cron tick 里炸。所以这里仍钉：
//   1. v4 成功链：waitUntilIdle 先行 → createFromSpec → 绑定 tasks.workspace_id
//      + workspaces.task_id → 起 executions 行并 start（不再有「翻信封」这一步）。
//   2. 预建失败 → 409：任务留 ready、**零实例**、零 schedule 行。
//   3. 半途失败回滚：第二个项目不可解析 → ws 目录与 DB 行都不留（B0 顺序翻转）。
//   4. 已绑定复用：createFromSpec 0 调用；worktree 手删后下一次触发自愈重建、不换绑。
//   5. 形状闸门（原「v3/composite/仅 default → 预建整体跳过」）：预建已改为**无条件**，
//      留在形状上的差异是 composite 建 coordinator（projects 被剥空）、
//      project_ids 为空只产生 `default` 占位项（被过滤 → 零 worktree）。
//   6. B1 入队项目预检（在 trigger 之前就把解析不动的项目挡住）。
//
// Anti-fake-run: fake HOME + 真 git repo（init+commit）+ 真 WorkspaceService +
// better-sqlite3 applySchema；仅 repoSync 用记录 stub（其内部逻辑在
// repo-sync-service.test.ts 单独锁），以及 ExecutionService registry 用「写真实
// executions 行」的 stub（真引擎要 provider）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { execFileSync } from "child_process"
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, ExecutionDAO, WorkspaceDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService, TaskStatusConflictError } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { WorkspaceService } from "../services/workspace"
import { COMPOSITION_WF_REF } from "../services/scheduler/orchestration-strategy"
import type { RepoSyncService } from "../services/tasks/repo-sync-service"

const ORG = "prebuild-org"
const REPO = "demo-repo"

// ── ExecutionService registry stub: real INSERT so ux_exec_task_active is real ──
const stub = vi.hoisted(() => ({
  started: [] as string[],
  live: new Set<string>(),
  seq: 0,
  db: null as Database.Database | null,
  org: "prebuild-org",
}))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db!.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (_workspaceId: string, input: Record<string, unknown>) => {
          const id = `pb-exec-${stub.seq++}`
          stub.db!
            .prepare(
              `INSERT INTO executions
                 (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                  input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
               VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)`,
            )
            .run(
              id, _workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
              JSON.stringify(input.input_values ?? {}), JSON.stringify(input.initial_var_pool ?? {}),
              stub.org, input.task_id ?? null, input.phase_index ?? null, input.round_index ?? null,
            )
          return { id }
        },
        start: async (id: string) => {
          stub.started.push(id)
          stub.live.add(id)
          stub.db!.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(id)
        },
        registerExternalCallbacks: () => {},
        clearExternalCallbacks: (id: string) => {
          stub.live.delete(id)
        },
        cancel: (id: string) => {
          stub.live.delete(id)
          return { id }
        },
        hasLiveEngine: (id: string) => stub.live.has(id),
      },
    }
  },
}))

let realHome: string | undefined
let realUserProfile: string | undefined
let fakeHome: string
let repoDir: string
let db: Database.Database
let execs: ExecutionDAO
let wsService: WorkspaceService
let service: TasksService
let taskHome: TaskHomeService
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

/** A v4 spec with one phase whose batch spec.md is written under the task home —
 *  the launch-time re-check of the v4 contract (票03 §「re-checks the contract at
 *  launch」) needs the file on disk, and `built-in/demo` resolves via the stub. */
function v4Spec(withPhase = true): string {
  const spec: Record<string, unknown> = {
    format: "v4",
    task_type: "coding",
    goal: "g",
    ac: ["a"],
    phases: withPhase
      ? [
          {
            index: 1, name: "P1", slug: "p1",
            specPath: ".scratch/20260908/p1/spec.md",
            workflowRef: "built-in/demo",
            inputValues: {},
          },
        ]
      : [],
  }
  return JSON.stringify(spec)
}

function insertTask(
  id: string,
  projectIds: string[],
  overrides: Partial<{
    status: string
    task_spec: string
    workflow_ref: string | null
    /** Whether the phase's batch spec.md must exist on disk (the launch re-checks
     *  the v4 contract, so a v4 fixture with phases needs the file). Default: true
     *  for the bundled v4 spec, false for hand-written specs. */
    writePhaseSpec: boolean
  }> = {},
): void {
  const now = new Date().toISOString()
  const spec = overrides.task_spec ?? v4Spec()
  db.prepare(
    `INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, NULL, ?, '[]', '[]', '[]', ?, ?, 1, NULL, ?, ?, NULL)`,
  ).run(
    id, ORG, `E2E_TD prebuild ${id}`, overrides.status ?? "ready", spec, JSON.stringify(projectIds),
    overrides.workflow_ref === undefined ? null : overrides.workflow_ref,
    now, now,
  )
  if (overrides.writePhaseSpec ?? spec.includes('"p1"')) writePhaseSpec(id)
}

function writePhaseSpec(taskId: string): void {
  const dir = join(taskHome.homePath(taskId), ".scratch", "20260908", "p1")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "spec.md"), "# P1\n")
}

const stubRepoSync = (): RepoSyncService =>
  ({
    waitUntilIdle: async () => {
      order.push("wait")
    },
    syncProjectsForTask: () => {},
    hasSnapshot: () => true,
    freshnessNotes: () => undefined,
    isBusy: () => false,
  }) as unknown as RepoSyncService

beforeEach(() => {
  order = []
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  db.prepare("INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))").run()
  stub.db = db
  stub.started = []
  stub.live = new Set()
  stub.seq = 0
  execs = new ExecutionDAO(db)

  // Both, and restored by DELETE (not `= undefined`, which stringifies to
  // "undefined" and poisons os.homedir() for every later file in this worker).
  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  fakeHome = mkdtempSync(join(tmpdir(), "prebuild-home-"))
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
  repoDir = mkdtempSync(join(tmpdir(), "prebuild-repo-"))
  initSourceRepo(repoDir)
  writeIndex(repoDir)

  taskHome = new TaskHomeService(join(fakeHome, ".octopus"))
  const sse = new SSEService()
  wsService = new WorkspaceService(new WorkspaceDAO(db))
  const builtIn = {
    get: (ref: string) => ({ ref, content: "name: demo\nnodes: []\n", name: "demo" }),
  } as never
  service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, builtIn,
    stubRepoSync(), wsService,
  )
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
  db.close()
})

function taskRow(id: string): { status: string; workspace_id: string | null } {
  return db.prepare("SELECT status, workspace_id FROM tasks WHERE id = ?").get(id) as {
    status: string
    workspace_id: string | null
  }
}

function scheduleRowCount(): number {
  return (db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c
}

describe("触发预建 workspace+worktree（票03: 预建搬进 job 的 armTask）", () => {
  it("v4 成功链：wait 先行 → 预建 → 绑定 → 起执行行并 start，worktree 真实存在", async () => {
    insertTask("t-ok", [REPO])
    const spy = vi.spyOn(wsService, "createFromSpec")

    const dto = await service.triggerTask("t-ok")
    expect(dto.status).toBe("running")
    // A/B 汇合点：等待镜像同步发生在任何建动作之前
    expect(order[0]).toBe("wait")
    expect(spy).toHaveBeenCalledTimes(1)

    const row = taskRow("t-ok")
    expect(row.workspace_id).toBeTruthy()
    const ws = wsService.getById(row.workspace_id!)!
    expect(ws.name).toContain("E2E_TD prebuild") // taskWorkspaceName 展示名口径
    expect(ws.task_id).toBe("t-ok") // v41 反向指针，取代 source_schedule_id→origin_id 反查
    const wt = join(ws.path, "projects", REPO)
    expect(existsSync(join(wt, ".git"))).toBe(true)
    expect(existsSync(join(wt, "README.md"))).toBe(true)
    const branch = execFileSync("git", ["-C", wt, "branch", "--show-current"]).toString().trim()
    expect(branch.startsWith("taskpool-t-ok-")).toBe(true) // 实例键 = 任务 id（旧为信封 id）
    const config = JSON.parse(readFileSync(join(ws.path, "config.json"), "utf-8")) as {
      repos: Array<Record<string, unknown>>
    }
    expect(config.repos[0]).toMatchObject({ name: REPO, main_path: repoDir })

    // 一次运行 = 一行 executions；任何 schedule 表都没写。
    const root = execs.findLatestTaskRoot("t-ok")!
    expect(root.status).toBe("running")
    expect(root.parent_id).toBe("0")
    expect(root.workflow_ref).toBe("built-in/demo")
    expect([root.phase_index, root.round_index]).toEqual([1, 1])
    expect(stub.started).toEqual([root.id])
    expect(scheduleRowCount()).toBe(0)
    spy.mockRestore()
  })

  it("镜像路径删除 → 409：任务仍 ready、零实例、wake 语义不存在（没有信封可翻）", async () => {
    insertTask("t-409", [REPO])
    rmSync(repoDir, { recursive: true, force: true }) // 镜像消失 → resolveRepoPath throw

    await expect(service.triggerTask("t-409")).rejects.toThrow(TaskStatusConflictError)
    await expect(service.triggerTask("t-409")).rejects.toThrow(/预建工作区失败/)
    expect(taskRow("t-409").status).toBe("ready")
    expect(execs.findLatestTaskRoot("t-409")).toBeNull()
    expect(db.prepare("SELECT COUNT(*) c FROM workspaces").get()).toEqual({ c: 0 })
    expect(scheduleRowCount()).toBe(0)
  })

  it("第二项目不可解析 → 回滚：ws 目录与 DB 行都不留", async () => {
    insertTask("t-rb", [REPO, "ghost-repo"])
    const wsCountBefore = (db.prepare("SELECT COUNT(*) n FROM workspaces").get() as { n: number }).n

    await expect(service.triggerTask("t-rb")).rejects.toThrow(/预建工作区失败/)
    const wsCountAfter = (db.prepare("SELECT COUNT(*) n FROM workspaces").get() as { n: number }).n
    expect(wsCountAfter).toBe(wsCountBefore)
    // 目录零残留（回滚 rmSync）
    const wsRoot = join(fakeHome, ".octopus", "orgs", ORG, "workspaces")
    const lingering = existsSync(wsRoot) ? readdirSync(wsRoot) : []
    expect(lingering).toEqual([])
    expect(taskRow("t-rb").workspace_id).toBeNull()
  })

  it("已绑定复用：createFromSpec 0 调用；worktree 手删 → 下一轮自愈重建且不换绑", async () => {
    insertTask("t-re", [REPO])
    await service.triggerTask("t-re")
    const boundId = taskRow("t-re").workspace_id!
    const ws = wsService.getById(boundId)!
    rmSync(join(ws.path, "projects", REPO), { recursive: true, force: true }) // 带外删 worktree

    // 上一轮收尾 + 人重新入队（票03：释放槽位的唯一方式是行走终态）
    db.prepare("UPDATE executions SET status='completed' WHERE task_id='t-re'").run()
    db.prepare("UPDATE tasks SET status='ready' WHERE id='t-re'").run()

    const spy = vi.spyOn(wsService, "createFromSpec")
    await service.triggerTask("t-re")
    expect(spy).not.toHaveBeenCalled()
    expect(taskRow("t-re").workspace_id).toBe(boundId) // 不换绑
    expect(existsSync(join(ws.path, "projects", REPO, ".git"))).toBe(true) // 自愈重建
    expect(taskRow("t-re").status).toBe("running")
    // 复用路径零新建目录：只有一个 ws 行
    expect(db.prepare("SELECT COUNT(*) c FROM workspaces WHERE task_id='t-re'").get()).toEqual({ c: 1 })
    spy.mockRestore()
  })

  it("形状：预建无条件 —— v3 任务也当场建 ws；composite 建 coordinator（projects 剥空）", async () => {
    // v3（无 format）：旧版这里断言「预建跳过」，票03 之后预建没有闸门了。
    insertTask("t-v3", [REPO], {
      status: "ready",
      task_spec: JSON.stringify({ goal: "g", ac: ["a"], task_type: "generic" }),
      workflow_ref: "built-in/demo",
    })
    const spyV3 = vi.spyOn(wsService, "createFromSpec")
    await service.triggerTask("t-v3")
    expect(spyV3).toHaveBeenCalledTimes(1)
    expect(taskRow("t-v3").status).toBe("running")
    expect(execs.findLatestTaskRoot("t-v3")!.phase_index).toBeNull() // v3 不打 phase/round 标
    spyV3.mockRestore()

    // composite（subunits≥2）：协调工作区按设计不带项目（spec D4），扇出由 composition 自己建
    insertTask("t-co", [REPO], {
      task_spec: JSON.stringify({
        goal: "g",
        ac: ["a"],
        task_type: "coding",
        subunits: [
          {
            name: "sub-A",
            workspace_spec: { org: ORG, branch_prefix: "suba", projects: [{ name: REPO, source_path: "", group: "" }] },
            workflow_ref: "built-in/a",
            input_values: {},
            skills: [],
            resources: [],
          },
          {
            name: "sub-B",
            workspace_spec: { org: ORG, branch_prefix: "subb", projects: [{ name: REPO, source_path: "", group: "" }] },
            workflow_ref: "built-in/b",
            input_values: {},
            skills: [],
            resources: [],
          },
        ],
      }),
    })
    const spyCo = vi.spyOn(wsService, "createFromSpec")
    await service.triggerTask("t-co")
    expect(spyCo).toHaveBeenCalledTimes(1)
    expect((spyCo.mock.calls[0][0] as { projects: unknown[] }).projects).toEqual([])
    expect(
      (db.prepare("SELECT workflow_ref FROM executions WHERE task_id='t-co'").get() as { workflow_ref: string })
        .workflow_ref,
    ).toContain(COMPOSITION_WF_REF)
    spyCo.mockRestore()

    // project_ids 为空 → materialize 只给 `default` 占位项 → 被过滤 ⇒ 零 worktree
    insertTask("t-df", [])
    const spyDf = vi.spyOn(wsService, "createFromSpec")
    await service.triggerTask("t-df")
    expect((spyDf.mock.calls[0][0] as { projects: unknown[] }).projects).toEqual([])
    expect(taskRow("t-df").status).toBe("running")
    spyDf.mockRestore()
  })
})

describe("ready gate 项目预检（B1）", () => {
  it("v4 + 不可解析 project_ids → TaskReadyGateError missing 含 project:<name>", () => {
    insertTask("t-gate", ["ghost-repo"], { status: "draft" })
    expect(() => service.readyTask("t-gate")).toThrow(/project:ghost-repo/)
    // 预检发生在入队，不等触发：一行都不该被建出来
    expect(execs.findLatestTaskRoot("t-gate")).toBeNull()
  })

  it("v4 + 可解析项目 → missing 不含 project:（phase 缺陷照常报，不误伤仓库）", () => {
    insertTask("t-gate2", [REPO], { status: "draft", task_spec: v4Spec(false) })
    let missing: string[] = []
    try {
      service.readyTask("t-gate2")
    } catch (e: unknown) {
      missing = (e as { missing?: string[] }).missing ?? []
    }
    expect(missing.some((m) => m.startsWith("project:"))).toBe(false)
    expect(missing).toEqual(["phase:0:no-phases"])
  })
})
