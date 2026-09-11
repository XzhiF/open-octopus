// packages/server/src/__tests__/tasks-v4-gate.test.ts
//
// task-phase-redesign ticket 04 — v4 ready-gate + per-phase materialization +
// placeholder vocabulary (K13 format fork).
//
// Verifies (against real better-sqlite3 + applySchema + real tmp task homes,
// R1/R3/R5):
//   AC1: v4 gate produces EXACT missing keys per category:
//        no-phases → "phase:0:no-phases"; specPath file missing →
//        "phase:<i>:spec-missing"; workflow_ref unresolvable →
//        "phase:<i>:workflow-ref"; required input empty/unresolved →
//        "phase:<i>:input:<name>" (all 409, never 500).
//   AC2: the v3 branch (no format flag) is untouched — the separate
//        tasks-v3-gates.test.ts passes unmodified (run alongside); plus a
//        local sanity that v3 keys never leak the phase: prefix.
//   AC3: unknown placeholder ${nope} in a phase inputValues → missing entry,
//        NOT a 500 (v3 discipline inherited).
//   AC4: a passing v4 ready creates NO envelope (票03) and the per-phase resolution
//        (absolute specPath, placeholder-resolved input_values, managed
//        task_artifacts_dir key, chain = phase 1) lands on the LAUNCH — i.e. the
//        executions row the built-in job arms for that round.
//   Vocab: ${phase.slug} / ${phase.spec_dir} / ${task.home} /
//          ${task_artifacts_dir} resolve via resolveInputValues ctx overload;
//          ${goal}/${ac} preserved; no-ctx dotted names → unresolved (no throw).
//
// Anti-fake-run: real DB + applySchema (R1/R3/R5), Hono app.request (R3),
// E2E_TD_ data prefix (R7), assert response body + SQL + fs (R4).
//
// 票03 换了 AC4 的**读点**：readyTask 不再物化信封（config 冻结在 schedules 行里），
// 启动计划由内置 job 每次 arm 时从 task_spec + home 重新算。所以「per-phase 解析结果
// 是否落进这一轮」现在只能也必须在 `executions.input_values` 上验 —— 那才是执行真正
// 吃到的东西。本文件因此带一个 ExecutionService stub：它写**真实 executions 行**，
// 于是 ux_exec_task_active / task_id 直连这些约束也是真的。

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO, ExecutionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { resolveInputValues } from "../services/scheduler/template-resolver"
import path from "path"
import os from "os"
import fs from "fs"

const ORG = "e2e-td-v4gate"

const stub = vi.hoisted(() => ({
  db: null as Database.Database | null,
  wsDir: "",
  wsSeq: 0,
  seq: 0,
  started: [] as string[],
}))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db!.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (_wsId: string, input: Record<string, unknown>) => {
          const id = `td-gate-exec-${stub.seq++}`
          stub.db!
            .prepare(
              `INSERT INTO executions
                 (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                  input_values, var_pool, org, created_at, updated_at, task_id, phase_index, round_index)
               VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, '{}', ?, datetime('now'), datetime('now'), ?, ?, ?)`,
            )
            .run(
              id, _wsId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
              JSON.stringify(input.input_values ?? {}), ORG,
              input.task_id ?? null, input.phase_index ?? null, input.round_index ?? null,
            )
          return { id }
        },
        start: async (id: string) => {
          stub.started.push(id)
          stub.db!.prepare("UPDATE executions SET status='running' WHERE id=?").run(id)
        },
        registerExternalCallbacks: () => {},
        clearExternalCallbacks: () => {},
        cancel: (id: string) => ({ id }),
        hasLiveEngine: () => false,
      },
    }
  },
}))

// Workflow YAMLs served by the stub builtin — same shapes as
// tasks-v3-ready-inputs.test.ts (required inputs drive the input:<name> checks).
const WORKFLOW_REQUIRED_INPUTS = `
apiVersion: octopus/v1
kind: Workflow
name: v4-required-flow
inputs:
  idea:
    description: "The idea"
    required: true
  spec_dir:
    description: "Phase spec dir"
    required: true
`

const WORKFLOW_NO_REQUIRED_INPUTS = `
apiVersion: octopus/v1
kind: Workflow
name: v4-no-required-flow
inputs:
  feature:
    description: "Optional"
    required: false
    default: ""
`

let db: Database.Database
let app: Hono
let tmpDir: string
let wsTmpDir: string
let taskHome: TaskHomeService
let service: TasksService
let execs: ExecutionDAO
let nextTaskSeq = 0

/** Minimal WorkspaceService stand-in: a row + a real directory (seed 下行 writes into
 *  it), because arming a task is what builds the workspace now (K4 一 task 一 ws). */
function fakeWorkspaceService() {
  return {
    getById: (id: string) =>
      (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as never) ?? undefined,
    ensureWorktreesForReuse: () => ({ rebuilt: [] }),
    createFromSpec: (input: Record<string, unknown>) => {
      const id = `td-gate-ws-${stub.wsSeq++}`
      const p = path.join(wsTmpDir, id)
      fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
      db.prepare(
        `INSERT INTO workspaces (id, name, org, status, path, source, task_id, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
      ).run(id, String(input.name), ORG, p, (input.task_id as string) ?? null)
      return { id, name: input.name, org: ORG, status: "active", path: p }
    },
  }
}

/** ready → arm through the real job → read the row the run actually eats. */
function launchRow(taskId: string): { input: Record<string, string>; ref: string; phase: number | null; round: number | null } {
  const execId = service.taskLifecycle.armTask(taskId)
  const row = execs.findById(execId)!
  return {
    input: JSON.parse(row.input_values) as Record<string, string>,
    ref: row.workflow_ref,
    phase: row.phase_index,
    round: row.round_index,
  }
}

function newDb(): Database.Database {
  const db = new Database(":memory:")
  applySchema(db)
  return db
}

/** Insert a draft task row directly (bypass the service) — full spec control. */
function insertTask(spec: Record<string, unknown>, workflowRef: string | null = null): string {
  const id = `e2e-td-v4gate-${nextTaskSeq++}`
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO tasks (id, org, name, status, source_chat_session_id, task_spec,
      authoring_resources, resources, skills, project_ids, workflow_ref, version,
      deleted_at, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, 'draft', NULL, ?, '[]', '[]', '[]', '[]', ?, 1, NULL, ?, ?, NULL)
  `).run(id, ORG, `E2E_TD v4 task ${id}`, JSON.stringify(spec), workflowRef, now, now)
  return id
}

interface PhaseInput {
  index: number
  name: string
  slug: string
  specPath: string
  workflowRef: string
  inputValues: Record<string, string>
}

/** Write a spec file into the task's home at `rel` (creates parent dirs). */
function writeSpecFile(taskId: string, rel: string): void {
  const abs = path.join(taskHome.homePath(taskId), rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `# E2E_TD spec ${rel}\n`)
}

/** Assemble a v4 task whose phases are given as authored objects. */
function insertV4Task(id: string, phases: PhaseInput[]): void {
  db.prepare("UPDATE tasks SET task_spec = ? WHERE id = ?").run(
    JSON.stringify({
      format: "v4",
      task_type: "coding",
      skill_groups: [],
      decisions: [],
      resources: [],
      authoring_resources: [],
      phases,
    }),
    id,
  )
}

/** A fully-valid phase for task `id`: spec file written under the home,
 *  resolvable workflow, required inputs satisfied via the v4 vocabulary. */
function validPhase(id: string, n: number): PhaseInput {
  const slug = `p${n}`
  const specPath = path.join(".scratch", "v4d", slug, "spec.md")
  writeSpecFile(id, specPath)
  return {
    index: n,
    name: `Phase ${n}`,
    slug,
    specPath,
    workflowRef: "built-in/v4-required-flow",
    inputValues: { idea: "${phase.slug} idea", spec_dir: "${phase.spec_dir}" },
  }
}

beforeAll(() => {
  db = newDb()
  stub.db = db
  execs = new ExecutionDAO(db)
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-v4-gate-${Date.now()}`)
  wsTmpDir = path.join(os.tmpdir(), `test-v4-gate-ws-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(wsTmpDir, { recursive: true })
  taskHome = new TaskHomeService(tmpDir)
  const stubBuiltIn = {
    get(ref: string) {
      if (ref.includes("v4-required-flow")) return { ref, content: WORKFLOW_REQUIRED_INPUTS }
      if (ref.includes("v4-no-required")) return { ref, content: WORKFLOW_NO_REQUIRED_INPUTS }
      return null
    },
  } as never
  service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, stubBuiltIn, null,
    fakeWorkspaceService() as never,
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterAll(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(wsTmpDir, { recursive: true, force: true })
})

describe("ticket 04 AC1: v4 gate — four missing categories, exact keys (409)", () => {
  it("AC1a: v4 task with empty phases → 409 missing=['phase:0:no-phases']", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; missing: string[] }
    expect(body.missing).toEqual(["phase:0:no-phases"])
  })

  it("AC1a2: v4 task missing the phases key entirely → same no-phases key", async () => {
    const id = insertTask({ format: "v4", task_type: "coding" })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(["phase:0:no-phases"])
  })

  it("AC1b: phase specPath file absent under home → 'phase:1:spec-missing' only", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    insertV4Task(id, [
      {
        index: 1, name: "P1", slug: "p1",
        specPath: path.join(".scratch", "gone", "p1", "spec.md"),
        workflowRef: "built-in/v4-required-flow",
        inputValues: { idea: "x", spec_dir: "y" },
      },
    ])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(["phase:1:spec-missing"])
  })

  it("AC1c: unresolvable workflow_ref (spec exists) → 'phase:1:workflow-ref' only", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    insertV4Task(id, [{ ...validPhase(id, 1), workflowRef: "unknown/flow" }])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(["phase:1:workflow-ref"])
  })

  it("AC1d: required inputs unsatisfied → 'phase:1:input:idea'+'phase:1:input:spec_dir'", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    insertV4Task(id, [{ ...validPhase(id, 1), inputValues: {} }])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(["phase:1:input:idea", "phase:1:input:spec_dir"])
  })

  it("AC1e: per-phase indexing — phase 2 broken, phase 1 clean → only 'phase:2:*'", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    const p2 = validPhase(id, 2)
    insertV4Task(id, [
      validPhase(id, 1),
      {
        ...p2,
        specPath: path.join(".scratch", "v4d", "p2", "GONE.md"),
        workflowRef: "unknown/x",
        inputValues: {},
      },
    ])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    // spec missing → skip its input checks (no input: noise for a doomed phase);
    // workflow-ref still reported (independent category).
    expect(body.missing).toEqual(["phase:2:spec-missing", "phase:2:workflow-ref"])
  })

  it("AC1f: all phases clean + workflow without required inputs → 200 ready", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    insertV4Task(id, [{ ...validPhase(id, 1), workflowRef: "built-in/v4-no-required-flow" }])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    const task = (await res.json()) as { status: string }
    expect(task.status).toBe("ready")
  })
})

describe("ticket 04 AC2: v3 branch untouched (fork keyed on format only)", () => {
  it("AC2a: task_type set, NO format → old confirm-gate rules; never 'phase:' keys", async () => {
    const id = insertTask(
      { goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding" },
      "built-in/v4-no-required-flow",
    )
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(["goal_confirmed", "ac_confirmed"])
  })

  it("AC2b: format=v4 takes over even when the v3 confirmations are all set", async () => {
    // A spec that WOULD pass the v3 gate but has no phases → v4 gate rejects.
    const id = insertTask({
      format: "v4",
      goal: "E2E_TD goal",
      ac: ["E2E_TD ac1"],
      task_type: "coding",
      goal_confirmed: true,
      ac_confirmed: ["E2E_TD ac1"],
    })
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(["phase:0:no-phases"])
  })
})

describe("ticket 04 AC3: unknown placeholder → missing entry, never 500", () => {
  it("AC3a: phase inputValues '${nope}' → 409 'phase:1:input:idea' (not 500)", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    insertV4Task(id, [
      {
        ...validPhase(id, 1),
        inputValues: { idea: "${nope}", spec_dir: "${phase.spec_dir}" },
      },
    ])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toEqual(["phase:1:input:idea"])
    // spec_dir via ${phase.spec_dir} IS satisfied → not in missing.
  })
})

describe("ADR-0018: ${phase.batch_rel} — ws 同构批次位（spec 消费型流绑定用）", () => {
  it("home-relative specPath → 这一轮吃到的 batch_dir 是 posix 相对批次目录", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    insertV4Task(id, [
      {
        ...validPhase(id, 1),
        workflowRef: "built-in/v4-no-required-flow",
        inputValues: { batch_dir: "${phase.batch_rel}" },
      },
    ])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status, await res.clone().text()).toBe(200)
    // 票03：没有冻结的信封 config 可读，启动计划每次 arm 现算 —— 所以断言读**行上的**
    // input_values（seed 下行用的正是同一个 batchRelPath，两者必须一字不差）。
    const launched = launchRow(id)
    expect(launched.input.batch_dir).toBe(".scratch/v4d/p1")
    const wsPath = (db
      .prepare("SELECT path FROM workspaces WHERE task_id=?")
      .get(id) as { path: string }).path
    expect(fs.existsSync(path.join(wsPath, ".scratch", "v4d", "p1", "spec.md"))).toBe(true)
  })

  it("specPath 落在 home 外（agent 绝对路径直写）→ batch_rel 解析空 → 409 input，不 500", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    const outside = path.join(tmpDir, "outside-batch", "spec.md")
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, "# outside\n")
    insertV4Task(id, [
      {
        index: 1, name: "P1", slug: "p1",
        specPath: outside, // gate ① 存在性 OK（绝对路径 verbatim）
        workflowRef: "built-in/v4-no-required-flow",
        inputValues: { batch_dir: "${phase.batch_rel}" },
      },
    ])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { missing: string[] }
    expect(body.missing).toContain("phase:1:input:batch_dir")
  })
})

describe("ticket 04 AC4 (票03 重写): 过闸不建信封，per-phase 解析结果落在启动行上", () => {
  it("AC4a: ready 200 → 零 schedule 行；arm 出的 executions 行带 phase1 解析后的 input_values", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    const p1 = validPhase(id, 1)
    const p2 = validPhase(id, 2)
    insertV4Task(id, [
      {
        ...p1,
        slug: "alpha-phase",
        inputValues: { idea: "${phase.slug}", spec_dir: "${phase.spec_dir}", home: "${task.home}" },
      },
      {
        ...p2,
        workflowRef: "built-in/v4-no-required-flow",
        inputValues: { art: "${task_artifacts_dir}" },
      },
    ])

    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    // 入队只写状态：三张 schedule 表一行都不该有（K5「一任务一信封」随票03 退役）。
    for (const table of ["schedules", "schedule_executions", "schedule_workspaces"]) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()).toEqual({ c: 0 })
    }

    const launched = launchRow(id)
    // 首触就是 phase 1 那一轮 —— 不再有「把 chain[0] 预载成 phase 1」这一步。
    expect(launched.ref).toBe("built-in/v4-required-flow")
    expect([launched.phase, launched.round]).toEqual([1, 1])
    // v4 词表逐键解析（specPath/slug 仍是 validPhase 的 p1，变的只是展示名）。
    expect(launched.input.idea).toBe("alpha-phase")
    expect(launched.input.spec_dir).toBe(path.join(taskHome.homePath(id), ".scratch", "v4d", "p1"))
    expect(launched.input.home).toBe(taskHome.homePath(id))
    // 管理键（seed/collect 的挂载点）由 materialize 追加。
    expect(launched.input.task_artifacts_dir).toBe(taskHome.artifactsDir(id))
  })

  it("AC4b: 后续轮按 (phase,round) 现算 —— 轮次坐标建行即带，不再改写任何定义", async () => {
    const id = insertTask({ format: "v4", task_type: "coding", phases: [] })
    const p1 = validPhase(id, 1)
    const p2 = validPhase(id, 2)
    insertV4Task(id, [
      p1,
      { ...p2, workflowRef: "built-in/v4-no-required-flow", inputValues: { art: "${task_artifacts_dir}" } },
    ])
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)

    const launched = service.taskLifecycle.armTask(id, { phaseIndex: 2, roundIndex: 2, feedback: "重做" })
    const row = execs.findById(launched)!
    expect(row.workflow_ref).toBe("built-in/v4-no-required-flow")
    expect([row.phase_index, row.round_index]).toEqual([2, 2])
    const iv = JSON.parse(row.input_values) as Record<string, string>
    expect(iv.art).toBe(taskHome.artifactsDir(id))
    expect(iv._phase_index).toBe("2")
    expect(iv._round_index).toBe("2")
    expect(iv.feedback).toBe("重做")
    // 定义层零写入：task_spec.phases[] 还是作者写的那份。
    const spec = JSON.parse(
      (db.prepare("SELECT task_spec FROM tasks WHERE id=?").get(id) as { task_spec: string }).task_spec,
    ) as { phases: Array<{ inputValues: Record<string, string> }> }
    expect(Object.keys(spec.phases[1].inputValues)).toEqual(["art"])
  })

  it("AC4c: v3 任务的一轮 = 绑定的 workflow_ref，且不打 phase/round 标（回归）", async () => {
    const id = insertTask(
      {
        goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding",
        goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
      },
      "built-in/v4-no-required-flow",
    )
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(db.prepare("SELECT COUNT(*) c FROM schedules").get()).toEqual({ c: 0 })

    const launched = launchRow(id)
    expect(launched.ref).toBe("built-in/v4-no-required-flow")
    expect([launched.phase, launched.round]).toEqual([null, null])
    // v3 没有 phases[] 可解析 —— 不该冒出轮次键，但管理键同规则注入。
    expect(launched.input._phase_index).toBeUndefined()
    expect(launched.input.task_artifacts_dir).toBe(taskHome.artifactsDir(id))
  })
})

describe("ticket 04 vocab: resolveInputValues ctx overload (unit)", () => {
  it("resolves the four v4 placeholders from ctx", () => {
    const { values, unresolved } = resolveInputValues(
      { a: "${phase.slug}", b: "${phase.spec_dir}", c: "${task.home}", d: "${task_artifacts_dir}" },
      undefined, undefined,
      { phaseSlug: "s1", phaseSpecDir: "/home/.scratch/d/s1", taskHome: "/home", taskArtifactsDir: "/home/artifacts" },
    )
    expect(unresolved).toEqual([])
    expect(values).toEqual({ a: "s1", b: "/home/.scratch/d/s1", c: "/home", d: "/home/artifacts" })
  })

  it("keeps ${goal}/${ac} (v3 behavior byte-identical)", () => {
    const { values, unresolved } = resolveInputValues(
      { x: "${goal}", y: "${ac}" }, "G", ["A1", "A2"],
    )
    expect(unresolved).toEqual([])
    expect(values).toEqual({ x: "G", y: "A1\nA2" })
  })

  it("ctx omitted: v4 dotted names become unresolved (never literal, never throw)", () => {
    const { values, unresolved } = resolveInputValues(
      { x: "${phase.slug}" }, "G", ["A"],
    )
    expect(values.x).toBe("")
    expect(unresolved).toEqual(["x"])
  })

  it("ctx present but value empty → unresolved (placeholder-present-but-empty discipline)", () => {
    const { values, unresolved } = resolveInputValues(
      { x: "pre-${phase.slug}-post" }, undefined, undefined, { phaseSlug: "" },
    )
    // slug empty → substitution is "" → key surfaces as unresolved
    expect(values.x).toBe("pre--post")
    expect(unresolved).toEqual(["x"])
  })

  it("v4 spec without goal/ac: ${goal} in a phase value → unresolved (never 'undefined' literal)", () => {
    const { values, unresolved } = resolveInputValues(
      { x: "${goal}" }, undefined, undefined, { taskHome: "/h" },
    )
    expect(values.x).toBe("")
    expect(unresolved).toEqual(["x"])
  })
})
