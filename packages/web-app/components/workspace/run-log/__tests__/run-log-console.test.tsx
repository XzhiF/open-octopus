import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { StepExecution } from "@/lib/types"

const { mockEvents } = vi.hoisted(() => ({ mockEvents: vi.fn() }))
vi.mock("@/hooks/use-execution-events", () => ({
  useExecutionEvents: () => mockEvents(),
}))

import { RunLogConsole } from "../run-log-console"

// 时间用「距今多少毫秒」表达：控制台按秒表推算运行中耗时，固定 1970 时间戳会把轴算歪
const NOW = Date.now()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const ev = (nodeId: string, event: string, agoMs: number, extra: Record<string, unknown> = {}) => ({
  nodeId, event, timestamp: ago(agoMs), ...extra,
})

// T-1 / T-2 并发跑在前，review 三专家随后并发 —— 旧日志正是在这两种形态下不可读
const EVENTS = [
  ev("T-1", "start", 5000, { type: "agent" }),
  ev("T-2", "start", 4900, { type: "agent" }),
  ev("T-1", "thinking_block", 4700, { content: "T-1 先看色板" }),
  ev("T-2", "bash_output", 4600, { lines: ["✓ 24 passed", "x", "y"] }),
  ev("T-1", "tool_call", 3600, { toolName: "Edit", input: { file_path: "globals.css" }, result: "+3 −3" }),
  ev("T-2", "end", 3500, { status: "completed", durationMs: 1400 }),
  ev("review", "expert_message", 1400, { role: "arch", content: "通道色只做标识" }),
  ev("review", "expert_message", 900, { role: "rev", content: "拆组件" }),
]

const STEPS = [
  { stepId: "T-1", stepName: "T-1 落地", status: "running", startedAt: ago(5000) },
  { stepId: "T-2", stepName: "T-2 落地", status: "completed", startedAt: ago(4900), completedAt: ago(3500), duration: 1 },
  { stepId: "review", stepName: "评审", status: "running", startedAt: ago(1500) },
] as unknown as StepExecution[]

function setup(overrides: Record<string, unknown> = {}) {
  mockEvents.mockReturnValue({
    events: EVENTS, loopIterations: {}, groups: [], heartbeat: undefined, loading: false, error: null,
    ...overrides,
  })
}

const props = (extra: Record<string, unknown> = {}) => ({
  workspaceId: "ws", executionId: "ex", executionStatus: "running", steps: STEPS, ...extra,
})

beforeEach(() => { vi.clearAllMocks(); setup() })

describe("RunLogConsole —— 合流终端", () => {
  it("按全局时间序输出，通道标决定归属而不是分组", () => {
    render(<RunLogConsole {...props()} />)
    const lines = screen.getAllByTestId("log-line")
    expect(lines.map((l) => l.getAttribute("data-channel"))).toEqual([
      "T-1", "T-2", "T-1", "T-2", "T-1", "T-2", "review", "review",
    ])
    expect(lines[2].textContent).toContain("思考")
    fireEvent.click(lines[2])
    expect(screen.getByText(/T-1 先看色板/)).toBeTruthy()
  })

  it("并发计数把 swarm 的三专家拆开显示", () => {
    render(<RunLogConsole {...props()} />)
    // T-1 running + review(2 专家) = 3
    expect(screen.getByText("3 并发")).toBeTruthy()
  })

  it("通道栏列出已开口的通道，可读名取自 steps，点击 = 聚焦并回报给 DAG", () => {
    const onFocusChange = vi.fn()
    render(<RunLogConsole {...props({ focus: null, onFocusChange })} />)
    const rail = within(screen.getByTestId("log-rail"))
    const items = screen.getAllByTestId("rail-item").map((b) => b.textContent ?? "")
    expect(items.some((t) => t.includes("T-1 落地"))).toBe(true)
    expect(items.some((t) => t.includes("评审"))).toBe(true)
    fireEvent.click(rail.getByTitle(/^review/))
    expect(onFocusChange).toHaveBeenCalledWith("review")
  })

  it("受控 focus 生效：只留该通道的行，并给出可清除的聚焦标", () => {
    render(<RunLogConsole {...props({ focus: "T-1" })} />)
    expect(screen.getAllByTestId("log-line")).toHaveLength(3)
    expect(screen.getByTestId("focus-pill").textContent).toContain("仅 T-1")
  })

  it("点 DAG 节点用的节点 id 也能命中其轮次通道", () => {
    mockEvents.mockReturnValue({
      events: [ev("loop-a", "start", 1000, { iteration: 1 }), ev("loop-a", "start", 1100, { iteration: 2 }), ev("other", "start", 1200)],
      loopIterations: {}, groups: [], heartbeat: undefined, loading: false, error: null,
    })
    render(<RunLogConsole {...props({ focus: "loop-a", steps: [] })} />)
    expect(screen.getAllByTestId("log-line")).toHaveLength(2)
  })

  it("摘要级别去掉流水输出；异常只留错误", () => {
    render(<RunLogConsole {...props()} />)
    fireEvent.click(screen.getByText("摘要"))
    expect(screen.queryByText(/✓ 24 passed/)).toBeNull()
    fireEvent.click(screen.getByText("全部"))
    expect(screen.getByText(/✓ 24 passed/)).toBeTruthy()
  })

  it("关键字过滤命中展开正文，并回报行数", () => {
    render(<RunLogConsole {...props()} />)
    fireEvent.change(screen.getByTestId("log-search"), { target: { value: "globals.css" } })
    expect(screen.getAllByTestId("log-line")).toHaveLength(1)
    expect(screen.getByText("1 行")).toBeTruthy()
  })

  it("展开工具行看到输入与结果", () => {
    render(<RunLogConsole {...props()} />)
    const tool = screen.getAllByTestId("log-line").find((l) => l.getAttribute("data-kind") === "tool")!
    fireEvent.click(tool)
    expect(screen.getByText(/file_path/)).toBeTruthy()
  })

  it("并发轨道按起止时间铺开：并行的重叠，后继的错开", () => {
    render(<RunLogConsole {...props()} />)
    const bars = Array.from(screen.getByTestId("log-ribbon").querySelectorAll("[style*='left']")) as HTMLElement[]
    expect(bars).toHaveLength(3)
    const [t1, t2, review] = bars.map((b) => ({ left: parseFloat(b.style.left), width: parseFloat(b.style.width) }))
    // T-1 / T-2 同时起跑 → 起点几乎重合且区间重叠
    expect(Math.abs(t1.left - t2.left)).toBeLessThan(5)
    expect(t2.left).toBeLessThan(t1.left + t1.width)
    // review 晚 3.5s 才起 → 明显落在后段
    expect(review.left).toBeGreaterThan(50)
  })

  it("分屏视图一通道一个 pane，⤢ 放大只看它", () => {
    render(<RunLogConsole {...props()} />)
    fireEvent.click(within(screen.getByTestId("view-seg")).getByText("分屏"))
    expect(screen.getAllByTestId("log-pane")).toHaveLength(3)
    fireEvent.click(screen.getAllByTitle("放大该通道")[0])
    expect(screen.getAllByTestId("log-pane")).toHaveLength(1)
  })

  it("读取失败要显形，不能静默空面板", () => {
    setup({ error: "agent-events 500" })
    render(<RunLogConsole {...props()} />)
    expect(screen.getByText("agent-events 500")).toBeTruthy()
    expect(within(screen.getByTestId("log-head")).getByText("日志读取失败")).toBeTruthy()
  })

  it("无事件时给等待态而不是空白", () => {
    setup({ events: [] })
    render(<RunLogConsole {...props({ steps: [] })} />)
    expect(within(screen.getByTestId("log-stream")).getByText("等待执行…")).toBeTruthy()
  })
})
