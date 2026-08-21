// packages/engine/src/__tests__/task-dispatch.test.ts
//
// Unit tests for TaskDispatchExecutor (ticket 02 / G1 pause-resume).
// The TaskDispatchPort is mocked — the real server impl is ticket 03.

import { describe, it, expect, vi } from "vitest"
import { VarPool } from "@octopus/shared"
import type { NodeDef, TaskDispatchPort, ScheduleHandle, SubunitSpec } from "@octopus/shared"
import { TaskDispatchExecutor } from "../executors/task-dispatch"

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

function makePort(handle: ScheduleHandle, spy?: ReturnType<typeof vi.fn>): TaskDispatchPort {
  return {
    dispatchChildSchedule: spy ?? vi.fn().mockResolvedValue(handle),
    resumeOnCompletion: vi.fn().mockResolvedValue(undefined),
  }
}

describe("TaskDispatchExecutor", () => {
  // ── AC: execute 调 port.dispatchChildSchedule + pause（不 throw、不阻塞 loop）──
  it("dispatches a child schedule and returns pending_task_dispatch on first call", async () => {
    const subunit = makeSubunit()
    const pool = new VarPool()
    pool.set("current_subunit", subunit)

    const handle: ScheduleHandle = { schedule_id: "sch-123", workspace_id: "ws-123" }
    const dispatchSpy = vi.fn().mockResolvedValue(handle)
    const port = makePort(handle, dispatchSpy)

    const node: NodeDef = {
      id: "dispatch-1",
      type: "task_dispatch",
      subunit: "$vars.current_subunit",
      await: true,
    }

    const executor = new TaskDispatchExecutor(node, pool, { port })
    const result = await executor.execute()

    // Dispatched the resolved subunit (object, not the ref string)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy).toHaveBeenCalledWith(subunit)

    // Paused (not completed, not failed, did not throw)
    expect(result.status).toBe("pending_task_dispatch")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // Metadata carries the schedule handle for the server's resume correlation
    expect(result.taskDispatchMetadata).toBeDefined()
    expect(result.taskDispatchMetadata?.nodeId).toBe("dispatch-1")
    expect(result.taskDispatchMetadata?.scheduleHandle.schedule_id).toBe("sch-123")
    expect(result.taskDispatchMetadata?.scheduleHandle.workspace_id).toBe("ws-123")
    expect(result.taskDispatchMetadata?.subunitName).toBe("E2E_TP_subunit_a")
  })

  it("resolves $iteration.subunit from loopContext", async () => {
    const subunit = makeSubunit({ name: "E2E_TP_iter_sub" })
    const pool = new VarPool()
    const handle: ScheduleHandle = { schedule_id: "sch-iter" }
    const dispatchSpy = vi.fn().mockResolvedValue(handle)
    const port = makePort(handle, dispatchSpy)

    const node: NodeDef = {
      id: "dispatch-iter",
      type: "task_dispatch",
      subunit: "$iteration.subunit",
      await: true,
    }

    const executor = new TaskDispatchExecutor(node, pool, {
      port,
      loopContext: { iteration: 1, subunit },
    })
    const result = await executor.execute()

    expect(dispatchSpy).toHaveBeenCalledWith(subunit)
    expect(result.status).toBe("pending_task_dispatch")
  })

  it("fails when no TaskDispatchPort is injected", async () => {
    const pool = new VarPool()
    pool.set("current_subunit", makeSubunit())
    const node: NodeDef = {
      id: "dispatch-no-port",
      type: "task_dispatch",
      subunit: "$vars.current_subunit",
      await: true,
    }
    const executor = new TaskDispatchExecutor(node, pool, {})
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/TaskDispatchPort/i)
  })

  it("fails when the subunit reference cannot be resolved", async () => {
    const pool = new VarPool() // no current_subunit set
    const port = makePort({ schedule_id: "sch-x" })
    const node: NodeDef = {
      id: "dispatch-bad-ref",
      type: "task_dispatch",
      subunit: "$vars.missing_subunit",
      await: true,
    }
    const executor = new TaskDispatchExecutor(node, pool, { port })
    const result = await executor.execute()

    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/missing_subunit|subunit/i)
    expect(port.dispatchChildSchedule).not.toHaveBeenCalled()
  })

  // ── AC: await=false → fire-and-forget (no pause) ──
  it("completes immediately without pausing when await is false", async () => {
    const subunit = makeSubunit()
    const pool = new VarPool()
    pool.set("current_subunit", subunit)
    const handle: ScheduleHandle = { schedule_id: "sch-fire" }
    const dispatchSpy = vi.fn().mockResolvedValue(handle)
    const port = makePort(handle, dispatchSpy)

    const node: NodeDef = {
      id: "dispatch-fire",
      type: "task_dispatch",
      subunit: "$vars.current_subunit",
      await: false,
    }
    const executor = new TaskDispatchExecutor(node, pool, { port })
    const result = await executor.execute()

    expect(dispatchSpy).toHaveBeenCalledWith(subunit)
    expect(result.status).toBe("completed")
    expect(result.outputs.schedule_id).toBe("sch-fire")
    // Did not expose pause metadata
    expect(result.taskDispatchMetadata).toBeUndefined()
  })

  // ── AC: resume 回调 applyOutputsMapping 写 nodeResults（下游可读 $taskDispatchId.output.key）──
  it("on resume applies output_mapping to pool AND node outputs (downstream $<id>.output.<key>)", async () => {
    const pool = new VarPool()
    const node: NodeDef = {
      id: "dispatch-resume",
      type: "task_dispatch",
      subunit: "$vars.current_subunit",
      output_mapping: {
        synthesis: "result",
        child_meta: "metadata",
      },
      await: true,
    }

    const childOutput = {
      result: "E2E_TP_synthesis_body",
      metadata: { tokens: 42 },
      unrelated: "ignored",
    }

    // Resume: childOutput provided → no dispatch, just mapping + complete
    const dispatchSpy = vi.fn().mockResolvedValue({ schedule_id: "should-not-fire" })
    const port = makePort({ schedule_id: "should-not-fire" }, dispatchSpy)

    const executor = new TaskDispatchExecutor(node, pool, {
      port,
      childOutput,
    })
    const result = await executor.execute()

    // Did NOT re-dispatch on resume
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(result.status).toBe("completed")

    // Pool got the mapped values (sub-workflow precedent)
    expect(pool.get("synthesis")).toBe("E2E_TP_synthesis_body")
    expect(pool.get("child_meta")).toEqual({ tokens: 42 })

    // Node outputs got the mapped values → downstream $dispatch-resume.output.synthesis resolves
    expect(result.outputs.synthesis).toBe("E2E_TP_synthesis_body")
    expect(result.outputs.child_meta).toEqual({ tokens: 42 })

    // lastOutput is derived from the child output
    expect(result.lastOutput).toBe("E2E_TP_synthesis_body")
  })

  it("on resume logs missing child keys without failing", async () => {
    const pool = new VarPool()
    const node: NodeDef = {
      id: "dispatch-missing",
      type: "task_dispatch",
      subunit: "$vars.current_subunit",
      output_mapping: { wanted: "absent_key" },
      await: true,
    }
    const executor = new TaskDispatchExecutor(node, pool, {
      port: makePort({ schedule_id: "sch" }),
      childOutput: { present: "yes" },
    })
    const result = await executor.execute()

    expect(result.status).toBe("completed")
    expect(pool.get("wanted")).toBeUndefined()
    expect(result.logLines.some((l) => l.includes("absent_key") && l.includes("not found"))).toBe(true)
  })

  // ── Integration-flavored: first-call pause → second-call resume (executor-level) ──
  it("first call pauses, second call (with childOutput) resumes and writes outputs", async () => {
    const subunit = makeSubunit()
    const pool = new VarPool()
    pool.set("current_subunit", subunit)

    const handle: ScheduleHandle = { schedule_id: "sch-roundtrip" }
    const port = makePort(handle)

    const node: NodeDef = {
      id: "dispatch-rt",
      type: "task_dispatch",
      subunit: "$vars.current_subunit",
      output_mapping: { answer: "final_result" },
      await: true,
    }

    // First execution: pause
    const first = new TaskDispatchExecutor(node, pool, { port })
    const firstResult = await first.execute()
    expect(firstResult.status).toBe("pending_task_dispatch")
    expect(firstResult.taskDispatchMetadata?.scheduleHandle.schedule_id).toBe("sch-roundtrip")

    // Server completes the child → re-invokes engine → factory builds a NEW executor with childOutput
    const second = new TaskDispatchExecutor(node, pool, {
      port,
      childOutput: { final_result: "E2E_TP_done_answer" },
    })
    const secondResult = await second.execute()

    expect(secondResult.status).toBe("completed")
    expect(secondResult.outputs.answer).toBe("E2E_TP_done_answer")
    expect(pool.get("answer")).toBe("E2E_TP_done_answer")
  })

  it("respects AbortSignal on first call", async () => {
    const pool = new VarPool()
    pool.set("current_subunit", makeSubunit())
    const ac = new AbortController()
    ac.abort()
    const executor = new TaskDispatchExecutor(
      {
        id: "dispatch-abort",
        type: "task_dispatch",
        subunit: "$vars.current_subunit",
        await: true,
      },
      pool,
      { port: makePort({ schedule_id: "sch" }), signal: ac.signal },
    )
    const result = await executor.execute()
    expect(result.status).toBe("cancelled")
  })
})
