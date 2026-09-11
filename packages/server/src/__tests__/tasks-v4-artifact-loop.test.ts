// packages/server/src/__tests__/tasks-v4-artifact-loop.test.ts
//
// task-phase-redesign ticket 06 — 产物单向环: seed 下行 / collect 上行 / SSE。
//
// 票03 (ADR-0021) moved both halves of the loop onto the built-in task-lifecycle
// job: `armTask` seeds this round's batch dir into the workspace, and the terminal
// finalize collects the execution side's changes back to the home. They used to sit
// inside `WorkflowExecutor` (which is how a scheduler file ended up knowing about
// task homes), so the harness drives the REAL new path — no envelope, no
// `executor.execute()`.
//
// Verifies (real better-sqlite3 + applySchema + REAL WorkspaceService + REAL
// TaskHomeService layout under a fake HOME tmp dir + an ExecutionService stub that
// writes real executions rows and captures the terminal callback, same harness
// family as tasks-v4-ws-reuse.test.ts):
//   AC1: 首轮 arm → ws 内存在 seed 文件且内容=home 版；home 在两轮之间被改 → 下一轮
//        seed 反映新内容（home 覆盖 ws 同名）。
//   AC1b: v3 任务（无 format/phases）不 seed（底线）。
//   AC2: 执行侧改 issues Status（终态回调后）home 同名文件更新 + 新报告回流，
//        且 SSE task_artifacts_update 在 taskpool 事件流可收到。
//   AC3: 写权纪律（ADR-0018 反转）— 批次目录 ws 权威：执行侧在 ws 更新 spec.md，
//        collect 回流覆盖 home（home=终态镜像）。
//   AC4: ws 目录被 rm -rf 后 home 产物完整（防丢兜底）；collect 遇 ws 不可用是 no-op。
//
// E2E_AL_ data prefix; all fs assertions under mkdtemp tmp dirs (cleaned; HOME and
// USERPROFILE restored with `delete` so no later file in this worker inherits them).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import { applySchema } from "../db/schema"
import { ExecutionDAO, WorkspaceDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { WorkspaceService } from "../services/workspace"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { TASK_ARTIFACTS_UPDATE_EVENT } from "@octopus/shared"

const ORG = "e2e-al"
const DATE = "20260903"

// ── ExecutionService registry stub (ws-reuse 同款) ────────────────────
// A real 'pending' root row (so task_id / (phase,round) / the latch are the real
// ones) + the terminal callback captured per execution, which is how a round ends.
const stub = vi.hoisted(() => ({
  callbacks: new Map<string, (status?: string) => void>(),
  live: new Set<string>(),
  seq: 0,
  db: null as Database.Database | null,
  org: "e2e-al",
}))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const db = stub.db!
    const ws = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined // ws 被带外删除 → 注册表查不到（AC4 的那一半）
    return {
      wsPath: ws.path,
      service: {
        create: (_wsId: string, input: Record<string, unknown>) => {
          const id = `e2e-al-exec-${stub.seq++}`
          db.prepare(
            `INSERT INTO executions (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name,
               status, input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
             VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, '{}', ?, datetime('now'), datetime('now'), ?, ?, ?)`,
          ).run(
            id, _wsId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
            JSON.stringify(input.input_values ?? {}), stub.org,
            input.task_id ?? null, input.phase_index ?? null, input.round_index ?? null,
          )
          return { id }
        },
        start: async (id: string) => {
          stub.live.add(id)
          db.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(id)
        },
        registerExternalCallbacks: (cbs: { onComplete?: (s?: string) => void }, id: string) => {
          if (cbs.onComplete) stub.callbacks.set(id, cbs.onComplete as (s?: string) => void)
        },
        clearExternalCallbacks: (id: string) => {
          stub.callbacks.delete(id)
          stub.live.delete(id)
        },
        cancel: (id: string) => ({ id }),
        hasLiveEngine: (id: string) => stub.live.has(id),
      },
    }
  },
}))

// ── Fixture helpers ───────────────────────────────────────────────────

let db: Database.Database
let sse: SSEService
let workspaceService: WorkspaceService
let service: TasksService
let taskHome: TaskHomeService
let fakeHome: string
let realHome: string | undefined
let realUserProfile: string | undefined
let artifactsEvents: Array<Record<string, unknown>>
let seq = 0

function writeBatchDir(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
}

/** home 批次目录: {home}/.scratch/<date>/<slug>/ */
function seedHomeBatch(taskId: string, slug: string, files: Record<string, string>): string {
  const dir = path.join(taskHome.homePath(taskId), ".scratch", DATE, slug)
  writeBatchDir(dir, files)
  return dir
}

/** A v4 task whose phases[] point at those batch dirs (relative = home register). */
function insertV4Task(taskId: string, slugs: string[]): string {
  const now = new Date().toISOString()
  const phases = slugs.map((slug, i) => ({
    index: i + 1,
    name: `Phase ${i + 1}`,
    slug,
    specPath: path.join(".scratch", DATE, slug, "spec.md"),
    workflowRef: `built-in/flow-${slug}`,
    inputValues: {},
  }))
  db.prepare(
    `INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at, workspace_id)
     VALUES (?, ?, ?, 'ready', NULL, ?, '[]', '[]', '[]', '[]', NULL, 1, NULL, ?, ?, NULL, NULL)`,
  ).run(taskId, ORG, `E2E_AL ${taskId}`, JSON.stringify({ format: "v4", task_type: "coding", phases }), now, now)
  return taskId
}

function boundWs(taskId: string): { wsId: string; wsPath: string } {
  const { workspace_id: wsId } = db.prepare("SELECT workspace_id FROM tasks WHERE id = ?").get(taskId) as
    { workspace_id: string }
  const { path: wsPath } = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
    { path: string }
  return { wsId, wsPath }
}

/** 一轮收尾的现实形状：行进终态（终态回调已经跑过或手动落），人重新入队。 */
function endRoundAndRequeue(taskId: string): void {
  db.prepare("UPDATE executions SET status='completed', completed_at=datetime('now') WHERE task_id=?")
    .run(taskId)
  db.prepare("UPDATE tasks SET status='ready' WHERE id=?").run(taskId)
}

/** Fire the terminal callback the way the engine does, and await the async tail. */
async function complete(execId: string, status = "completed"): Promise<void> {
  stub.callbacks.get(execId)?.(status)
  await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  applySchema(db)
  db.prepare(
    "INSERT OR IGNORE INTO scheduler_state (id, last_heartbeat) VALUES (1, datetime('now'))",
  ).run()
  stub.db = db
  stub.callbacks = new Map()
  stub.live = new Set()
  stub.seq = 0
  seq = 0
  vi.clearAllMocks()

  realHome = process.env.HOME
  realUserProfile = process.env.USERPROFILE
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-al-home-"))
  // Fake BOTH: os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows —
  // without the latter the REAL user home was used on Windows (root cause of the
  // baseline-red: colon-mkdir ENOENT + cross-test same-second name collisions).
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome

  artifactsEvents = []
  sse = new SSEService()
  sse.subscribe("taskpool", (e) => {
    if (e.event === TASK_ARTIFACTS_UPDATE_EVENT) artifactsEvents.push(e.data as Record<string, unknown>)
  })
  taskHome = new TaskHomeService(path.join(fakeHome, ".octopus"))
  workspaceService = new WorkspaceService(new WorkspaceDAO(db))
  // arm 会重查 v4 契约 ⇒ phase 的 workflowRef 必须可解析（stub built-in，无必填输入）。
  const builtIn = {
    get: (ref: string) => ({ ref, content: "name: demo\nnodes: []\n", name: "demo" }),
  } as never
  service = new TasksService(
    db, sse, undefined, taskHome, undefined, builtIn, null, workspaceService,
  )
})

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  fs.rmSync(fakeHome, { recursive: true, force: true })
  db.close()
})

describe("ticket 06 — 产物单向环 seed/collect/SSE（票03: 两半都在 job 里）", () => {
  // ── AC1 (part 1) — 首轮 arm: seed home→ws ───────────────────────────
  it("AC1: 首轮 arm 把 {home}/.scratch/<date>/<slug>/ 逐文件复制进 ws", async () => {
    const taskId = insertV4Task("e2e-al-task-1", ["p1"])
    seedHomeBatch(taskId, "p1", {
      "spec.md": "# spec p1 v1\n",
      "issues/01-x.md": "Status: ready-for-agent\n",
    })

    await service.triggerTask(taskId)

    const { wsPath } = boundWs(taskId)
    const wsBatch = path.join(wsPath, ".scratch", DATE, "p1")
    expect(fs.readFileSync(path.join(wsBatch, "spec.md"), "utf-8")).toBe("# spec p1 v1\n")
    expect(fs.readFileSync(path.join(wsBatch, "issues/01-x.md"), "utf-8")).toBe("Status: ready-for-agent\n")
    // seed 只下行、不动 home。
    expect(fs.readFileSync(
      path.join(taskHome.homePath(taskId), ".scratch", DATE, "p1", "spec.md"), "utf-8",
    )).toBe("# spec p1 v1\n")
  })

  it("AC1b: v3 任务（无 format/phases）一行都不 seed（字节不变底线）", async () => {
    const taskId = insertV4Task("e2e-al-task-v3", ["p1"])
    seedHomeBatch(taskId, "p1", { "spec.md": "# spec p1\n" })
    // v3 shape: no format, no phases — same spec shape the v3 flow materializes.
    db.prepare("UPDATE tasks SET task_spec = ?, workflow_ref = 'built-in/flow-p1' WHERE id = ?")
      .run(JSON.stringify({ goal: "g", ac: ["a"], task_type: "generic" }), taskId)

    await service.triggerTask(taskId)

    const { wsPath } = boundWs(taskId)
    expect(fs.existsSync(path.join(wsPath, ".scratch"))).toBe(false)
    // 未打标 ⇒ collect 上行同样不触发（终态回调后 home 一字未改）。
    const execId = new ExecutionDAO(db).findLatestTaskRoot(taskId)!.id
    const homeSpec = path.join(taskHome.homePath(taskId), ".scratch", DATE, "p1", "spec.md")
    await complete(execId)
    expect(fs.readFileSync(homeSpec, "utf-8")).toBe("# spec p1\n")
  })

  // ── AC2 (首触终态回调) — collect 上行 + SSE ────────────────────────────
  it("AC2: 首轮终态回调把执行侧改动收回 home + 发 task_artifacts_update", async () => {
    const taskId = insertV4Task("e2e-al-task-2", ["p1"])
    const p1 = seedHomeBatch(taskId, "p1", {
      "spec.md": "# spec p1\n",
      "issues/01-x.md": "Status: ready-for-agent\n",
    })
    await service.triggerTask(taskId)
    const execId = new ExecutionDAO(db).findLatestTaskRoot(taskId)!.id
    const { wsPath } = boundWs(taskId)

    // Simulated execution side: edit the issues status, add a report, and
    // REVIEW/UPDATE spec.md in the ws (AC3 — ws is the final spec authority,
    // ADR-0018). Bump mtimes explicitly (+5s) so the ws>home rule is
    // deterministic regardless of clock granularity.
    const wsBatch = path.join(wsPath, ".scratch", DATE, "p1")
    const edited = path.join(wsBatch, "issues/01-x.md")
    fs.writeFileSync(edited, "Status: done\n")
    const st = fs.statSync(edited)
    fs.utimesSync(edited, st.atime, new Date(st.mtimeMs + 5000))
    const report = path.join(wsBatch, "report-r1.md")
    fs.writeFileSync(report, "# round 1 report\n")
    fs.writeFileSync(path.join(wsBatch, "spec.md"), "REVISED BY EXECUTION\n")

    // Engine terminal → the onComplete registered by the job finalizes (collect).
    await complete(execId)

    expect(fs.readFileSync(path.join(p1, "issues/01-x.md"), "utf-8")).toBe("Status: done\n")
    expect(fs.readFileSync(path.join(p1, "report-r1.md"), "utf-8")).toBe("# round 1 report\n")
    // AC3 (ADR-0018): spec*.md is ws 权威 — the execution-side revision flows
    // back and home's copy becomes the final state.
    expect(fs.readFileSync(path.join(p1, "spec.md"), "utf-8")).toBe("REVISED BY EXECUTION\n")
    // SSE 上行可收 (taskpool 订阅).
    expect(artifactsEvents.some((d) => d.task_id === taskId)).toBe(true)
  })

  // ── AC1c + AC2/AC3 (后续轮) — dispatch seed / finalize collect / 再 seed
  it("后续轮：dispatch 种子到目标批次；执行侧改动在 finalize 收回；两轮之间改 home 下一次 seed 覆盖", async () => {
    const taskId = insertV4Task("e2e-al-task-3", ["p1", "p2"])
    seedHomeBatch(taskId, "p1", { "spec.md": "# spec p1\n" })
    const p2 = seedHomeBatch(taskId, "p2", {
      "spec.md": "# spec p2 v1\n",
      "issues/02-y.md": "Status: needs-info\n",
    })
    await service.triggerTask(taskId) // phase 1
    await complete(new ExecutionDAO(db).findLatestTaskRoot(taskId)!.id) // 收轮
    endRoundAndRequeue(taskId)

    // ── round 1 of phase 2: seed puts the p2 batch into the ws (home 版内容) ──
    const dispatched = await service.dispatchPhaseRound(taskId, 2, 1, "go")
    const { wsPath } = boundWs(taskId)
    const wsBatch = path.join(wsPath, ".scratch", DATE, "p2")
    expect(dispatched.workspaceId).toBe(boundWs(taskId).wsId) // 一 task 一 ws，轮次不换支
    expect(fs.readFileSync(path.join(wsBatch, "spec.md"), "utf-8")).toBe("# spec p2 v1\n")
    expect(fs.readFileSync(path.join(wsBatch, "issues/02-y.md"), "utf-8")).toBe("Status: needs-info\n")
    // 打回反馈走的是 input_values 通道，不落批次目录（产物化是 acceptance 的职责）。
    const iv = JSON.parse(new ExecutionDAO(db).findById(dispatched.executionId)!.input_values) as
      Record<string, string>
    expect(iv.feedback).toBe("go")

    // Execution side: update issues + revise spec.md in the ws copy.
    const edited = path.join(wsBatch, "issues/02-y.md")
    fs.writeFileSync(edited, "Status: done\n")
    const st = fs.statSync(edited)
    fs.utimesSync(edited, st.atime, new Date(st.mtimeMs + 5000))
    fs.writeFileSync(path.join(wsBatch, "spec.md"), "REVISED IN WS\n")

    // Terminal → the job's finalize collects.
    await complete(dispatched.executionId)
    expect(fs.readFileSync(path.join(p2, "issues/02-y.md"), "utf-8")).toBe("Status: done\n")
    expect(fs.readFileSync(path.join(p2, "spec.md"), "utf-8")).toBe("REVISED IN WS\n") // AC3
    expect(artifactsEvents.some((d) => d.task_id === taskId)).toBe(true) // AC2

    // ── round 2: home spec edited between rounds → next seed 覆盖 ws 同名 ──
    fs.writeFileSync(path.join(p2, "spec.md"), "# spec p2 v2\n")
    endRoundAndRequeue(taskId)
    const r2 = await service.dispatchPhaseRound(taskId, 2, 2)
    expect(r2.workspaceId).toBe(boundWs(taskId).wsId)
    expect(fs.readFileSync(path.join(wsBatch, "spec.md"), "utf-8")).toBe("# spec p2 v2\n")

    // AC4: ws 被带外删除 — home 产物完整（防丢兜底），且 collect 退化为 no-op。
    const r2exec = new ExecutionDAO(db).findById(r2.executionId)!
    expect(r2exec.status).toBe("running")
    fs.rmSync(wsPath, { recursive: true, force: true })
    await complete(r2.executionId)
    expect(fs.readFileSync(path.join(p2, "spec.md"), "utf-8")).toBe("# spec p2 v2\n")
    expect(fs.readFileSync(path.join(p2, "issues/02-y.md"), "utf-8")).toBe("Status: done\n")
  })
})
