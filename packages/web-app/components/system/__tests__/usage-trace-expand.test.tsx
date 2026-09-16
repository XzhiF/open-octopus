// usage-admin-3 票04 · Verification Method（component unit，零浏览器）：
// ①fixture 多轮 trace → 分组、小计=Σ 明细（ledger 具名和）、无 trace 行占位
// ②展开只发一次 trace 查询（不逐行拉全表）。浏览器证据归 05。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"

vi.mock("lucide-react", () => ({
  ChevronLeft: () => <span />,
  ChevronRight: () => <span />,
}))

vi.mock("@/hooks/useOrgs", () => ({
  useOrgs: () => ({ orgs: [], loading: false, error: null }),
}))

vi.mock("@/lib/usage-api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/usage-api")>()
  return { ...mod, fetchUsageLlmCalls: vi.fn(), fetchUsageAggregate: vi.fn(), fetchUsageTrace: vi.fn() }
})

import { UsageTraceTree } from "../usage-trace-tree"
import { UsageDetailTable, UsagePage } from "../usage-page"
import { buildTraceQuery, fetchUsageTrace, fetchUsageLlmCalls, type UsageLlmCall } from "@/lib/usage-api"

const mockList = vi.mocked(fetchUsageLlmCalls)
const mockTrace = vi.mocked(fetchUsageTrace)

function call(over: Partial<UsageLlmCall> = {}): UsageLlmCall {
  return {
    id: `c-${Math.random().toString(36).slice(2)}`, turnIndex: 1, callIndex: 0, messageId: "m",
    model: "tree-model", stopReason: null, timestamp: 1757000000000, durationMs: 1000, ttftMs: 100,
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0.1, org: "org-a", workspaceId: "ws-1", workflowRef: null, nodeId: null,
    sessionId: "sess-1", instanceId: null, nodeExecutionId: null, executionId: null,
    source: "chat", traceId: "t1", spanId: "s1",
    ...over,
  }
}

describe("UsageTraceTree", () => {
  it("多轮分组 + 小计=Σ明细（ledger 具名和；cost 三态部分和）", () => {
    // turn1: 2 次调用（1000+200 / 500+100，cost 0.1+0.2）；turn2: 1 次未定价
    render(<UsageTraceTree calls={[
      call({ id: "a", turnIndex: 1, callIndex: 0, timestamp: 1000 }),
      call({ id: "b", turnIndex: 1, callIndex: 1, timestamp: 4000, inputTokens: 500, outputTokens: 100, costUsd: 0.2 }),
      call({ id: "c", turnIndex: 2, callIndex: 0, timestamp: 9000, inputTokens: 20, outputTokens: 10, costUsd: null }),
    ]} />)
    expect(screen.getByText("轮 1")).toBeDefined()
    expect(screen.getByText("轮 2")).toBeDefined()
    // Σ 四字段 = 1000+200+500+100+20+10 = 1830 → formatTokenCount = "1.8K"
    expect(screen.getByText(/1\.8K/)).toBeDefined()
    // cost: 0.1+0.2 已知 + 一行 NULL → 部分和三态 "≈$0.3000"
    expect(screen.getByText("≈$0.3000")).toBeDefined()
    // 时间偏移（相对首调用）
    expect(screen.getByText("+3s")).toBeDefined()
  })

  it("引擎域行 → execution/node 归因面包屑", () => {
    render(<UsageTraceTree calls={[call({ source: "engine", sessionId: null, executionId: "exec-9", nodeId: "n-node", traceId: "exec-9" })]} />)
    expect(screen.getAllByText(/exec-9/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/节点 n-node/)).toBeDefined() // 面包屑明确带归因前缀
  })

  it("空组（旧行无 trace 展开兜底）→ 「无追踪链」占位，不报错", () => {
    render(<UsageTraceTree calls={[]} />)
    expect(screen.getByText("无追踪链")).toBeDefined()
  })

  it("加载中/失败占位", () => {
    render(<UsageTraceTree calls={[]} loading />)
    expect(screen.getByText("加载中…")).toBeDefined()
  })
})

describe("buildTraceQuery", () => {
  it("trace_id + source=all + limit 上限（一次拉全组，不逐行拉全表）", () => {
    const p = new URLSearchParams(buildTraceQuery("t/1"))
    expect(p.get("trace_id")).toBe("t/1")
    expect(p.get("source")).toBe("all")
    expect(p.get("limit")).toBe("500")
  })
})

describe("明细行展开接线（UsageDetailTable + UsagePage）", () => {
  beforeEach(() => { mockList.mockReset(); mockTrace.mockReset() })

  it("无 trace 行显示「无追踪链」占位（非按钮）", () => {
    render(<UsageDetailTable rows={[call({ traceId: null })]} />)
    expect(screen.getByText("无追踪链")).toBeDefined()
    expect(screen.queryByLabelText("展开调用树")).toBeNull()
  })

  it("onToggle 回调收到被点行", () => {
    const onToggle = vi.fn()
    const r = call({ id: "x" })
    render(<UsageDetailTable rows={[r]} trace={null} onToggle={onToggle} />)
    screen.getByLabelText("展开调用树").click()
    expect(onToggle).toHaveBeenCalledWith(r)
  })

  it("页级：展开拉 trace 树；同 trace 他行标「同轮」；收起再展开不重查", async () => {
    mockList.mockResolvedValue({
      calls: [call({ id: "r1", traceId: "t1" }), call({ id: "r2", traceId: "t1", turnIndex: 2 }), call({ id: "r3", traceId: null })],
      total: 3, page: 1, pageSize: 50,
    })
    mockTrace.mockResolvedValue([call({ id: "t1a" }), call({ id: "t1b", turnIndex: 2 })])
    render(<UsagePage />)
    await waitFor(() => expect(screen.getAllByLabelText("展开调用树").length).toBe(2))

    screen.getAllByLabelText("展开调用树")[0].click()
    await waitFor(() => expect(mockTrace).toHaveBeenCalledTimes(1))
    expect(mockTrace.mock.calls[0][0]).toBe("t1")
    // 树渲染（轮分组）
    await waitFor(() => expect(within(screen.getByTestId("trace-tree")).getByText("轮 2")).toBeDefined())
    // 同轮标记落在同 trace 的另一明细行
    const sameRound = screen.getAllByText("同轮")
    expect(sameRound.length).toBe(1)
    // 收起 → 再展开：命中缓存，fetch 仍 1 次
    screen.getByLabelText("收起调用树").click()
    screen.getAllByLabelText("展开调用树")[0].click()
    await waitFor(() => expect(within(screen.getByTestId("trace-tree")).getByText("轮 2")).toBeDefined())
    expect(mockTrace).toHaveBeenCalledTimes(1)
  })
})
