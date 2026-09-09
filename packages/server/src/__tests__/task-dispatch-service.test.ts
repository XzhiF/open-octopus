// packages/server/src/__tests__/task-dispatch-service.test.ts
//
// ADR-0021 票03/票04 — TaskDispatchService, the port the engine's `task_dispatch`
// node calls (server side). Rewritten for the new child shape.
//
// The child used to be born as a private `schedules` row (origin_type='task',
// origin_role='subunit') whose config smuggled in a `parent_task_dispatch` marker so a
// restart could still find the parent. That is gone. The child is now an `executions`
// row (parent_id = the dispatching run, task_id = the parent task), and the parent's
// resume target is DERIVED from those rows: parent_id says which run, that run's
// still-running node says which task_dispatch node. The correlation is therefore
// restart-safe by construction (both are persisted rows), not because a marker was
// written, so the old "marker exists in config" assertions no longer have a referent
// and are deleted; the equivalent, STRONGER claim is that the child row carries
// parent_id + task_id and resume reads them back.
//
// What survives the rewrite, intent for intent:
//   dispatchChild returns a ChildHandle and creates a distinct CHILD RUN correlated to
//   the parent → it is now `{ child_id, workspace_id }` and the child row has
//   parent_id + task_id;
//   resumeOnCompletion reads the correlation from the DB (no in-memory closure) and
//   calls the parent-resume with the child's output → it now resolves parent_id → the
//   parent's running node → ExecutionService.resumeTaskDispatch(parentId, nodeId, out);
//   restart-safety (brand-new service over the same DB still resumes) → holds verbatim,
//   because nothing was ever in memory.
//   A failed/vanished child resumes the parent with an EMPTY output rather than
//   stalling it forever (contract §新行为 11).
//   The two "throws when no marker / throws when callback unwired" tests are DELETED,
//   not weakened: there is no marker to be missing and no callback to be unwired. The
//   new shape's analogous guarantees — "child with no parent is a no-op" and "parent
//   workspace unavailable stays paused for its own recovery" — are asserted instead.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TaskDispatchService } from "../services/scheduler/task-dispatch-service"
import type { SubunitSpec } from "@octopus/shared"

// Pin the shared cap at 2 so "under cap starts / over cap parks" is about the CODE
// respecting the meter, not about the number in the environment (task-lifecycle
// precedent). task-child-run imports ../scheduler/concurrency; from this file that
// module resolves to services/scheduler/concurrency — same specifier string below.
vi.mock("../services/scheduler/concurrency", () => ({
  MAX_PARALLEL_WORKSPACES: 2,
  MAX_AGENT_CONCURRENCY: 10,
  STALE_CLAIMED_THRESHOLD_MS: 600_000,
}))

// The ExecutionService registry is a process singleton keyed by workspace id. Stub it
// with a real INSERT so the child row exists for claimLaunch/resume to read, and so a
// parent-workspace lookup can hand back resumeTaskDispatch. Backed by the per-test DB
// the stub reads from `stub.db` (set in beforeEach).
const stub = vi.hoisted(() => ({
  db: null as Database.Database | null,
  seq: 0,
  started: [] as string[],
  callbacks: new Map<string, (status?: string) => void>(),
  resumes: [] as Array<{ parentId: string; nodeId: string; output: Record<string, unknown> }>,
}))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: (wsId: string) => {
    const ws = stub.db!.prepare("SELECT path FROM workspaces WHERE id = ?").get(wsId) as
      { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: (workspaceId: string, input: Record<string, unknown>) => {
          const id = `child-exec-${stub.seq++}`
          stub.db!.prepare(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, triggered_by, created_at, updated_at, task_id)
             VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '{}', ?, ?, datetime('now'), datetime('now'), ?)`,
          ).run(
            id, workspaceId,
            String(input.parent_id ?? "0"), Number(input.child_index ?? 0),
            String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
            JSON.stringify(input.input_values ?? {}),
            String(input.org ?? "e2e-tp-org"), String(input.triggered_by ?? "task_dispatch"),
            (input.task_id as string) ?? null,
          )
          return { id }
        },
        start: async (id: string) => {
          stub.started.push(id)
          stub.db!.prepare("UPDATE executions SET status='running', started_at=datetime('now') WHERE id=?").run(id)
        },
        registerExternalCallbacks: (cbs: { onComplete?: (s?: string) => void }, id: string) => {
          if (cbs.onComplete) stub.callbacks.set(id, cbs.onComplete as (s?: string) => void)
        },
        clearExternalCallbacks: (id: string) => { stub.callbacks.delete(id) },
        resumeTaskDispatch: async (parentId: string, nodeId: string, output: Record<string, unknown>) => {
          stub.resumes.push({ parentId, nodeId, output })
        },
      },
    }
  },
}))

const ORG = "e2e-tp-org"
const WORKSPACE_ID = "ws-coordinator-1" // the dispatching (parent) workspace
const WORKSPACE_PATH = path.join(os.tmpdir(), `e2e-tp-tds-${Date.now()}`)

function makeSubunit(name = "E2E_TP_subunit_a"): SubunitSpec {
  return {
    name,
    workspace_spec: {
      org: ORG,
      branch_prefix: `e2e-tp-sub`,
      projects: [{ name: "E2E_TP_project", source_path: "", group: "" }],
    },
    workflow_ref: "e2e-tp/simple-spec-workflow",
    input_values: {},
    skills: [],
    resources: [],
  }
}

describe("TaskDispatchService — child run + parent-resume correlation (票03/票04)", () => {
  let db: Database.Database
  let service: TaskDispatchService
  let execs: ExecutionDAO
  let wsSeq = 0

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF") // the coordinator/child ws are seeded by SQL, not real dirs
    stub.db = db
    stub.seq = 0
    stub.started = []
    stub.callbacks = new Map()
    stub.resumes = []
    wsSeq = 0

    const now = new Date().toISOString()
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(WORKSPACE_ID, "e2e-tp-coordinator", ORG, WORKSPACE_PATH, now, now)

    service = new TaskDispatchService({
      db,
      workspaceId: WORKSPACE_ID,
      workspacePath: WORKSPACE_PATH,
      org: ORG,
      // Only createFromSpec is reached on the dispatch path; hand back a fresh,
      // registered child workspace so the registry stub resolves it.
      workspaceService: {
        createFromSpec: (input: Record<string, unknown>) => {
          const id = `ws-child-${wsSeq++}`
          db.prepare(
            "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
          ).run(id, String(input.name ?? id), ORG, path.join(os.tmpdir(), `e2e-tp-child-${id}`))
          return { id }
        },
      } as never,
      sse: new SSEService(),
    })
    execs = new ExecutionDAO(db)
  })

  afterEach(() => {
    db.close()
    if (fs.existsSync(WORKSPACE_PATH)) fs.rmSync(WORKSPACE_PATH, { recursive: true, force: true })
  })

  /** Seed the dispatching PARENT: a running execution in the coordinator workspace,
   *  with a running task_dispatch node. task_id links it to the parent task. */
  function seedRunningParent(parentExecId: string, nodeId: string, taskId: string | null = "task-parent-1"): void {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at, task_id)
       VALUES (?, ?, '0', 'composition-wf', 'composition-wf', ?, 'running', ?, ?, ?, ?)`,
    ).run(parentExecId, WORKSPACE_ID, ORG, now, now, now, taskId)
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES (?, ?, ?, 'task_dispatch', 'running', ?)",
    ).run(`${parentExecId}-${nodeId}`, parentExecId, nodeId, now)
  }

  // ── dispatchChild → child executions row + ChildHandle ──────────────
  it("dispatchChild creates a distinct CHILD execution row (parent_id + task_id), not a schedule", async () => {
    seedRunningParent("exec-parent-1", "dispatch-node-1", "task-parent-1")

    const handle = await service.dispatchChild(makeSubunit())

    // The handle is { child_id, workspace_id } (was { schedule_id } on the old shape).
    expect(handle.child_id).toBeTruthy()
    expect(handle.workspace_id).toBeTruthy()
    expect(handle.child_id).not.toBe("exec-parent-1")

    // The load-bearing correlation: the child is an executions row whose parent_id is
    // the dispatching run and whose task_id is the parent task. No schedules row exists.
    const child = execs.findById(handle.child_id)!
    expect(child.parent_id).toBe("exec-parent-1")
    expect(child.task_id).toBe("task-parent-1")
    expect(child.workflow_ref).toBe("e2e-tp/simple-spec-workflow")
    const schedCount = (db.prepare("SELECT COUNT(*) AS c FROM schedules").get() as { c: number }).c
    expect(schedCount).toBe(0)

    // Under the shared cap the child is claimed + started immediately.
    expect(stub.started).toContain(handle.child_id)
  })

  it("dispatches an INDEPENDENT workspace per subunit and a stable child_index ordering", async () => {
    // KNOWN PRODUCT BUG (票04-partial, reported not papered): the second dispatch from
    // ONE parent throws "找不到本工作区内正在运行的父执行". resolveParentRun
    // (task-child-run.ts:238) → findRunningLeaves (execution-dao.ts:26) excludes ANY
    // execution that has a child row, but the NOT EXISTS is not workspace-scoped — and
    // a task_dispatch child lives in its OWN sibling workspace. So after child #1 is
    // created, its parent stops being a "running leaf" forever, and a composite with
    // N≥2 subunits (the core Loop-over-subunits path) dies on subunit #2.
    // This assertion is the contract (each subunit fans out independently, ordered);
    // it goes green when the leaf filter is scoped to same-workspace children or the
    // parent lookup stops excluding completed/foreign-workspace children.
    seedRunningParent("exec-parent-2", "dispatch-node-2")

    const a = await service.dispatchChild(makeSubunit("a"))
    const b = await service.dispatchChild(makeSubunit("b"))

    expect(a.workspace_id).not.toBe(b.workspace_id)
    // child_index keeps the fan-out order for the parent's aggregation.
    expect(execs.findById(a.child_id)!.child_index).toBe(0)
    expect(execs.findById(b.child_id)!.child_index).toBe(1)
  })

  // ── resumeOnCompletion derives parent + running node, then resumes ─
  it("resumeOnCompletion resumes the parent's RUNNING task_dispatch node with the child output (derived, restart-safe)", async () => {
    seedRunningParent("exec-parent-3", "dispatch-node-3")
    const handle = await service.dispatchChild(makeSubunit())

    const childOutput = { result: "E2E_TP_synthesis_body", meta: { ok: true } }

    // A brand-new service over the same DB — nothing about the parent was held in
    // memory by the dispatcher, so a restarted process resumes identically.
    const restarted = new TaskDispatchService({
      db,
      workspaceId: WORKSPACE_ID,
      workspacePath: WORKSPACE_PATH,
      org: ORG,
      workspaceService: { createFromSpec: vi.fn() } as never,
      sse: new SSEService(),
    })
    await restarted.resumeOnCompletion(handle, childOutput)

    // parent_id + the parent's running node resolved the resume target.
    expect(stub.resumes).toHaveLength(1)
    expect(stub.resumes[0]).toMatchObject({
      parentId: "exec-parent-3",
      nodeId: "dispatch-node-3",
      output: childOutput,
    })
  })

  it("an over-cap child stays PENDING and the built-in job's claim starts it", async () => {
    seedRunningParent("exec-parent-4", "dispatch-node-4")
    // Occupy the cap: the parent itself counts as 1 live task run, so one more live
    // row (any task execution) pushes countActiveWork to the pinned cap of 2.
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at, task_id)
       VALUES ('exec-busy', ?, '0', 'w', 'w', ?, 'running', ?, ?, ?, 'task-busy')`,
    ).run(WORKSPACE_ID, ORG, now, now, now)

    const handle = await service.dispatchChild(makeSubunit())

    // Parked, not started: it waits on the SAME queue a root launch uses.
    expect(execs.findById(handle.child_id)!.status).toBe("pending")
    expect(stub.started).not.toContain(handle.child_id)
  })

  // ── failed / empty child: resume with an EMPTY output, never stall ─
  it("resumeOnCompletion with a child that has no var_pool resumes the parent with {}", async () => {
    seedRunningParent("exec-parent-5", "dispatch-node-5")
    const childId = "exec-child-empty"
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, var_pool, created_at, updated_at, task_id)
       VALUES (?, ?, 'exec-parent-5', 'w', 'w', ?, 'failed', '{}', ?, ?, 'task-parent-5')`,
    ).run(childId, "ws-child-x", ORG, now, now)
    // The child's workspace row must resolve for the resume path to reach the parent.
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('ws-child-x', 'c', ?, '/tmp/x', datetime('now'), datetime('now'))",
    ).run(ORG)

    // No outputOverride → resumeParentFromChild reads the child's var_pool. Empty pool
    // (a failed child) → the parent is resumed with {} so the composition wf decides.
    const { resumeParentFromChild } = await import("../services/tasks/task-child-run")
    await resumeParentFromChild(db, childId)

    expect(stub.resumes).toHaveLength(1)
    expect(stub.resumes[0]).toMatchObject({ parentId: "exec-parent-5", nodeId: "dispatch-node-5", output: {} })
  })

  // ── the two "throws" tests replaced by the new shape's guarantees ─
  it("a child with no parent is a no-op (does not throw, does not fabricate a resume)", async () => {
    const childId = "exec-orphan"
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, var_pool, created_at, updated_at)
       VALUES (?, ?, '0', 'w', 'w', ?, 'completed', '{}', ?, ?)`,
    ).run(childId, WORKSPACE_ID, ORG, now, now)

    const { resumeParentFromChild } = await import("../services/tasks/task-child-run")
    await expect(resumeParentFromChild(db, childId)).resolves.toBeUndefined()
    expect(stub.resumes).toHaveLength(0)
  })

  it("a parent whose engine/workspace is gone leaves the parent paused (no throw, resume deferred)", async () => {
    // Parent row exists but its workspace is NOT registered → getExecutionService
    // returns undefined → the child result is not forwarded; the parent's own
    // recovery picks it up. The old "resumeParent callback not wired → throws" path
    // has no equivalent failure now — a missing engine is expected, not fatal.
    seedRunningParent("exec-parent-6", "dispatch-node-6")
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(WORKSPACE_ID)
    const childId = "exec-child-6"
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, var_pool, created_at, updated_at, task_id)
       VALUES (?, ?, 'exec-parent-6', 'w', 'w', ?, 'completed', '{"result":"x"}', ?, ?, 'task-parent-6')`,
    ).run(childId, "ws-child-6", ORG, now, now)
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('ws-child-6', 'c', ?, '/tmp/x6', datetime('now'), datetime('now'))",
    ).run(ORG)

    const { resumeParentFromChild } = await import("../services/tasks/task-child-run")
    await expect(resumeParentFromChild(db, childId)).resolves.toBeUndefined()
    expect(stub.resumes).toHaveLength(0)
  })
})
