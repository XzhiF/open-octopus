import { describe, it, expect } from "vitest"
import { deriveCabinView, type DeriveCabinInput } from "../derive-cabin-view"

const base = (over: Partial<DeriveCabinInput> = {}): DeriveCabinInput => ({
  cabin: { id: "c1", status: "active", focused_job_id: null },
  tasks: [], executions: [], incidents: [], asks: [], findings: [], jobs: [], iterations: [],
  maxWorkers: 4,
  ...over,
})

describe("deriveCabinView", () => {
  it("empty cabin => no attention, idle health", () => {
    const v = deriveCabinView(base())
    expect(v.attention).toEqual([])
    expect(v.health.running).toBe(0)
    expect(v.open_findings).toBe(0)
  })

  it("maps sources to stages with awaiting=person", () => {
    const v = deriveCabinView(base({
      tasks: [
        { id: "t1", name: "A", status: "awaiting_review", iteration_id: null },
        { id: "t2", name: "B", status: "awaiting_archive", iteration_id: null },
        { id: "t3", name: "C", status: "failed", iteration_id: null },
        { id: "t4", name: "D", status: "running", iteration_id: null },
      ],
      executions: [{ id: "e1", task_id: "t4", status: "pending_approval" }],
      incidents: [{ id: "i1", task_id: null, status: "waiting_human", title: "inc" }],
      asks: [{ id: "a1", task_id: null, title: "ask", question: "q?" }],
      findings: [{ id: "f1", title: "find", status: "open" }],
    }))
    const stages = v.attention.map(a => a.stage).sort()
    expect(stages).toEqual(["adjudicate", "answer", "approval", "blocked", "blocked", "review", "review"])
    expect(v.attention.every(a => a.awaiting === "person")).toBe(true)
    expect(v.open_findings).toBe(1)
    // running task without approval contributes no attention
    expect(v.attention.some(a => a.task_id === "t4" && a.stage === "review")).toBe(false)
  })

  it("sorts person-first then priority desc", () => {
    const v = deriveCabinView(base({
      tasks: [
        { id: "t1", name: "low", status: "awaiting_review", iteration_id: null },
        { id: "t2", name: "high", status: "awaiting_review", iteration_id: null },
      ],
      jobs: [
        { id: "j1", kind: "task", ref_id: "t1", title: "low", priority: 1 },
        { id: "j2", kind: "task", ref_id: "t2", title: "high", priority: 5 },
      ],
    }))
    expect(v.attention[0].task_id).toBe("t2")
    expect(v.attention[0].priority).toBe(5)
    expect(v.attention[1].task_id).toBe("t1")
  })

  it("derives iteration progress + membership from tasks.iteration_id", () => {
    const v = deriveCabinView(base({
      iterations: [{ id: "i1", code: "M1", name: "m", sort_order: 0, status: "active" }],
      tasks: [
        { id: "t1", name: "a", status: "done", iteration_id: "i1" },
        { id: "t2", name: "b", status: "running", iteration_id: "i1" },
        { id: "t3", name: "c", status: "done", iteration_id: null },
      ],
    }))
    expect(v.iterations[0].task_count).toBe(2)
    expect(v.iterations[0].progress).toBe(50)
  })

  it("health counts running/queued and dormant flag", () => {
    const v = deriveCabinView(base({
      cabin: { id: "c1", status: "dormant", focused_job_id: null },
      executions: [
        { id: "e1", task_id: null, status: "running" },
        { id: "e2", task_id: null, status: "pending" },
      ],
    }))
    expect(v.health.running).toBe(1)
    expect(v.health.queued).toBe(1)
    expect(v.health.dormant).toBe(1)
    expect(v.health.max).toBe(4)
  })
})