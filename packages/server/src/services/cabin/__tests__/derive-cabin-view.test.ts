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

  // ── start（待放行）：所有「人给一脚才能动」的任务态 ──────────────────
  it("raw ready → 待触发；draft + 绑定齐 → 待入列；paused → 待恢复；半草稿不产", () => {
    const v = deriveCabinView(base({
      tasks: [
        { id: "t1", name: "已入列", status: "ready", rawStatus: "ready" },
        { id: "t2", name: "草稿就绪", status: "ready", rawStatus: "draft", enqueueReady: true },
        { id: "t3", name: "半草稿", status: "ready", rawStatus: "draft", enqueueReady: false },
        { id: "t4", name: "暂停中", status: "paused", rawStatus: "running" },
        { id: "t5", name: "中段 ready", status: "ready", rawStatus: "running" },
      ],
    }))
    const start = v.attention.filter(a => a.stage === "start")
    expect(start.map(a => a.title)).toEqual([
      "已入列 · 待触发",
      "草稿就绪 · 待入列",
      "暂停中 · 待恢复",
    ])
    expect(start.map(a => a.start_kind)).toEqual(["trigger", "enqueue", "resume"])
    expect(start.every(a => a.awaiting === "person" && a.deep_link === `task:${a.task_id}`)).toBe(true)
  })

  it("作者在跑 / 已有提问 / 已有受阻时不重复产 start", () => {
    const v = deriveCabinView(base({
      tasks: [
        { id: "t1", name: "A", status: "ready", rawStatus: "ready" },
        { id: "t2", name: "B", status: "ready", rawStatus: "ready" },
        { id: "t3", name: "C", status: "paused", rawStatus: "running" },
      ],
      jobs: [{ id: "j1", kind: "task", ref_id: "t1", title: "A", agent_running: true }],
      asks: [{ id: "a1", task_id: "t2", title: "ask" }],
      incidents: [{ id: "i1", task_id: "t3", status: "waiting_human", title: "inc" }],
    }))
    expect(v.attention.some(a => a.stage === "start")).toBe(false)
    expect(v.attention.some(a => a.stage === "answer")).toBe(true)
    expect(v.attention.some(a => a.stage === "blocked")).toBe(true)
  })

  // ── notice（完成回流，2026-11-19 用户 #9）──────────────────────────
  it("done 任务 → notice；acked 后收项；提问类不受 ack 影响", () => {
    const input = base({
      tasks: [{ id: "t1", name: "收口", status: "done" }],
      asks: [{ id: "a1", task_id: null, title: "ask", question: "q?" }],
    })
    let v = deriveCabinView(input)
    const notice = v.attention.find(a => a.id === "done-task-t1")
    expect(notice?.stage).toBe("notice")
    expect(notice?.awaiting).toBe("person")
    expect(notice?.deep_link).toBe("task:t1")

    v = deriveCabinView({ ...input, acked: ["done-task-t1"] })
    expect(v.attention.some(a => a.id === "done-task-t1")).toBe(false)
    // 只 ack 完成项时提问仍在；提问被 ack（「✓ 忽略」）后同样收项 —— v22 #9。
    expect(v.attention.some(a => a.id === "ask-a1")).toBe(true)
    const ackedAsk = deriveCabinView({ ...input, acked: ["done-task-t1", "ask-a1"] })
    expect(ackedAsk.attention.some(a => a.id === "ask-a1")).toBe(false)
  })

  it("done 委派 → notice（带结论摘要）；failed 仍是 blocked；acked 收项", () => {
    const v = deriveCabinView(base({
      delegations: [
        { id: "d1", title: "对比", state: "done", summary: "结论：选 B", handle: "D1" },
        { id: "d2", title: "失败", state: "failed" },
      ],
    }))
    const done = v.attention.find(a => a.id === "done-delegation-d1")
    expect(done?.stage).toBe("notice")
    expect(done?.title).toContain("对比")
    expect(done?.detail).toBe("结论：选 B")
    expect(done?.handle).toBe("D1")
    expect(v.attention.find(a => a.id === "delegation-failed-d2")?.stage).toBe("blocked")

    const acked = deriveCabinView(base({
      delegations: [{ id: "d1", title: "对比", state: "done", summary: "结论：选 B" }],
      acked: ["done-delegation-d1"],
    }))
    expect(acked.attention).toEqual([])
  })

  it("已归档委派：不再产任何 attention（完成回流 / 在问 / 失败都闭嘴）", () => {
    const v = deriveCabinView(base({
      delegations: [
        { id: "d1", title: "完成已归档", state: "done", summary: "结论", archived_at: "2026-11-25T02:00:00.000Z" },
        { id: "d2", title: "在问已归档", state: "waiting_input", archived_at: "2026-11-25T02:00:00.000Z" },
        { id: "d3", title: "失败已归档", state: "failed", archived_at: "2026-11-25T02:00:00.000Z" },
      ],
    }))
    expect(v.attention.filter(a => a.id.includes("delegation"))).toEqual([])
  })

  // ── 委派提问去重（v22 #9）────────────────────────────────────────
  it("委派在问：消息派生的 ask 已带 subject → 不再重复产 delegation-ask-* 行", () => {
    const v = deriveCabinView(base({
      delegations: [{ id: "d1", title: "对比", state: "waiting_input", handle: "D1" }],
      asks: [{
        id: "a9", task_id: null, title: "对比 · 委派在问你",
        subject: { kind: "delegation", id: "d1" }, handle: "D1",
      }],
    }))
    const answers = v.attention.filter(a => a.stage === "answer")
    expect(answers).toHaveLength(1)
    expect(answers[0].id).toBe("ask-a9")
    expect(answers[0].subject).toEqual({ kind: "delegation", id: "d1" })
    expect(answers[0].handle).toBe("D1")
    expect(v.attention.some(a => a.id === "delegation-ask-d1")).toBe(false)
  })

  it("委派在问但消息侧扫不到提问 → 状态行仍兜底出现", () => {
    const v = deriveCabinView(base({
      delegations: [{ id: "d1", title: "对比", state: "waiting_input" }],
    }))
    expect(v.attention.some(a => a.id === "delegation-ask-d1")).toBe(true)
  })
})
describe("deriveCabinView · 用户自开会话（origin=user）", () => {
  it("不产待办：done 不发完成回执、waiting_input 也不出 ask", () => {
    const v = deriveCabinView(base({
      delegations: [
        { id: "u1", title: "整理阈值", state: "done", origin: "user", handle: "D1" },
        { id: "u2", title: "还在跑", state: "waiting_input", origin: "user", handle: "D2" },
        { id: "d1", title: "汐音的", state: "done", handle: "D3" },
      ],
    }))
    expect(v.attention.map((a) => a.id)).toEqual(["done-delegation-d1"])
  })
})
