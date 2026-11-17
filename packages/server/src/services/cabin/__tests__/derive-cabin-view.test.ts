import { describe, it, expect } from "vitest"
import { deriveCabinView, type DeriveCabinInput } from "../derive-cabin-view"

const base = (over: Partial<DeriveCabinInput> = {}): DeriveCabinInput => ({
  cabin: { id: "c1", status: "active" },
  tasks: [], executions: [], incidents: [], asks: [], findings: [], jobs: [],
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
        { id: "t1", name: "A", status: "awaiting_review" },
        { id: "t2", name: "B", status: "awaiting_archive" },
        { id: "t3", name: "C", status: "failed" },
        { id: "t4", name: "D", status: "running" },
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

  it("ask envelope is passed through on answer items (design 26)", () => {
    const envelope = {
      ask_id: "ask-1",
      message_id: "mirror-1",
      author_session_id: "s-author",
      decision: "接哪个渠道",
      options: [{ label: "支付宝", impact: "3 天" }],
      questions: { questions: [{ question: "q?" }] },
    }
    const v = deriveCabinView(base({
      asks: [
        { id: "ask-1", task_id: null, title: "ask", question: "q?", ask: envelope },
        { id: "ask-2", task_id: null, title: "plain" },
      ],
    }))
    const withAsk = v.attention.find(a => a.id === "ask-ask-1")
    const plain = v.attention.find(a => a.id === "ask-ask-2")
    expect(withAsk?.ask).toEqual(envelope)
    expect(plain?.ask).toBeUndefined()
  })

  it("sorts person-first，组内保持输入顺序", () => {
    const v = deriveCabinView(base({
      tasks: [
        { id: "t1", name: "first", status: "awaiting_review" },
        { id: "t2", name: "second", status: "awaiting_review" },
      ],
      executions: [{ id: "e1", task_id: "tx", status: "running" }],
    }))
    expect(v.attention.map(a => a.task_id)).toEqual(["t1", "t2"])
  })

  it("health counts running/queued and dormant flag", () => {
    const v = deriveCabinView(base({
      cabin: { id: "c1", status: "dormant" },
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