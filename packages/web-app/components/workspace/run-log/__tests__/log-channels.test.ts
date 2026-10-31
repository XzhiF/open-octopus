import { describe, it, expect } from "vitest"
import type { StepExecution } from "@/lib/types"
import {
  buildChannels,
  buildRows,
  channelMatchesFocus,
  colorForChannel,
  concurrentStreams,
  CHANNEL_PALETTE,
  elapsedMs,
  eventTime,
  channelKeyOf,
  filterRows,
  inFocus,
  rowFromEvent,
  shortTag,
  tail,
  compactInput,
  coalesceToolCalls,
  displayNameOf,
  clockOf,
  type LogRow,
  type RunEvent,
} from "../log-channels"

const T = (ms: number) => new Date(ms).toISOString()
const ev = (e: Partial<RunEvent> & { event: string }): RunEvent => ({ nodeId: "n1", timestamp: T(1000), ...e }) as RunEvent

const rowKind = (e: Partial<RunEvent> & { event: string }) => rowFromEvent(ev(e), 0)
const plain = (r: LogRow | null) => r as Exclude<typeof r, null>

describe("rowFromEvent —— 事件 → 终端行", () => {
  it("start / end 成为生命周期行，失败终态升到 error 级", () => {
    const start = plain(rowKind({ event: "start", type: "agent" }))
    expect(start.kind).toBe("start")
    expect(start.text).toContain("agent")

    const ok = plain(rowKind({ event: "end", status: "completed", durationMs: 6800 }))
    expect(ok.kind).toBe("end")
    expect(ok.level).toBe("info")
    expect(ok.text).toContain("7s")

    const bad = plain(rowKind({ event: "end", status: "failed", error: "boom", exitCode: 2 }))
    expect(bad.kind).toBe("fail")
    expect(bad.level).toBe("error")
    expect(bad.text).toContain("exit 2")
    expect(bad.text).toContain("boom")
  })

  it("块状输出没有 timestamp，用 startedAt 定位；超两行走展开", () => {
    const r = plain(rowKind({
      event: "bash_output", timestamp: undefined, startedAt: T(5000),
      lines: ["a", "b", "c", "d"],
    }))
    expect(r.at).toBe(5000)
    expect(r.text).toBe("a ⏎ b")
    expect(r.moreLines).toBe(2)
    expect(r.detail).toBe("a\nb\nc\nd")
  })

  it("工具行：入参压成一句，失败标红；正文留在展开里", () => {
    const r = plain(rowKind({
      event: "tool_call", toolName: "Bash", input: { command: "pnpm build" }, result: "ok",
    }))
    expect(r.kind).toBe("tool")
    expect(r.text).toBe("Bash pnpm build")
    expect(r.detail).toContain("pnpm build")
    expect(r.detail).toContain("ok")

    const failed = plain(rowKind({ event: "tool_call", toolName: "Read", isError: true }))
    expect(failed.kind).toBe("err")
    expect(failed.level).toBe("error")
  })

  it("同一次工具调用被拆成两半时按 toolCallId 兜底合并", () => {
    const split = [
      ev({ event: "tool_call", toolCallId: "t1", toolName: "Read", input: { file_path: "a.ts" } }),
      ev({ event: "tool_call", toolCallId: "t1", toolName: "Read", result: "contents" }),
    ] as RunEvent[]
    expect(coalesceToolCalls(split)).toHaveLength(1)
    const row = plain(rowFromEvent(coalesceToolCalls(split)[0], 0))
    expect(row.toolInput).toContain("a.ts")
    expect(row.toolResult).toBe("contents")
  })

  it("空壳 agent_event / 控制事件不落行", () => {
    expect(rowFromEvent(ev({ event: "agent_event", event_data: { type: "agent_event" } }), 0)).toBeNull()
    expect(rowFromEvent(ev({ event: "agent_event", event_data: { type: "turn_usage" } }), 0)).toBeNull()
    expect(rowFromEvent(ev({ event: "agent_event" }), 0)).toBeNull()
  })

  it("swarm 专家行留在所属节点通道内，靠 role 徽章区分并发", () => {
    const r = plain(rowKind({ event: "expert_message", nodeId: "review", role: "architect", round: 1, content: "建议" }))
    expect(r.chId).toBe("review")
    expect(r.role).toBe("architect")
    expect(rowFromEvent(ev({ event: "expert_complete", nodeId: "review", role: "arch", status: "completed" }), 1)?.kind).toBe("end")
  })

  it("噪声事件不进流：branch 标记 / status；心跳降级为 trace", () => {
    expect(rowFromEvent(ev({ event: "branch_start" }), 0)).toBeNull()
    expect(rowFromEvent(ev({ event: "branch_end" }), 0)).toBeNull()
    expect(rowFromEvent(ev({ event: "agent_event", event_data: { type: "status", status: "running" } }), 0)).toBeNull()
    expect(rowFromEvent(ev({ event: "agent_event", event_data: { type: "thinking" } }), 0)).toBeNull()
    const beat = plain(rowKind({ event: "heartbeat", heartbeatPayload: { step: 3, tokens_used: 1200 } as never }))
    expect(beat.kind).toBe("beat")
    expect(beat.level).toBe("trace")
  })

  it("审批与人工干预是等待点，落在 warn 级", () => {
    const a = plain(rowKind({ event: "approval_metadata", prompt: "是否发布？", options: [{ label: "发布" }, { label: "放弃" }], decision: "发布" }))
    expect(a.kind).toBe("approval")
    expect(a.level).toBe("warn")
    expect(a.text).toContain("发布 / 放弃")
    expect(plain(rowKind({ event: "intervention", data: { prompt: "改一下 SQL" } })).text).toContain("⚑")
  })

  it("node_log 里的错误字样不再被吞成普通行", () => {
    expect(plain(rowKind({ event: "node_log", line: "spec-dag-execute:node_start T-1 (agent)" })).kind).toBe("log")
    expect(plain(rowKind({ event: "node_log", line: "compile failed in engine" })).kind).toBe("err")
  })
})

describe("通道身份", () => {
  it("loop 轮次独立成通道，sub_workflow 的 scoped id 原样保留", () => {
    expect(channelKeyOf(ev({ nodeId: "loop-a", event: "start", iteration: 2 }))).toBe("loop-a#2")
    expect(channelKeyOf(ev({ nodeId: "loop-a", event: "start" }))).toBe("loop-a")
    expect(channelKeyOf(ev({ nodeId: "ticket-dag:T-1", event: "start", iteration: 1 }))).toBe("ticket-dag:T-1#1")
    expect(channelKeyOf(ev({ nodeId: "", event: "start" }))).toBe("(未归属)")
  })

  it("短标：取 scoped 尾段、去掉 -iterN、超长省略，轮次后缀保留", () => {
    expect(shortTag("spec-dag-execute:T-1-iter0")).toBe("T-1")
    expect(shortTag("spec-resolve")).toBe("spec-resolve")
    expect(shortTag("ticket-dag", 3)).toBe("ticket-dag·3")
    expect(shortTag("a-really-long-node-name-here")).toBe("a-really-long…")
  })

  it("展示名只保留一种写法：有真名用人话名，否则用短标", () => {
    expect(displayNameOf({ node: "ticket-dag:ticket-01", tag: "ticket-01", label: "ticket-dag:ticket-01" })).toBe("ticket-01")
    expect(displayNameOf({ node: "T-1", tag: "T-1", label: "T-1 落地" })).toBe("T-1 落地")
    expect(displayNameOf({ node: "T-1", tag: "T-1", label: "T-1" })).toBe("T-1")
  })

  it("同一通道恒定同色，且不会用到错误红", () => {
    expect(colorForChannel("ticket-dag")).toBe(colorForChannel("ticket-dag"))
    expect(CHANNEL_PALETTE).toContain(colorForChannel("nobody-knows-this"))
  })

  it("块状事件缺时间戳时回落 completedAt", () => {
    expect(eventTime({ nodeId: "a", event: "x", completedAt: T(7000) } as RunEvent)).toBe(7000)
    expect(eventTime({ nodeId: "a", event: "x" } as RunEvent)).toBe(0)
  })
})

// 三条工单并发 + swarm 三专家 —— 旧日志正是在这种形态下塌掉的
function concurrentRun(): RunEvent[] {
  return [
    { ...ev({ event: "start", nodeId: "spec", type: "agent" }), timestamp: T(1000) },
    { ...ev({ event: "end", nodeId: "spec", status: "completed" }), timestamp: T(2000) },
    { ...ev({ event: "start", nodeId: "T-1" }), timestamp: T(3000) },
    { ...ev({ event: "start", nodeId: "T-2" }), timestamp: T(3100) },
    { ...ev({ event: "start", nodeId: "T-3" }), timestamp: T(3200) },
    { ...ev({ event: "thinking_block", nodeId: "T-1", content: "先看色板" }), timestamp: T(3300) },
    { ...ev({ event: "bash_output", nodeId: "T-2", lines: ["✓ 24 passed"] }), timestamp: T(3400) },
    { ...ev({ event: "tool_call", nodeId: "T-3", toolName: "Grep", input: { pattern: "pop-green" } }), timestamp: T(3500) },
    { ...ev({ event: "heartbeat", nodeId: "T-3" }), timestamp: T(3600) },
    { ...ev({ event: "expert_message", nodeId: "review", role: "arch", content: "甲" }), timestamp: T(6100) },
    { ...ev({ event: "expert_message", nodeId: "review", role: "rev", content: "乙" }), timestamp: T(6200) },
    { ...ev({ event: "expert_message", nodeId: "review", role: "sec", content: "丙" }), timestamp: T(6300) },
    { ...ev({ event: "end", nodeId: "review", status: "completed" }), timestamp: T(7000) },
  ] as RunEvent[]
}

describe("buildChannels —— 谁在说话", () => {
  const steps = [
    { stepId: "spec", stepName: "规格", status: "completed", startedAt: T(1000), completedAt: T(2000), duration: 1 },
    { stepId: "T-1", stepName: "T-1 落地", status: "running", startedAt: T(3000) },
    { stepId: "T-2", stepName: "T-2 落地", status: "running", startedAt: T(3100) },
    { stepId: "T-3", stepName: "T-3 落地", status: "running", startedAt: T(3200) },
    { stepId: "review", stepName: "评审", status: "completed", startedAt: T(6000), completedAt: T(7000), duration: 1 },
    { stepId: "ship-pr", stepName: "提 PR", status: "running", startedAt: T(7500) },
  ] as unknown as StepExecution[]

  const channels = buildChannels(buildRows(concurrentRun()), steps)
  const byId = (id: string) => channels.find((c) => c.id === id)

  it("按起始时间排列，节点可读名取自 steps", () => {
    expect(channels.map((c) => c.id)).toEqual(["spec", "T-1", "T-2", "T-3", "review", "ship-pr"])
    expect(byId("T-1")?.label).toBe("T-1 落地")
    expect(byId("T-1")?.tag).toBe("T-1")
  })

  it("并发流数：三个工单并行 = 3；swarm 一通道三专家也 = 3", () => {
    expect(concurrentStreams(channels)).toBe(4) // T-1 T-2 T-3 + ship-pr
    const swarmOnly = buildChannels(
      buildRows([
        { ...ev({ event: "start", nodeId: "review" }), timestamp: T(1000) },
        { ...ev({ event: "expert_message", nodeId: "review", role: "arch", content: "甲" }), timestamp: T(1100) },
        { ...ev({ event: "expert_message", nodeId: "review", role: "rev", content: "乙" }), timestamp: T(1200) },
        { ...ev({ event: "expert_message", nodeId: "review", role: "sec", content: "丙" }), timestamp: T(1300) },
      ] as RunEvent[]),
      [{ stepId: "review", stepName: "评审", status: "running", startedAt: T(1000) }] as unknown as StepExecution[],
    )
    expect(swarmOnly).toHaveLength(1)
    expect(swarmOnly[0].roles).toEqual(["arch", "rev", "sec"])
    expect(concurrentStreams(swarmOnly)).toBe(3)
  })

  it("专家回执不给通道定终态，节点级 end 才算结束", () => {
    expect(byId("review")?.status).toBe("done")
    expect(byId("review")?.endedAt).toBe(7000)
    expect(byId("T-1")?.status).toBe("running")
  })

  it("已启动但一行未吐的节点仍占一条通道 —— 停滞要看得见", () => {
    const quiet = byId("ship-pr")
    expect(quiet).toBeDefined()
    expect(quiet?.count).toBe(0)
    expect(quiet?.status).toBe("running")
  })

  it("loop 子步骤的 -iterN 后缀能对上 events 的 iteration 通道", () => {
    const rows = buildRows([
      { ...ev({ event: "start", nodeId: "loop-a:inner", iteration: 1 }), timestamp: T(1000) },
      { ...ev({ event: "text_block", nodeId: "loop-a:inner", iteration: 1, content: "第 1 轮" }), timestamp: T(1100) },
    ] as RunEvent[])
    const chs = buildChannels(rows, [
      { stepId: "loop-a:inner-iter0", stepName: "内层 · 第 1 轮", status: "completed", startedAt: T(1000), completedAt: T(1200) },
    ] as unknown as StepExecution[])
    expect(chs[0].label).toBe("内层 · 第 1 轮")
    expect(chs[0].iteration).toBe(1)
    expect(chs[0].tag).toBe("inner·1")
  })

  it("运行中的耗时按秒表现算，不烘进通道", () => {
    const running = byId("T-1")!
    expect(running.durationMs).toBeNull()
    expect(elapsedMs(running, 9000)).toBe(6000)
    const done = byId("review")!
    expect(elapsedMs(done, 99_000)).toBe(1000)
  })
})

describe("筛选 —— 聚焦 / 摘要 / 异常 / 关键字", () => {
  const rows = buildRows(concurrentRun())

  it("按节点聚焦会命中它的全部轮次通道", () => {
    const loopRows = buildRows([
      { ...ev({ event: "start", nodeId: "loop-a", iteration: 1 }), timestamp: T(1000) },
      { ...ev({ event: "start", nodeId: "loop-a", iteration: 2 }), timestamp: T(2000) },
      { ...ev({ event: "start", nodeId: "other" }), timestamp: T(3000) },
    ] as RunEvent[])
    expect(filterRows(loopRows, { channel: "loop-a" }).map((r) => r.chId)).toEqual(["loop-a#1", "loop-a#2"])
    expect(inFocus(loopRows[0], "loop-a#1")).toBe(true)
    expect(channelMatchesFocus({ id: "loop-a#1", node: "loop-a" } as never, "loop-a")).toBe(true)
  })

  it("DAG 点容器节点会连带命中子工作流的子通道", () => {
    const rows = buildRows([
      { ...ev({ event: "start", nodeId: "ticket-dag:T-1" }), timestamp: T(1000) },
      { ...ev({ event: "start", nodeId: "ticket-dag:T-2" }), timestamp: T(2000) },
      { ...ev({ event: "start", nodeId: "ticket-dag-x" }), timestamp: T(3000) },
    ] as RunEvent[])
    expect(filterRows(rows, { channel: "ticket-dag" }).map((r) => r.chId))
      .toEqual(["ticket-dag:T-1", "ticket-dag:T-2"])
    expect(channelMatchesFocus({ id: "ticket-dag:T-1", node: "ticket-dag:T-1" } as never, "ticket-dag")).toBe(true)
  })

  it("摘要去掉流水输出与心跳，异常只留 warn/err/fail", () => {
    const summary = filterRows(rows, { level: "summary" })
    expect(summary.some((r) => r.kind === "out")).toBe(false)
    expect(summary.some((r) => r.kind === "beat")).toBe(false)
    expect(summary.some((r) => r.kind === "think")).toBe(true)

    const problem = filterRows(rows, { level: "problem" })
    expect(problem.every((r) => ["err", "fail", "warn"].includes(r.kind))).toBe(true)

    expect(filterRows(rows, { level: "all" })).toBe(rows)
  })

  it("关键字命中正文与展开正文，并区分大小写不敏感", () => {
    expect(filterRows(rows, { query: "POP-GREEN" })).toHaveLength(1)
    expect(filterRows(rows, { query: "先看色板" })).toHaveLength(1)
    expect(filterRows(rows, { query: "无此内容" })).toHaveLength(0)
  })

  it("尾部截断只留最后 cap 行，并报出折叠数", () => {
    const t = tail(rows, 4)
    expect(t.hidden).toBe(rows.length - 4)
    expect(t.shown.map((r) => r.at)).toEqual(rows.slice(-4).map((r) => r.at))
    expect(tail(rows, 999).hidden).toBe(0)
  })
})

describe("展示格式化", () => {
  it("时钟固定宽度，缺时刻有占位", () => {
    expect(clockOf(new Date(2026, 9, 30, 12, 4, 8, 20).getTime())).toMatch(/^12:04:08\.020$/)
    expect(clockOf(0)).toBe("--:--:--")
  })

  it("工具入参挑语义键，不整坨 JSON", () => {
    expect(compactInput({ file_path: "a/b.ts", extra: 1 })).toBe("a/b.ts")
    expect(compactInput({ todos: [1, 2, 3] })).toBe("todos: 3 项")
    expect(compactInput("raw text")).toBe("raw text")
    expect(compactInput(null)).toBe("")
  })
})
