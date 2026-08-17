// packages/engine/src/__tests__/loop-task-dispatch.test.ts
//
// End-to-end engine test for the 02/03 leftover gap: a composition-style
// workflow = Loop over subunits, where each iteration runs a `task_dispatch`
// inner node (await: true, pause-resume). Before the fix, LoopExecutor.
// createExecutor threw "Unknown node type: task_dispatch" and loopContext.
// subunit was never populated, so composition-task.yaml could not run.
//
// The TaskDispatchPort is stubbed (real server impl = ticket 03). Bash nodes
// run for real (anti-fake-run R1: deterministic edges are not mocked).
//
// Seam under test: the public WorkflowEngine surface (run + retryFrom) — the
// same seam the server's ExecutionLifecycle.resumeTaskDispatch drives in
// production (it calls engine.retryFrom(innerTaskDispatchNodeId,
// { taskDispatchChildOutput }), per task-dispatch-service.ts resume contract).

import { describe, it, expect, vi } from "vitest"
import { WorkflowEngine } from "../engine"
import { VarPool } from "@octopus/shared"
import type { WorkflowDef, NodeDef, TaskDispatchPort, ScheduleHandle, SubunitSpec } from "@octopus/shared"

const SUBPROCESS_TIMEOUT = 20000

function makeSubunit(name: string, overrides: Partial<SubunitSpec> = {}): SubunitSpec {
  return {
    name,
    workspace_spec: {
      org: "E2E_TP_org",
      branch_prefix: `e2e-tp-${name}`,
      projects: [{ name: "E2E_TP_project", source_path: "", group: "" }],
    },
    workflow_ref: "e2e-tp/simple-spec-workflow",
    input_values: {},
    skills: [],
    ...overrides,
  }
}

/**
 * Stub port: each dispatch resolves with a distinct handle (so the resume
 * correlation metadata is distinguishable per subunit). resumeOnCompletion
 * is a spy — the engine's pause-resume does not depend on it (the server
 * drives resume via retryFrom, not via this method in-process).
 */
function makePort(): TaskDispatchPort {
  let n = 0
  return {
    dispatchChildSchedule: vi.fn().mockImplementation((_subunit: SubunitSpec) => {
      n += 1
      return Promise.resolve({
        schedule_id: `sch-child-${n}`,
        workspace_id: `ws-child-${n}`,
      } as ScheduleHandle)
    }),
    resumeOnCompletion: vi.fn().mockResolvedValue(undefined),
  }
}

/**
 * Composition-style workflow (mirrors core-pack/composition-task.yaml shape):
 *   loop-subunits (Loop, break_when '$iteration >= $vars.subunit_count')
 *     └─ dispatch-child (task_dispatch, subunit "$iteration.subunit", await,
 *        output_mapping { result: "last_output" })
 *   aggregate (bash, reads $vars.result — proves output_mapping wrote to pool)
 *
 * subunits[] + subunit_count live in workflow.variables → VarPool (same place
 * the server's input_values land via pool.update). break_when is pool-read
 * ($vars.subunit_count), so subunits is read from the pool for consistency.
 */
function compositionWorkflow(subunits: SubunitSpec[]): WorkflowDef {
  const nodes: NodeDef[] = [
    {
      id: "loop-subunits",
      type: "loop",
      max_iterations: 20,
      break_when: "$iteration >= $vars.subunit_count",
      nodes: [
        {
          id: "dispatch-child",
          type: "task_dispatch",
          subunit: "$iteration.subunit",
          await: true,
          output_mapping: { result: "last_output" },
        },
      ],
    },
    {
      id: "aggregate",
      type: "bash",
      bash: "echo result=$vars.result",
      depends_on: ["loop-subunits"],
    },
  ]
  return {
    apiVersion: "octopus/v1",
    kind: "Workflow",
    name: "loop-task-dispatch-test",
    execution_mode: "serial",
    budget: {} as any,
    variables: {
      subunits,
      subunit_count: subunits.length,
      goal: "E2E_TP_goal",
    },
    nodes,
  }
}

/**
 * Drive the full pause-resume cycle for N subunits:
 *   run() → pending_task_dispatch (subunit[0])
 *   retryFrom("dispatch-child", { childOutput }) → … → pending_task_dispatch (subunit[i+1])
 *   … until the loop breaks and the aggregate runs → completed.
 * Returns every ExecutionResult so the test can assert per-step.
 */
async function runFullCycle(engine: WorkflowEngine, childOutputs: { last_output: string }[]) {
  const results = []
  // First dispatch pauses on subunit[0]
  let res = await engine.run()
  results.push(res)

  for (let i = 0; i < childOutputs.length; i++) {
    expect(res.status).toBe("pending_task_dispatch")
    res = await engine.retryFrom("dispatch-child", {
      taskDispatchChildOutput: childOutputs[i],
    })
    results.push(res)
  }
  return results
}

describe("WorkflowEngine loop + task_dispatch end-to-end (02/03 gap)", () => {
  it("iterates over subunits, dispatching one subunit per iteration via the port", async () => {
    const subunits = [
      makeSubunit("E2E_TP_sub_a"),
      makeSubunit("E2E_TP_sub_b"),
      makeSubunit("E2E_TP_sub_c"),
    ]
    const wf = compositionWorkflow(subunits)
    const port = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    const childOutputs = [
      { last_output: "E2E_TP_out_a" },
      { last_output: "E2E_TP_out_b" },
      { last_output: "E2E_TP_out_c" },
    ]
    const results = await runFullCycle(engine, childOutputs)
    const final = results[results.length - 1]

    // Loop iterated exactly once per subunit (3 dispatches, no more)
    expect(port.dispatchChildSchedule).toHaveBeenCalledTimes(3)
    // Each subunit dispatched in order (object identity preserved — not stringified)
    expect(port.dispatchChildSchedule).toHaveBeenNthCalledWith(1, subunits[0])
    expect(port.dispatchChildSchedule).toHaveBeenNthCalledWith(2, subunits[1])
    expect(port.dispatchChildSchedule).toHaveBeenNthCalledWith(3, subunits[2])

    // Workflow completed (loop broke at $iteration >= 3, aggregate ran)
    expect(final.status).toBe("completed")
    expect(final.nodeResults["aggregate"].status).toBe("completed")
  }, SUBPROCESS_TIMEOUT)

  it("pause-resume: each iteration pauses pending_task_dispatch and resumes via retryFrom", async () => {
    const subunits = [makeSubunit("E2E_TP_p1"), makeSubunit("E2E_TP_p2")]
    const wf = compositionWorkflow(subunits)
    const port = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    // ── Iteration 1: dispatch subunits[0] → pause ──
    const first = await engine.run()
    expect(first.status).toBe("pending_task_dispatch")
    expect(first.nodeResults["loop-subunits"].status).toBe("pending_task_dispatch")
    const meta1 = first.nodeResults["loop-subunits"].taskDispatchMetadata
    expect(meta1?.nodeId).toBe("dispatch-child")
    expect(meta1?.scheduleHandle.schedule_id).toBe("sch-child-1")
    // Aggregate not reached yet (loop paused)
    expect(first.nodeResults["aggregate"]).toBeUndefined()

    // ── Resume 1: subunits[0] completes → iteration 2 dispatches subunits[1] → pause ──
    const second = await engine.retryFrom("dispatch-child", {
      taskDispatchChildOutput: { last_output: "E2E_TP_p1_out" },
    })
    expect(second.status).toBe("pending_task_dispatch")
    expect(second.nodeResults["loop-subunits"].taskDispatchMetadata?.scheduleHandle.schedule_id).toBe("sch-child-2")

    // ── Resume 2: subunits[1] completes → break_when ($iteration>=2) → loop done → aggregate ──
    const third = await engine.retryFrom("dispatch-child", {
      taskDispatchChildOutput: { last_output: "E2E_TP_p2_out" },
    })
    expect(third.status).toBe("completed")
    expect(third.nodeResults["loop-subunits"].status).toBe("completed")
    expect(third.nodeResults["aggregate"].status).toBe("completed")

    // Two subunits → exactly two dispatches
    expect(port.dispatchChildSchedule).toHaveBeenCalledTimes(2)
  }, SUBPROCESS_TIMEOUT)

  it("does not re-dispatch on resume (one child schedule per subunit)", async () => {
    const subunits = [makeSubunit("E2E_TP_n1"), makeSubunit("E2E_TP_n2"), makeSubunit("E2E_TP_n3")]
    const wf = compositionWorkflow(subunits)
    const port = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    await runFullCycle(engine, [
      { last_output: "E2E_TP_n1_out" },
      { last_output: "E2E_TP_n2_out" },
      { last_output: "E2E_TP_n3_out" },
    ])

    // 3 subunits, 3 resumes → still only 3 dispatches (resume must NOT re-dispatch)
    expect(port.dispatchChildSchedule).toHaveBeenCalledTimes(3)
  }, SUBPROCESS_TIMEOUT)

  it("output_mapping writes each child output to $vars.result; aggregate sees the last", async () => {
    const subunits = [makeSubunit("E2E_TP_m1"), makeSubunit("E2E_TP_m2")]
    const wf = compositionWorkflow(subunits)
    const port = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    const final = (
      await runFullCycle(engine, [
        { last_output: "E2E_TP_m1_out" },
        { last_output: "E2E_TP_m2_out" },
      ])
    ).pop()!

    expect(final.status).toBe("completed")
    // Last subunit's output wins ($vars.result overwritten each iteration)
    expect(final.poolSnapshot.result).toBe("E2E_TP_m2_out")
    // Aggregate bash ran with the substituted $vars.result
    expect(final.nodeResults["aggregate"].outputs.last_output).toContain("E2E_TP_m2_out")
  }, SUBPROCESS_TIMEOUT)

  it("handles a single subunit (loop runs once then breaks)", async () => {
    const subunits = [makeSubunit("E2E_TP_single")]
    const wf = compositionWorkflow(subunits)
    const port = makePort()

    const engine = new WorkflowEngine(wf, {}, process.cwd())
    engine.setTaskDispatchPort(port)

    const first = await engine.run()
    expect(first.status).toBe("pending_task_dispatch")

    const final = await engine.retryFrom("dispatch-child", {
      taskDispatchChildOutput: { last_output: "E2E_TP_single_out" },
    })
    expect(final.status).toBe("completed")
    expect(port.dispatchChildSchedule).toHaveBeenCalledTimes(1)
    expect(final.poolSnapshot.result).toBe("E2E_TP_single_out")
  }, SUBPROCESS_TIMEOUT)
})
