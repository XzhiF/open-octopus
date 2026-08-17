// packages/engine/src/__tests__/task-dispatch-bridge.test.ts
//
// Integration test for the G1 pause-resume bridge (ticket 03):
// engine recognizes `pending_task_dispatch` as a pause state, and
// retryFrom({ taskDispatchChildOutput }) resumes the parent composition
// workflow so the downstream aggregation node receives $<id>.output.<key>.
//
// The TaskDispatchPort is stubbed (the real server impl is ticket 03's
// task-dispatch-service.ts, tested separately). Bash nodes run for real
// (anti-fake-run R1: no mocking the deterministic edges).

import { describe, it, expect, vi } from "vitest"
import { WorkflowEngine } from "../engine"
import { VarPool } from "@octopus/shared"
import type { WorkflowDef, NodeDef, TaskDispatchPort, ScheduleHandle, SubunitSpec } from "@octopus/shared"

const SUBPROCESS_TIMEOUT = 20000

function makeSubunit(overrides: Partial<SubunitSpec> = {}): SubunitSpec {
  return {
    name: "E2E_TP_subunit_a",
    workspace_spec: {
      org: "E2E_TP_org",
      branch_prefix: "e2e-tp-sub-a",
      projects: [{ name: "E2E_TP_project", source_path: "", group: "" }],
    },
    workflow_ref: "e2e-tp/simple-spec-workflow",
    input_values: {},
    skills: [],
    ...overrides,
  }
}

/** Stub port: dispatch resolves immediately with a fixed handle; resume is a spy. */
function makePort(handle: ScheduleHandle): TaskDispatchPort {
  return {
    dispatchChildSchedule: vi.fn().mockResolvedValue(handle),
    resumeOnCompletion: vi.fn().mockResolvedValue(undefined),
  }
}

/** Composition workflow: setup → task_dispatch (await) → aggregate reads $dispatch.output.synthesis.
 *  The task_dispatch node carries a literal-JSON subunit (resolveSubunit fallback path),
 *  so the test does not depend on a loop setting $iteration.subunit. */
function compositionWorkflow(subunitJson: string): WorkflowDef {
  const nodes: NodeDef[] = [
    { id: "setup", type: "bash", bash: "echo E2E_TP_setup_done" },
    {
      id: "dispatch",
      type: "task_dispatch",
      subunit: subunitJson,
      await: true,
      output_mapping: { synthesis: "result" },
      depends_on: ["setup"],
    },
    { id: "aggregate", type: "bash", bash: "echo aggregated=$dispatch.output.synthesis", depends_on: ["dispatch"] },
  ]
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: "composition-bridge-test",
    execution_mode: "serial",
    budget: {} as any,
    nodes,
  }
}

const SUBUNIT_JSON = JSON.stringify(makeSubunit())

describe("WorkflowEngine task_dispatch pause-resume bridge (G1)", () => {
  it("pauses with pending_task_dispatch and resumes via retryFrom({ taskDispatchChildOutput })", async () => {
    const wf = compositionWorkflow(SUBUNIT_JSON)
    const handle: ScheduleHandle = { schedule_id: "sch-child-1", workspace_id: "ws-child-1" }
    const port = makePort(handle)

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    // ── First run: setup completes, dispatch pauses, aggregate is NOT reached ──
    const first = await engine.run()

    expect(first.status).toBe("pending_task_dispatch")
    expect(first.nodeResults["setup"].status).toBe("completed")
    expect(first.nodeResults["dispatch"].status).toBe("pending_task_dispatch")
    expect(first.nodeResults["dispatch"].taskDispatchMetadata).toBeDefined()
    expect(first.nodeResults["dispatch"].taskDispatchMetadata?.nodeId).toBe("dispatch")
    expect(first.nodeResults["dispatch"].taskDispatchMetadata?.scheduleHandle.schedule_id).toBe("sch-child-1")
    // Aggregate was not executed (dispatch paused first)
    expect(first.nodeResults["aggregate"]).toBeUndefined()

    // Port was dispatched exactly once with the resolved subunit
    expect(port.dispatchChildSchedule).toHaveBeenCalledTimes(1)

    // ── Resume: child schedule completed → engine.retryFrom with child output ──
    const childOutput = { result: "E2E_TP_synthesis_body" }
    const resumed = await engine.retryFrom("dispatch", { taskDispatchChildOutput: childOutput })

    expect(resumed.status).toBe("completed")
    expect(resumed.nodeResults["dispatch"].status).toBe("completed")
    // output_mapping wrote synthesis into the dispatch node's outputs
    expect(resumed.nodeResults["dispatch"].outputs.synthesis).toBe("E2E_TP_synthesis_body")
    // Downstream aggregation node ran and received $dispatch.output.synthesis
    expect(resumed.nodeResults["aggregate"].status).toBe("completed")
    expect(resumed.nodeResults["aggregate"].outputs.last_output).toContain("E2E_TP_synthesis_body")
  }, SUBPROCESS_TIMEOUT)

  it("recovers after a simulated process restart (new engine from snapshot resumes)", async () => {
    const wf = compositionWorkflow(SUBUNIT_JSON)
    const handle: ScheduleHandle = { schedule_id: "sch-child-2" }
    const port = makePort(handle)

    // ── First "process": run to the pause point, then capture the persisted snapshot ──
    const engineA = new WorkflowEngine(wf, {}, process.cwd())
    engineA.setTaskDispatchPort(port)
    const first = await engineA.run()
    expect(first.status).toBe("pending_task_dispatch")
    const poolSnapshot = first.poolSnapshot

    // ── Simulate restart: a brand-new engine instance is reconstructed from the
    //     var_pool snapshot + completed node results (mirrors reconstructEngine).
    //     The paused task_dispatch node is NOT pre-seeded (it is re-run on resume). ──
    const engineB = new WorkflowEngine(wf, {}, process.cwd())
    engineB.updateVarPool(poolSnapshot)
    engineB.setTaskDispatchPort(port)
    // Restore the completed setup node so the topological sort doesn't re-run it
    engineB.setNodeResult("setup", first.nodeResults["setup"])

    const resumed = await engineB.retryFrom("dispatch", {
      taskDispatchChildOutput: { result: "E2E_TP_restarted_synth" },
    })

    expect(resumed.status).toBe("completed")
    expect(resumed.nodeResults["dispatch"].outputs.synthesis).toBe("E2E_TP_restarted_synth")
    expect(resumed.nodeResults["aggregate"].outputs.last_output).toContain("E2E_TP_restarted_synth")
  }, SUBPROCESS_TIMEOUT)

  it("does not re-dispatch on resume (port.dispatchChildSchedule called once total)", async () => {
    const wf = compositionWorkflow(SUBUNIT_JSON)
    const handle: ScheduleHandle = { schedule_id: "sch-child-3" }
    const port = makePort(handle)

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    await engine.run()
    await engine.retryFrom("dispatch", { taskDispatchChildOutput: { result: "E2E_TP_once" } })

    // Resume must NOT re-invoke dispatchChildSchedule (would leak a second child schedule)
    expect(port.dispatchChildSchedule).toHaveBeenCalledTimes(1)
  }, SUBPROCESS_TIMEOUT)
})
