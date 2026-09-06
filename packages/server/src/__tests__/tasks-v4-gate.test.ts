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
//   AC4: a passing v4 ready materializes the envelope: schedule status='draft',
//        origin_type='task', config carries format='v4' + per-phase resolved
//        phases[] (absolute specPath, placeholder-resolved input_values,
//        managed task_artifacts_dir key) and workflow_chain[0] = phase 1.
//   Vocab: ${phase.slug} / ${phase.spec_dir} / ${task.home} /
//          ${task_artifacts_dir} resolve via resolveInputValues ctx overload;
//          ${goal}/${ac} preserved; no-ctx dotted names → unresolved (no throw).
//
// Anti-fake-run: real DB + applySchema (R1/R3/R5), Hono app.request (R3),
// E2E_TD_ data prefix (R7), assert response body + SQL + fs (R4).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { AgentSessionDAO } from "../db/dao"
import { SSEService } from "../services/sse"
import { TasksService } from "../services/tasks/tasks-service"
import { createTasksRoutes } from "../routes/tasks"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { resolveInputValues } from "../services/scheduler/template-resolver"
import path from "path"
import os from "os"
import fs from "fs"

const ORG = "e2e-td-v4gate"

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
let taskHome: TaskHomeService
let nextTaskSeq = 0

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
  const sse = new SSEService()
  tmpDir = path.join(os.tmpdir(), `test-v4-gate-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  taskHome = new TaskHomeService(tmpDir)
  const stubBuiltIn = {
    get(ref: string) {
      if (ref.includes("v4-required-flow")) return { ref, content: WORKFLOW_REQUIRED_INPUTS }
      if (ref.includes("v4-no-required")) return { ref, content: WORKFLOW_NO_REQUIRED_INPUTS }
      return null
    },
  } as any
  const service = new TasksService(
    db, sse, new AgentSessionDAO(db), taskHome, undefined, stubBuiltIn,
  )
  app = new Hono()
  app.route("/api/tasks", createTasksRoutes(service, sse))
})

afterAll(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
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
  it("home-relative specPath → envelope 冻结 posix 相对批次目录", async () => {
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
    const sched = db
      .prepare("SELECT config FROM schedules WHERE origin_type='task' AND origin_id=?")
      .get(id) as { config: string }
    const config = JSON.parse(sched.config) as {
      phases: Array<{ inputValues: Record<string, string> }>
      workflow_chain: Array<{ input_values: Record<string, string> }>
    }
    // posix home-relative —— 与 seed 下行到 ws 的落位一字不差。
    expect(config.phases[0].inputValues.batch_dir).toBe(".scratch/v4d/p1")
    expect(config.workflow_chain[0].input_values.batch_dir).toBe(".scratch/v4d/p1")
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

describe("ticket 04 AC4: v4 materialize embeds per-phase results in the envelope", () => {
  it("AC4a: ready 200 → one draft task-origin envelope; config.format=v4 + phases[] resolved", async () => {
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

    // DB cross-check (R3): exactly one envelope, draft-parked, task origin (K5).
    const rows = db.prepare(
      "SELECT * FROM schedules WHERE origin_type = 'task' AND origin_id = ?",
    ).all(id) as Array<{ status: string; origin_role: string; config: string }>
    expect(rows).toHaveLength(1)
    const sched = rows[0]
    expect(sched.status).toBe("draft")
    expect(sched.origin_role).toBe("primary")

    const config = JSON.parse(sched.config) as {
      format?: string
      phases?: Array<{
        index: number; slug: string; specPath: string; specDir: string
        workflowRef: string; inputValues: Record<string, string>
      }>
      workflow_chain: Array<{ workflow_ref: string; input_values: Record<string, string> }>
    }
    expect(config.format).toBe("v4")
    expect(config.phases).toHaveLength(2)

    const [cp1, cp2] = config.phases!
    // specPath resolved to an absolute under the task home and exists.
    expect(path.isAbsolute(cp1.specPath)).toBe(true)
    expect(fs.existsSync(cp1.specPath)).toBe(true)
    expect(cp1.specDir).toBe(path.dirname(cp1.specPath))
    // v4 vocabulary resolved per-phase. specPath/slug stay the validPhase
    // defaults (p1) — only the NAME shown to the UI is "alpha-phase".
    expect(cp1.inputValues.idea).toBe("alpha-phase")
    expect(cp1.inputValues.spec_dir).toBe(path.join(taskHome.homePath(id), ".scratch", "v4d", "p1"))
    expect(cp1.inputValues.home).toBe(taskHome.homePath(id))
    expect(cp2.inputValues.art).toBe(taskHome.artifactsDir(id))
    // Managed keys appended per-phase (ticket 05 seed/collect contract).
    expect(cp1.inputValues.task_artifacts_dir).toBe(taskHome.artifactsDir(id))
    // Per-phase workflow_ref carried through.
    expect(cp2.workflowRef).toBe("built-in/v4-no-required-flow")

    // One-schedule envelope (K5): chain[0] = phase 1 → trigger runs it directly.
    expect(config.workflow_chain).toHaveLength(1)
    expect(config.workflow_chain[0].workflow_ref).toBe("built-in/v4-required-flow")
    expect(config.workflow_chain[0].input_values.idea).toBe("alpha-phase")
    expect(config.workflow_chain[0].input_values.spec_dir).toBe(
      path.join(taskHome.homePath(id), ".scratch", "v4d", "p1"),
    )
  })

  it("AC4b: v3 ready envelope shape unchanged — NO format/phases keys (regression)", async () => {
    const id = insertTask(
      {
        goal: "E2E_TD goal", ac: ["E2E_TD ac1"], task_type: "coding",
        goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
      },
      "built-in/v4-no-required-flow",
    )
    const res = await app.request(`/api/tasks/${id}/ready`, { method: "POST" })
    expect(res.status).toBe(200)
    const sched = db.prepare(
      "SELECT config FROM schedules WHERE origin_type = 'task' AND origin_id = ?",
    ).get(id) as { config: string }
    const config = JSON.parse(sched.config) as Record<string, unknown>
    expect(config.format).toBeUndefined()
    expect(config.phases).toBeUndefined()
    expect((config.workflow_chain as Array<Record<string, unknown>>)[0].workflow_ref).toBe(
      "built-in/v4-no-required-flow",
    )
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
