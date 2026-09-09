// packages/server/src/__tests__/06-schedules-origin-materialize.test.ts
//
// Ticket 06 — SG5 materialize + SG9 isComposite N>=2 (the surviving half).
//
// 票03 (ADR-0021) deleted the origin half of this file's scope, not just its fixtures:
//   AC1 (checkQueuedTasks claims an origin_type='task' schedule) — the whole claim loop
//       is gone; a task is armed as an `executions` row by the built-in lifecycle job.
//   AC2 (failed-promotion gate on origin_type='task') — the promotion existed because an
//       envelope could be re-claimed regardless of `enabled`; with no queue there is no
//       loop to cap (see scheduler-engine.onExecutionComplete's comment).
//   AC3 (dispatchChildSchedule writes origin_role='subunit') — children are child
//       executions now (task-child-run.dispatchChildRun), pinned in the task domain.
//   AC6 (orphan reaper + deleteTask cascade) — orphan-reaper.ts is a deleted file; the
//       equivalent backstop is the job's reconcile pass over executions.
// What remains here is the materializer's output contract, which MOVED VERBATIM into the
// task domain: `services/tasks/task-materialize.ts` → buildTaskLaunchConfig. Same shapes,
// asserted byte-for-byte as before, because workspace scaffolding and the composition
// workflow consume them unchanged.
//
// Anti-fake-run: the surviving ACs are pure-function assertions on the produced config
// (R4), data prefix E2E_TD_ (R7); the one DB-touching case is the barrel import below.

import { describe, it, expect } from "vitest"
import { buildTaskLaunchConfig, isCompositeTaskSpec } from "../services/tasks/task-materialize"
import { TaskDispatchService } from "../services/scheduler"
import { taskSpecSchema, type TaskSpec } from "@octopus/shared"
import type { ScheduleRow } from "../db/types"

const ORG = "e2e-td-06"

// ── AC7: 票03 data-shape pin (type-level) ──────────────────────────────────────
// The five polymorphic-origin columns are dropped in schema v42; `status`/`claimed_at`
// deliberately stay (the pump's own run-state). Compiled-away, but if a column comes back
// on the row type this file stops building — which is the point.
type AssertScheduleRowV42Shape =
  "origin_type" extends keyof ScheduleRow ? never :
  "origin_id" extends keyof ScheduleRow ? never :
  "origin_role" extends keyof ScheduleRow ? never :
  "assoc_meta" extends keyof ScheduleRow ? never :
  "scheduled_at" extends keyof ScheduleRow ? never :
  "status" extends keyof ScheduleRow ?
    ("claimed_at" extends keyof ScheduleRow ? true : never) : never
const _ac7TypeCheck: AssertScheduleRowV42Shape = true
void _ac7TypeCheck

function compositeSpec(): TaskSpec {
  return taskSpecSchema.parse({
    goal: "E2E_TD goal",
    ac: ["ac1"],
    subunits: [
      {
        name: "E2E_TD_sub_a",
        workspace_spec: { org: ORG, branch_prefix: "e2e-td-a", projects: [{ name: "p", source_path: "", group: "" }] },
        workflow_ref: "e2e-td-06/wf-a",
        input_values: {},
        skills: [],
      },
      {
        name: "E2E_TD_sub_b",
        workspace_spec: { org: ORG, branch_prefix: "e2e-td-b", projects: [{ name: "p", source_path: "", group: "" }] },
        workflow_ref: "e2e-td-06/wf-b",
        input_values: {},
        skills: [],
      },
    ],
    integration_goal: { strategy: "synthesis", prompt: "E2E_TD_synth" },
  })
}

describe("06/SG5: task_spec → launch-plan materialization", () => {
  // ── AC4: materialize output has NO task_spec; composite injects subunit_count ──
  it("AC4/SG5: materialized config has NO task_spec; composite injects input_values.subunit_count", () => {
    const config = buildTaskLaunchConfig(compositeSpec(), ["E2E_TD_proj"], ORG, undefined, [])
    // AC4: NO task_spec in the materialized config (lives in the tasks table, never in a
    // plan — the plan is the runtime shape only)
    expect((config as { task_spec?: unknown }).task_spec).toBeUndefined()
    // AC4: composite injects input_values.subunit_count into workflow_chain[0] so the
    // composition-task Loop break_when can read it without re-parsing task_spec
    expect(config.workflow_chain[0].input_values.subunit_count).toBe(2)
    expect(config.workflow_chain[0].workflow_ref).toBe("composition-task")
  })

  // ── AC4/SG9: isComposite threshold is N>=2 (1-subunit → simple) ──
  it("AC4/SG9: 1 subunit is NOT composite (>=2 required) — chain uses the bound workflow_ref", () => {
    // The materialize path uses a simple workflow_chain when subunits.length < 2.
    const simpleSpec: TaskSpec = taskSpecSchema.parse({
      goal: "g", ac: ["a"],
      subunits: [
        {
          name: "only-one",
          workspace_spec: { org: ORG, branch_prefix: "e2e-td-one", projects: [{ name: "p", source_path: "", group: "" }] },
          workflow_ref: "e2e-td-06/only",
          input_values: {}, skills: [],
        },
      ],
    })
    expect(isCompositeTaskSpec(simpleSpec)).toBe(false)
    const config = buildTaskLaunchConfig(simpleSpec, ["E2E_TD_proj"], ORG, "e2e-td-06/simple", [])
    // 1-subunit → simple: workflow_chain[0].workflow_ref is the provided workflow_ref,
    // NOT 'composition-task'. And no subunit_count injected (simple path).
    expect(config.workflow_chain[0].workflow_ref).toBe("e2e-td-06/simple")
    expect((config.workflow_chain[0].input_values as { subunit_count?: unknown }).subunit_count).toBeUndefined()
    expect((config as { task_spec?: unknown }).task_spec).toBeUndefined()
  })

  it("AC4: workspace_spec carries a taskpool-{org} branch prefix + the project ids (预建/认领同名前提)", () => {
    const config = buildTaskLaunchConfig(compositeSpec(), ["E2E_TD_proj_a", "E2E_TD_proj_b"], ORG, undefined, [])
    expect(config.workspace_spec.branch_prefix).toBe(`taskpool-${ORG}`)
    expect(config.workspace_spec.projects.map((p) => p.name)).toEqual(["E2E_TD_proj_a", "E2E_TD_proj_b"])
    // 非字母数字被剥（workspaceSpecSchema 的 /^[a-zA-Z0-9_-]+$/ 约束）
    const odd = buildTaskLaunchConfig(compositeSpec(), [], "e2e/td 06", undefined, [])
    expect(odd.workspace_spec.branch_prefix).toBe("taskpool-e2e-td-06")
    // 无 project → 一个 default 占位（createFromSpec 的 projects 至少 1 项）
    expect(odd.workspace_spec.projects).toEqual([{ name: "default", source_path: "", group: "" }])
  })
})

// ── AC5/SG16: scheduler barrel re-export ───────────────────────────────────────
describe("06/SG16: scheduler barrel surface", () => {
  it("TaskDispatchService is re-exported from services/scheduler", async () => {
    // 产品 bug（票03 未清扫）: services/scheduler/index.ts:22 仍 `export { reapOrphanSchedules }
    // from './orphan-reaper'`，而该文件已随票03 删除 → 整个 barrel 无法被 import。
    // 动态 import 只炸这一条用例，不让它带走上面的物化断言。
    const mod = await import("../services/scheduler")
    expect(typeof mod.TaskDispatchService).toBe("function")
  })
})
