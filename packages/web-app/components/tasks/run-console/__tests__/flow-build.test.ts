// packages/web-app/components/tasks/run-console/__tests__/flow-build.test.ts
//
// 执行动线合成器单测。fixtures 形状照抄验收C 真事件（exec 077578ec 实拉）：
// end 带 durationMs+status、swarm 子代理只有 tool_call 无起止、
// 老 SQLite 行 input 为空串而 filePath 藏在 result、重试的二次 start。
// —— 解析即契约，格式漂移这里先炸。

import { describe, it, expect } from "vitest"
import type { AgentEvent } from "@/lib/types"
import { buildFlow, toolLine, FLOW_NODE_CAP, type FlowLine } from "../flow-build"

const T0 = Date.parse("2026-09-19T05:55:20.000Z")
const at = (ms: number) => new Date(T0 + ms).toISOString()
const ev = (nodeId: string, event: string, offMs: number, extra: Partial<AgentEvent> = {}): AgentEvent =>
  ({ nodeId, event, timestamp: at(offMs), ...extra } as AgentEvent)

const NODES: AgentEvent[] = [
  ev("__engine_init__", "start", -9000), ev("__engine_init__", "end", 0, { status: "completed" }),
  ev("spec-resolve", "start", 0),
  ev("spec-resolve", "end", 48, { status: "completed", durationMs: 48 }),
  ev("ticket-dag", "start", 100),
  ev("ticket-01", "tool_call", 5000, { toolName: "Write", input: { file_path: "/w/luhn/LuhnUtils.java" } }),
  ev("ticket-01", "tool_call", 6000, { toolName: "Bash", input: { command: "mvn -B -q package\n-second" } }),
  ev("ticket-02", "tool_call", 7000, { toolName: "Read", input: "", result: '{"type":"text","file":{"filePath":"/w/luhn/LuhnController.java","content":"…"}}' }),
  ev("ticket-dag", "end", 146452, { status: "completed", durationMs: 146452 }),
  ev("e2e-verify", "start", 200000),
  ev("e2e-verify", "tool_call", 250000, { toolName: "Bash", input: { command: "curl -sf 'http://localhost:18082/demo/luhn?no=4539578763621486'" } }),
  ev("e2e-verify", "tool_call", 260000, { toolName: "Bash", input: { command: "pnpm build" }, isError: true }),
  ev("e2e-verify", "end", 779337, { status: "completed", durationMs: 579337 }),
  ev("ship-pr", "start", 780000),
  ev("ship-pr", "end", 899559, { status: "completed", durationMs: 119559 }),
]
const nodes = (l: FlowLine[]) => l.filter((x): x is Extract<FlowLine, { kind: "node" }> => x.kind === "node")
const tools = (l: FlowLine[]) => l.filter((x): x is Extract<FlowLine, { kind: "tool" }> => x.kind === "tool")

describe("buildFlow — 真格式节点配对", () => {
  it("start/end 合并成一行：durationMs 优先，✓；内部节点绝迹", () => {
    const l = buildFlow(NODES, T0 + 900_000)
    const ns = nodes(l)
    expect(ns.map((n) => n.name)).toContain("e2e-verify")
    expect(l.some((x) => x.kind === "node" && x.name === "__engine_init__")).toBe(false)
    const e2e = ns.find((n) => n.name === "e2e-verify")!
    expect(e2e.dur).toBe("9m 39s") // durationMs=579337，不吃事件时间差（end-start 其实更大）
    expect(e2e.running).toBe(false)
    expect(e2e.bad).toBe(false)
    expect(e2e.at).toMatch(/\d{2}-\d{2} \d{2}:\d{2}$/) // clockShort 带月日（跨天动线不歧义）
  })
  it("显示序 = 完结时间新的在上", () => {
    const ns = nodes(buildFlow(NODES, T0 + 900_000))
    expect(ns[0].name).toBe("ship-pr")
    expect(ns[ns.length - 1].name).toBe("spec-resolve")
  })
  it("只有 start 没有 end → 活节点：running + 活时长（nowMs 起算）", () => {
    const l = buildFlow(NODES.slice(0, 10), T0 + 250_000)
    const live = nodes(l)[0]
    expect(live.name).toBe("e2e-verify")
    expect(live.running).toBe(true)
    expect(live.dur).toBe("50s")
  })
  it("二次 start（重试顶替）：前段判 bad 收尾，新段独立成行", () => {
    const l = buildFlow([
      ...NODES,
      ev("e2e-verify", "start", 1_000_000),
      ev("e2e-verify", "end", 1_010_000, { status: "aborted", durationMs: 10000 }),
    ], T0 + 1_100_000)
    const e2es = nodes(l).filter((n) => n.name === "e2e-verify")
    expect(e2es).toHaveLength(2)
    expect(e2es.some((n) => n.bad)).toBe(true)
  })
  it("end 无 durationMs → 时间戳差兜底；status=failed → bad", () => {
    const l = buildFlow([
      ev("cr", "start", 0),
      ev("cr", "end", 61000, { status: "failed" }),
    ], T0 + 70_000)
    const n = nodes(l)[0]
    expect(n.dur).toBe("1m 1s")
    expect(n.bad).toBe(true)
  })
})

describe("buildFlow — swarm 子代理挂窗 + 工具行退化", () => {
  it("无起止的 ticket-01/02 缩进挂到时间窗内的 ticket-dag 下，带工具数与「写 <file>」", () => {
    const l = buildFlow(NODES, T0 + 900_000)
    const iDag = l.findIndex((x) => x.kind === "node" && x.name === "ticket-dag")
    const kids = l.slice(iDag + 1).filter((x) => x.kind === "node" && x.depth === 1).map((x) => (x as Extract<FlowLine, { kind: "node" }>).name)
    expect(kids).toEqual(expect.arrayContaining(["ticket-01", "ticket-02"]))
    const t1 = nodes(l).find((n) => n.name === "ticket-01")!
    expect(t1.tools).toBe(2)
    expect(t1.writeNote).toBe("LuhnUtils.java")
  })
  it("工具行只给活节点/最上两枚完结节点 —— 不再流水账", () => {
    const l = buildFlow(NODES, T0 + 900_000)
    const ts = tools(l)
    // 最上两枚 ship-pr(0 工具) + e2e-verify(2 工具)
    expect(ts).toHaveLength(2)
    expect(ts[0].note).toContain("curl -sf")
    expect(ts[1].err).toBe(true)
    // 完结后工具行紧跟其节点行
    const iE2E = l.findIndex((x) => x.kind === "node" && x.name === "e2e-verify")
    expect(l[iE2E + 1]?.kind).toBe("tool")
  })
  it("input 空串的老行 → result.filePath 兜底出文件名", () => {
    const t = toolLine({ nodeId: "x", event: "tool_call", toolName: "Read", input: "", result: '{"file":{"filePath":"/a/b/walkthrough-true.json"}}' } as AgentEvent)
    expect(t.chip).toBe("Read")
    expect(t.note).toBe("walkthrough-true.json")
  })
  it("input 与 result 都无可读 → note 空（渲染层显「未落库」），命令多行取首行截 64", () => {
    expect(toolLine({ nodeId: "x", event: "tool_call", toolName: "Bash", input: "" } as AgentEvent).note).toBe("")
    expect(toolLine({ nodeId: "x", event: "tool_call", toolName: "Bash", input: { command: `ls -la\n后一行`.repeat(20) } } as AgentEvent).note.length).toBeLessThanOrEqual(65)
  })
  it("legacy 行 event_data 形状也能吃（toolName/input 嵌在 event_data）", () => {
    const t = toolLine({ nodeId: "x", event: "tool_call", event_data: { type: "tool_call", toolName: "Edit", input: '{"command":"cd repo && gh pr create"}' } } as unknown as AgentEvent)
    expect(t.chip).toBe("Edit")
    expect(t.note).toBe("cd repo && gh pr create")
  })
})

describe("buildFlow — loop 修复轮 + 预算", () => {
  it("loopIterations 有 total → ♻ 行置顶：第 cur/total 轮 + 挂过计数", () => {
    const l = buildFlow(NODES, T0 + 900_000, { "fix-loop": { total: 3, completed: 1, failed: 1, current: 2, mode: "dynamic", iterations: [] } })
    expect(l[0].kind).toBe("loop")
    expect((l[0] as Extract<FlowLine, { kind: "loop" }>).detail).toBe("第 2/3 轮 · 已挂 1 轮")
  })
  it("空 loopIterations（验收C 实测 {}）→ 不出行", () => {
    expect(buildFlow(NODES, T0 + 900_000, {}).some((x) => x.kind === "loop")).toBe(false)
  })
  it("节点爆表 → 截到 FLOW_NODE_CAP", () => {
    const many: AgentEvent[] = []
    for (let i = 0; i < 12; i++) {
      many.push(ev(`n${i}`, "start", i * 10), ev(`n${i}`, "end", i * 10 + 5, { durationMs: 5, status: "completed" }))
    }
    expect(nodes(buildFlow(many, T0)).length).toBe(FLOW_NODE_CAP)
  })
})
