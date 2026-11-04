// packages/server/src/__tests__/tasks-v3-dispatch.test.ts
//
// Ticket 08 — dispatch $vars.task_artifacts_dir / $vars.task_workflows_dir injection.
//
// ADR-0021 票03 rewrite notes (this file moved with the materializer):
//   * `materializeTaskSpecToConfig` was RENAMED to `buildTaskLaunchConfig` and MOVED out
//     of services/scheduler/scheduler-service.ts into services/tasks/task-materialize.ts
//     (first 7 positional args unchanged). AC1/AC4 are the same pure-function checks.
//   * The injection-seam describe used to read the materialized config back off a
//     schedules envelope that readyTask wrote. readyTask now writes ONLY the status
//     (contract §新行为 1: 不建任何 schedules 行) — asserted directly. The per-launch
//     materializer is armTask, so the injected TaskHomeService.baseDir is asserted on
//     the ARMED execution's input_values instead; the legacy (no home) case stays a
//     pure-function assertion because an empty workflow_ref refuses to arm by design.
//
// AC10 (ADR-0013 workflows copy) is unchanged in intent.
//
// Anti-fake-run: real better-sqlite3 + applySchema for the seam (R1/R3); real
// TaskHomeService path computation cross-checked (R3).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { buildTaskLaunchConfig } from "../services/tasks/task-materialize"
import { TaskHomeService } from "../services/tasks/task-home-service"
import { TasksService } from "../services/tasks/tasks-service"
import { TaskLifecycleService } from "../services/tasks/task-lifecycle-service"
import { SSEService } from "../services/sse"
import { applySchema } from "../db/schema"
import { TaskDAO } from "../db/dao/task-dao"
import { ExecutionDAO } from "../db/dao/execution-dao"
import type { TaskSpec } from "@octopus/shared"

const ORG = "e2e-td-08"

// ── Mock getExecutionService ───────────────────────────────────────────
// The armed paths stub the engine at the ExecutionService seam: create INSERTS a real
// executions row (so the armed shape is read back from disk, not from a spy) and keeps
// the full input for assertions.
const stub = vi.hoisted(() => ({
  db: null as Database.Database | null,
  seq: 0,
  created: [] as Array<Record<string, unknown>>,
}))
vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db?.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (workspaceId: string, input: Record<string, unknown>) => {
          const id = `td08-exec-${stub.seq++}`
          stub.db!.prepare(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, created_at, updated_at, task_id)
             VALUES (?, ?, '0', 0, ?, ?, 'pending', ?, '{}', ?, datetime('now'), datetime('now'), ?)`,
          ).run(
            id, workspaceId, String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
            JSON.stringify(input.input_values ?? {}), ORG, (input.task_id as string) ?? null,
          )
          stub.created.push({ id, workspaceId, ...input })
          return { id }
        },
        start: async () => {},
        registerExternalCallbacks: () => {},
        clearExternalCallbacks: () => {},
      },
    }
  },
}))

// ──────────────────────────────────────────────────────────────────────
//  AC1 + AC4: buildTaskLaunchConfig (pure function, no DB)
// ──────────────────────────────────────────────────────────────────────

describe("08 AC1/AC4: buildTaskLaunchConfig task_artifacts_dir injection", () => {
  const tmpBase = path.join(os.tmpdir(), `octopus-08-${Date.now()}`)
  const home = new TaskHomeService(tmpBase)
  const TASK_ID = "e2e-td-08-task-ac1"

  // AC1: simple task → input_values.task_artifacts_dir == homePath(id)/artifacts
  it("AC1: simple task config has input_values.task_artifacts_dir == artifactsDir(id)", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)
    // Cross-check the path convention (ADR-0011): base/tasks/{id}/artifacts
    expect(expected).toBe(path.join(tmpBase, "tasks", TASK_ID, "artifacts"))

    const config = buildTaskLaunchConfig(
      taskSpec, ["proj"], ORG, "e2e-td-08/wf", [], undefined, expected,
    )
    expect(config.workflow_chain[0].workflow_ref).toBe("e2e-td-08/wf")
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_artifacts_dir).toBe(expected)
  })

  // AC4: no taskArtifactsDir → key absent (legacy task backward compat)
  it("AC4: legacy task (no taskArtifactsDir) → no task_artifacts_dir key, no error", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const config = buildTaskLaunchConfig(taskSpec, ["proj"], ORG, "wf", [])
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_artifacts_dir).toBeUndefined()
  })

  // GS5/r2-05: key-set integrity — a stronger claim than toBeUndefined (catches a
  // "key set with undefined value" or a leaked extra key).
  it("AC1/AC4 boundary: simple input_values key-set is EXACTLY [task_artifacts_dir] when provided, [] when undefined (no leakage)", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const expected = home.artifactsDir(TASK_ID)

    const withArt = buildTaskLaunchConfig(
      taskSpec, ["proj"], ORG, "e2e-td-08/wf", [], undefined, expected,
    )
    const ivWith = withArt.workflow_chain[0].input_values as Record<string, unknown>
    expect(Object.keys(ivWith)).toEqual(["task_artifacts_dir"])

    const withoutArt = buildTaskLaunchConfig(taskSpec, ["proj"], ORG, "e2e-td-08/wf", [])
    const ivWithout = withoutArt.workflow_chain[0].input_values as Record<string, unknown>
    expect(Object.keys(ivWithout)).toEqual([])
  })

  // ADR-0013: the task_workflows_dir injection mirrors the artifacts one.
  it("ADR-0013: task_workflows_dir lands in input_values when a workflows dir is passed", () => {
    const taskSpec = { goal: "g", ac: ["a"] } as unknown as TaskSpec
    const wfDir = home.workflowsDir(TASK_ID)
    const config = buildTaskLaunchConfig(taskSpec, ["proj"], ORG, "wf", [], undefined, home.artifactsDir(TASK_ID), wfDir)
    const iv = config.workflow_chain[0].input_values as Record<string, unknown>
    expect(iv.task_workflows_dir).toBe(wfDir)
  })
})

describe("08 injection-seam: readyTask creates no envelope; armTask uses the injected TaskHomeService baseDir", () => {
  let db: Database.Database
  let tempBase: string
  let svc: TasksService
  let lifecycle: TaskLifecycleService
  let execs: ExecutionDAO
  let wsSeq = 0
  const homeBase = path.join(os.tmpdir(), `octopus-seam-${Date.now()}`)
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF")
    stub.db = db
    stub.seq = 0
    stub.created = []
    wsSeq = 0
    tempBase = path.join(os.tmpdir(), `octopus-r2-05-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    process.env.HOME = homeBase
    process.env.USERPROFILE = homeBase
    const sse = new SSEService()
    const stubBuiltIn = {
      get(ref: string) {
        if (ref.includes("e2e-td")) return { ref, content: "stub-builtin" }
        return null
      },
    } as never
    svc = new TasksService(db, sse, undefined, new TaskHomeService(tempBase), undefined, stubBuiltIn)
    const workspaceService = {
      getById: (id: string) => (db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as never) ?? undefined,
      ensureWorktreesForReuse: () => ({ rebuilt: [] }),
      createFromSpec: (input: Record<string, unknown>) => {
        const id = `seam-ws-${wsSeq++}`
        const p = path.join(os.tmpdir(), `octopus-seam-ws-${id}`)
        fs.mkdirSync(path.join(p, "workflows"), { recursive: true })
        db.prepare(
          `INSERT INTO workspaces (id, name, repo_group, status, path, source, task_id, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, 'task', ?, datetime('now'), datetime('now'))`,
        ).run(id, String(input.name), ORG, p, (input.task_id as string) ?? null)
        return { id }
      },
    }
    lifecycle = new TaskLifecycleService({
      db,
      sse,
      workspaceService: workspaceService as never,
      builtInWorkflows: stubBuiltIn,
      taskHomeService: new TaskHomeService(tempBase),
    })
    execs = new ExecutionDAO(db)
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    db.close()
    try { fs.rmSync(tempBase, { recursive: true, force: true }) } catch { /* */ }
  })

  function insertDraftTask(id: string, spec: Record<string, unknown>, workflowRef: string | null = null): void {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO tasks (id, repo_group, name, status, source_chat_session_id, task_spec,
        authoring_resources, resources, skills, project_ids, workflow_ref, version,
        deleted_at, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, 'draft', NULL, ?, '[]', '[]', '[]', '[]', ?, 1, NULL, ?, ?, NULL)
    `).run(id, ORG, "r2-05-task", JSON.stringify(spec), workflowRef, now, now)
  }

  it("AC1/§1: readyTask flips status to ready and creates NO schedules row (contract §新行为 1)", () => {
    const id = "e2e-td-08-seam-nosched"
    insertDraftTask(id, {
      goal: "E2E_TD goal", ac: ["E2E_TD ac1"],
      task_type: "coding", goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
    }, "e2e-td-08/wf")

    const dto = svc.readyTask(id)
    expect(dto.status).toBe("ready")
    // The envelope is dead: enqueuing touches no schedule table at all.
    expect((db.prepare("SELECT COUNT(*) c FROM schedules").get() as { c: number }).c).toBe(0)
  })

  it("AC1-seam: v3 task arm → input_values.task_artifacts_dir carries injected tempBase (not default homedir)", () => {
    const id = "e2e-td-08-seam-v3"
    insertDraftTask(id, {
      goal: "E2E_TD r2-05 goal", ac: ["E2E_TD ac1"],
      task_type: "coding", goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
    }, "e2e-td-08/wf")
    svc.readyTask(id)
    const execId = lifecycle.armTask(id)
    const iv = JSON.parse(execs.findById(execId)!.input_values) as Record<string, unknown>
    const expected = path.join(tempBase, "tasks", id, "artifacts")
    // The injected base threaded through the per-launch materializer.
    expect(iv.task_artifacts_dir).toBe(expected)
    // SG5/r2-05 preserved: task_spec is dropped from the plan (lives in the tasks table);
    // the armed input_values carries no task_spec trace either.
    expect(iv).not.toHaveProperty("task_spec")
  })

  it("AC1-seam: v3 task arm → input_values carries task_workflows_dir (ADR-0013 injection seam)", () => {
    const id = "e2e-td-08-seam-wf"
    insertDraftTask(id, {
      goal: "E2E_TD r2-05 wf", ac: ["E2E_TD ac1"],
      task_type: "coding", goal_confirmed: true, ac_confirmed: ["E2E_TD ac1"],
    }, "e2e-td-08/wf")
    svc.readyTask(id)
    const execId = lifecycle.armTask(id)
    const iv = JSON.parse(execs.findById(execId)!.input_values) as Record<string, unknown>
    expect(iv.task_workflows_dir).toBe(path.join(tempBase, "tasks", id, "workflows"))
  })
})

// ──────────────────────────────────────────────────────────────────────
//  AC10: dispatch copy — {home}/workflows/*.yaml → ws workflows/ (ADR-0013)
// ──────────────────────────────────────────────────────────────────────

describe("08 AC10: dispatch copy — task_workflows_dir YAMLs copied into ws workflows/", () => {
  let tmpHome: string
  let tmpWs: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-td-ac10-home-"))
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-td-ac10-ws-"))
    fs.mkdirSync(path.join(tmpWs, "workflows"), { recursive: true })
  })

  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
    try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch { /* */ }
  })

  it("copies YAML files from task_workflows_dir into ws workflows/", async () => {
    const srcDir = path.join(tmpHome, "tasks", "task-1", "workflows")
    fs.mkdirSync(srcDir, { recursive: true })
    fs.writeFileSync(path.join(srcDir, "my-flow.yaml"), "workflow: my-flow\n", "utf-8")
    fs.writeFileSync(path.join(srcDir, "other.yml"), "workflow: other\n", "utf-8")
    fs.writeFileSync(path.join(srcDir, "readme.md"), "ignore me", "utf-8")

    // 票03: the copy helper moved to services/tasks/task-artifact-sync (the executor
    // now imports it from there); ADR-0013 behaviour is unchanged.
    const { copyTaskWorkflowsToWs } = await import("../services/tasks/task-artifact-sync")
    copyTaskWorkflowsToWs(srcDir, tmpWs)

    const wsWf = path.join(tmpWs, "workflows")
    expect(fs.existsSync(path.join(wsWf, "my-flow.yaml"))).toBe(true)
    expect(fs.existsSync(path.join(wsWf, "other.yml"))).toBe(true)
    expect(fs.existsSync(path.join(wsWf, "readme.md"))).toBe(false)
    expect(fs.readFileSync(path.join(wsWf, "my-flow.yaml"), "utf-8")).toBe("workflow: my-flow\n")
  })

  it("no-op when source dir is missing (legacy tasks)", async () => {
    // 票03: the copy helper moved to services/tasks/task-artifact-sync (the executor
    // now imports it from there); ADR-0013 behaviour is unchanged.
    const { copyTaskWorkflowsToWs } = await import("../services/tasks/task-artifact-sync")
    copyTaskWorkflowsToWs("/nonexistent/path", tmpWs)
    expect(fs.readdirSync(path.join(tmpWs, "workflows"))).toEqual([])
  })

  it("no-op when source dir is empty", async () => {
    const emptyDir = path.join(tmpHome, "empty")
    fs.mkdirSync(emptyDir, { recursive: true })
    // 票03: the copy helper moved to services/tasks/task-artifact-sync (the executor
    // now imports it from there); ADR-0013 behaviour is unchanged.
    const { copyTaskWorkflowsToWs } = await import("../services/tasks/task-artifact-sync")
    copyTaskWorkflowsToWs(emptyDir, tmpWs)
    expect(fs.readdirSync(path.join(tmpWs, "workflows"))).toEqual([])
  })
})
