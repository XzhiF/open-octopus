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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../db/schema"
import { SSEService } from "../services/sse"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { describePg, setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"
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
// [P1 B5 票6b-1] 单引擎归一：executions/workspaces/node_executions 均为 PG ——
// 票4R 的 mirrorExecsToPg 混窗镜像删除，桩直写注册池（pg 模块级供 vi.mock 闭包）。
let pg: PgFixture | null = null

const stub = vi.hoisted(() => ({
  seq: 0,
  started: [] as string[],
  callbacks: new Map<string, (status?: string) => void>(),
  resumes: [] as Array<{ parentId: string; nodeId: string; output: Record<string, unknown> }>,
}))

vi.mock("../services/execution-service-registry", () => ({
  getExecutionService: async (wsId: string) => {
    const wsRows = await pg!.sql`SELECT path FROM workspaces WHERE id = ${wsId}`
    const ws = wsRows[0] as { path: string } | undefined
    if (!ws) return undefined
    return {
      wsPath: ws.path,
      service: {
        create: async (workspaceId: string, input: Record<string, unknown>) => {
          const id = `child-exec-${stub.seq++}`
          await pg!.sql.unsafe(
            `INSERT INTO executions
               (id, workspace_id, parent_id, child_index, workflow_ref, workflow_name, status,
                input_values, var_pool, org, triggered_by, created_at, updated_at, task_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7::jsonb, '{}'::jsonb, $8, $9, now(), now(), $10)`,
            [
              id, workspaceId,
              String(input.parent_id ?? "0"), Number(input.child_index ?? 0),
              String(input.workflow_ref ?? ""), String(input.workflow_ref ?? ""),
              JSON.stringify(input.input_values ?? {}),
              String(input.org ?? "e2e-tp-org"), String(input.triggered_by ?? "task_dispatch"),
              (input.task_id as string) ?? null,
            ],
          )
          return { id }
        },
        start: async (id: string) => {
          stub.started.push(id)
          await pg!.sql.unsafe("UPDATE executions SET status='running', started_at=now() WHERE id=$1", [id])
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

describePg("TaskDispatchService — child run + parent-resume correlation (票03/票04)", () => {
  let db: Database.Database
  // P1 B2：dispatchChildRun 读父任务行经 new TaskDAO(pgSql()) —— 全局池必须先注册。
  // 本文件父行 task_id 在 PG 无任务（getById → null → 走 taskpool-* 兜底命名），与旧语义一致。
  let service: TaskDispatchService
  let execs: ExecutionDAO
  let wsSeq = 0

  beforeAll(async () => {
    pg = await setupRegisteredPgSchema()
  })
  afterAll(async () => {
    await pg?.close()
    pg = null
  })

  beforeEach(async () => {
    await pg!.truncate("node_executions", "executions", "workspaces", "schedule_executions", "schedules")
    db = new Database(":memory:")
    applySchema(db)
    db.pragma("foreign_keys = OFF") // the coordinator/child ws are seeded by SQL, not real dirs
    stub.seq = 0
    stub.started = []
    stub.callbacks = new Map()
    stub.resumes = []
    wsSeq = 0

    await pg!.sql.unsafe(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())",
      [WORKSPACE_ID, "e2e-tp-coordinator", ORG, WORKSPACE_PATH],
    )

    service = new TaskDispatchService({
      db,
      workspaceId: WORKSPACE_ID,
      workspacePath: WORKSPACE_PATH,
      org: ORG,
      // Only createFromSpec is reached on the dispatch path; hand back a fresh,
      // registered child workspace so the registry stub resolves it.
      workspaceService: {
        createFromSpec: async (input: Record<string, unknown>) => {
          const id = `ws-child-${wsSeq++}`
          await pg!.sql.unsafe(
            "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())",
            [id, String(input.name ?? id), ORG, path.join(os.tmpdir(), `e2e-tp-child-${id}`)],
          )
          return { id }
        },
      } as never,
      sse: new SSEService(),
    })
    execs = new ExecutionDAO(pg!.sql)
    // [票6b-1] 计量闸镜像 spy 已删 —— countActiveWork 直读同库（单引擎归一）。
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
    if (fs.existsSync(WORKSPACE_PATH)) fs.rmSync(WORKSPACE_PATH, { recursive: true, force: true })
  })

  /** Seed the dispatching PARENT: a running execution in the coordinator workspace,
   *  with a running task_dispatch node. task_id links it to the parent task. */
  async function seedRunningParent(parentExecId: string, nodeId: string, taskId: string | null = "task-parent-1"): Promise<void> {
    await pg!.sql.unsafe(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at, task_id)
       VALUES ($1, $2, '0', 'composition-wf', 'composition-wf', $3, 'running', now(), now(), now(), $4)`,
      [parentExecId, WORKSPACE_ID, ORG, taskId],
    )
    await pg!.sql.unsafe(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status, started_at) VALUES ($1, $2, $3, 'task_dispatch', 'running', now())",
      [`${parentExecId}-${nodeId}`, parentExecId, nodeId],
    )
  }

  // ── dispatchChild → child executions row + ChildHandle ──────────────
  it("dispatchChild creates a distinct CHILD execution row (parent_id + task_id), not a schedule", async () => {
    await seedRunningParent("exec-parent-1", "dispatch-node-1", "task-parent-1")

    const handle = await service.dispatchChild(makeSubunit())

    // The handle is { child_id, workspace_id } (was { schedule_id } on the old shape).
    expect(handle.child_id).toBeTruthy()
    expect(handle.workspace_id).toBeTruthy()
    expect(handle.child_id).not.toBe("exec-parent-1")

    // The load-bearing correlation: the child is an executions row whose parent_id is
    // the dispatching run and whose task_id is the parent task. No schedules row exists.
    const child = (await execs.findById(handle.child_id))!
    expect(child.parent_id).toBe("exec-parent-1")
    expect(child.task_id).toBe("task-parent-1")
    expect(child.workflow_ref).toBe("e2e-tp/simple-spec-workflow")
    const schedRows = await pg!.sql`SELECT COUNT(*)::int AS c FROM schedules`
    expect((schedRows[0] as { c: number }).c).toBe(0)

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
    await seedRunningParent("exec-parent-2", "dispatch-node-2")

    const a = await service.dispatchChild(makeSubunit("a"))
    const b = await service.dispatchChild(makeSubunit("b"))

    expect(a.workspace_id).not.toBe(b.workspace_id)
    // child_index keeps the fan-out order for the parent's aggregation.
    expect((await execs.findById(a.child_id))!.child_index).toBe(0)
    expect((await execs.findById(b.child_id))!.child_index).toBe(1)
  })

  // ── resumeOnCompletion derives parent + running node, then resumes ─
  it("resumeOnCompletion resumes the parent's RUNNING task_dispatch node with the child output (derived, restart-safe)", async () => {
    await seedRunningParent("exec-parent-3", "dispatch-node-3")
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
    await seedRunningParent("exec-parent-4", "dispatch-node-4")
    // Occupy the cap: the parent itself counts as 1 live task run, so one more live
    // row (any task execution) pushes countActiveWork to the pinned cap of 2.
    await pg!.sql.unsafe(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, started_at, created_at, updated_at, task_id)
       VALUES ('exec-busy', $1, '0', 'w', 'w', $2, 'running', now(), now(), now(), 'task-busy')`,
      [WORKSPACE_ID, ORG],
    )

    const handle = await service.dispatchChild(makeSubunit())

    // Parked, not started: it waits on the SAME queue a root launch uses.
    expect((await execs.findById(handle.child_id))!.status).toBe("pending")
    expect(stub.started).not.toContain(handle.child_id)
  })

  // ── failed / empty child: resume with an EMPTY output, never stall ─
  it("resumeOnCompletion with a child that has no var_pool resumes the parent with {}", async () => {
    await seedRunningParent("exec-parent-5", "dispatch-node-5")
    const childId = "exec-child-empty"
    await pg!.sql.unsafe(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, var_pool, created_at, updated_at, task_id)
       VALUES ($1, 'ws-child-x', 'exec-parent-5', 'w', 'w', $2, 'failed', '{}'::jsonb, now(), now(), 'task-parent-5')`,
      [childId, ORG],
    )
    // The child's workspace row must resolve for the resume path to reach the parent.
    await pg!.sql.unsafe(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('ws-child-x', 'c', $1, '/tmp/x', now(), now())",
      [ORG],
    )

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
    await pg!.sql.unsafe(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, var_pool, created_at, updated_at)
       VALUES ($1, $2, '0', 'w', 'w', $3, 'completed', '{}'::jsonb, now(), now())`,
      [childId, WORKSPACE_ID, ORG],
    )

    const { resumeParentFromChild } = await import("../services/tasks/task-child-run")
    await expect(resumeParentFromChild(db, childId)).resolves.toBeUndefined()
    expect(stub.resumes).toHaveLength(0)
  })

  it("a parent whose engine/workspace is gone leaves the parent paused (no throw, resume deferred)", async () => {
    // Parent row exists but its workspace is NOT registered → getExecutionService
    // returns undefined → the child result is not forwarded; the parent's own
    // recovery picks it up. The old "resumeParent callback not wired → throws" path
    // has no equivalent failure now — a missing engine is expected, not fatal.
    await seedRunningParent("exec-parent-6", "dispatch-node-6")
    await pg!.sql.unsafe("DELETE FROM workspaces WHERE id = $1", [WORKSPACE_ID])
    const childId = "exec-child-6"
    await pg!.sql.unsafe(
      `INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, org, status, var_pool, created_at, updated_at, task_id)
       VALUES ($1, 'ws-child-6', 'exec-parent-6', 'w', 'w', $2, 'completed', '{"result":"x"}'::jsonb, now(), now(), 'task-parent-6')`,
      [childId, ORG],
    )
    await pg!.sql.unsafe(
      "INSERT INTO workspaces (id, name, org, path, created_at, updated_at) VALUES ('ws-child-6', 'c', $1, '/tmp/x6', now(), now())",
      [ORG],
    )

    const { resumeParentFromChild } = await import("../services/tasks/task-child-run")
    await expect(resumeParentFromChild(db, childId)).resolves.toBeUndefined()
    expect(stub.resumes).toHaveLength(0)
  })
})
