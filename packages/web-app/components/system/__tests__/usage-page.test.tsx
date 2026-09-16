// usage-admin-3 票02 · Verification Method（component unit，零浏览器）：
// ①fixture 行注入 → 列齐全 / formatCost 三态（NULL→—）/ source 徽标 ②筛选器状态→query 序列化。
// 浏览器渲染证据归 05 票。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"

vi.mock("lucide-react", () => ({
  ChevronLeft: () => <span />,
  ChevronRight: () => <span />,
}))

vi.mock("@/hooks/useOrgs", () => ({
  useOrgs: () => ({ orgs: [{ id: 1, name: "org-a", path: "/o" }], loading: false, error: null }),
}))

vi.mock("@/lib/usage-api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/usage-api")>()
  return { ...mod, fetchUsageLlmCalls: vi.fn(), fetchUsageAggregate: vi.fn() }
})

import { UsageDetailTable, UsagePage, UsageAggregateTable } from "../usage-page"
import {
  buildLlmCallsQuery, fetchUsageLlmCalls, fetchUsageAggregate, buildAggregateQuery,
  type UsageLlmCall, type UsageFilters, type UsageAggregateRow,
} from "@/lib/usage-api"

const mockFetch = vi.mocked(fetchUsageLlmCalls)
const mockAgg = vi.mocked(fetchUsageAggregate)

function row(over: Partial<UsageLlmCall> = {}): UsageLlmCall {
  return {
    id: "r1", turnIndex: 1, callIndex: 0, messageId: "m1", model: "claude-x",
    stopReason: null, timestamp: 1757000000000, durationMs: 1234, ttftMs: 800,
    inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500, cacheCreationTokens: 100,
    costUsd: 0.1, org: "org-a", workspaceId: null, workflowRef: null, nodeId: null,
    sessionId: "sess-1", instanceId: null, nodeExecutionId: null, executionId: null,
    source: "chat", traceId: null, spanId: null,
    ...over,
  }
}

const HEADERS = ["时间", "source", "model", "归因", "in", "out", "缓存读", "缓存写", "ttft", "耗时", "费用"]

describe("UsageDetailTable", () => {
  it("列齐全 + 行内值格式化", () => {
    render(<UsageDetailTable rows={[row()]} />)
    const table = screen.getByRole("table")
    for (const h of HEADERS) expect(within(table).getByText(h)).toBeDefined()
    expect(within(table).getByText("claude-x")).toBeDefined()
    expect(within(table).getByText("1.0K")).toBeDefined() // formatTokenCount(1000)
    expect(within(table).getByText("2.0K")).toBeDefined()
    expect(within(table).getByText("800ms")).toBeDefined() // ttft
    expect(within(table).getByText("1s")).toBeDefined() // formatDuration(1234ms)
    expect(within(table).getByText("sess-1")).toBeDefined()
    expect(within(table).getByText("chat")).toBeDefined() // source 徽标
  })

  it("cost 三态：NULL→—、0→$0、有价→$x.xxxx", () => {
    render(<UsageDetailTable rows={[row({ id: "a", costUsd: null }), row({ id: "b", costUsd: 0 }), row({ id: "c", costUsd: 0.1 })]} />)
    const rows = screen.getAllByRole("row").slice(1) // 去表头
    expect(within(rows[0]).getByText("—")).toBeDefined()
    expect(within(rows[1]).getByText("$0")).toBeDefined()
    expect(within(rows[2]).getByText("$0.1000")).toBeDefined()
  })

  it("source/归因缺省 → 徽标兜底 —；ttft NULL → —", () => {
    render(<UsageDetailTable rows={[row({ source: null, sessionId: null, executionId: null, ttftMs: null })]} />)
    expect(screen.queryByText("chat")).toBeNull() // source 徽标未渲染原值
    const cellTexts = screen.getAllByRole("cell").map(c => c.textContent)
    expect(cellTexts.filter(t => t === "—").length).toBeGreaterThanOrEqual(3) // source + 归因 + ttft
  })

  it("空行集 → 空态文案", () => {
    render(<UsageDetailTable rows={[]} emptyText="暂无记录" />)
    expect(screen.getByText("暂无记录")).toBeDefined()
  })
})

describe("buildLlmCallsQuery（筛选器状态→请求参数序列化）", () => {
  const NOW = 1757000000000
  const empty: UsageFilters = { source: "", model: "", session: "", org: "", window: "" }

  it("空筛选只带 page/page_size（分页模式）", () => {
    expect(buildLlmCallsQuery(empty, 1, NOW)).toBe("page=1&page_size=50")
  })

  it("每个筛选位改变即带上对应 query 参数", () => {
    const q = buildLlmCallsQuery({ source: "cli", model: "m 1", session: "s/1", org: "org-a", workspace: "ws-1", window: "" }, 2, NOW)
    const p = new URLSearchParams(q)
    expect(p.get("page")).toBe("2")
    expect(p.get("source")).toBe("cli")
    expect(p.get("model")).toBe("m 1")
    expect(p.get("session_id")).toBe("s/1")
    expect(p.get("org")).toBe("org-a")
    expect(p.get("workspace_id")).toBe("ws-1")
    expect(p.has("from")).toBe(false)
  })

  it("时间窗 7d/30d/90d → from = now − N×86400000；all 不带 from", () => {
    for (const [w, d] of [["7d", 7], ["30d", 30], ["90d", 90]] as const) {
      const p = new URLSearchParams(buildLlmCallsQuery({ ...empty, window: w }, 1, NOW))
      expect(Number(p.get("from"))).toBe(NOW - d * 86_400_000)
    }
    expect(new URLSearchParams(buildLlmCallsQuery({ ...empty, window: "" }, 1, NOW)).has("from")).toBe(false)
  })
})

describe("UsagePage（取数接线）", () => {
  beforeEach(() => mockFetch.mockReset())

  it("挂载即拉第一页并渲染行；翻页带 page", async () => {
    mockFetch.mockResolvedValue({ calls: [row()], total: 51, page: 1, pageSize: 50 })
    render(<UsagePage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(mockFetch.mock.calls[0][1]).toBe(1)
    expect(screen.getByText("claude-x")).toBeDefined()
    expect(screen.getByText(/共 51/)).toBeDefined()

    const p2 = new Promise(resolve => setTimeout(() => resolve({ calls: [], total: 51, page: 2, pageSize: 50 }), 0))
    mockFetch.mockReturnValue(p2 as never)
    screen.getByLabelText("下一页").click()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][1]).toBe(2)
  })

  it("筛选器改变 → 重新请求且参数透传", async () => {
    mockFetch.mockResolvedValue({ calls: [], total: 0, page: 1, pageSize: 50 })
    render(<UsagePage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    mockFetch.mockResolvedValue({ calls: [], total: 0, page: 1, pageSize: 50 })
    const input = screen.getByLabelText("会话筛选")
    // jsdom fireEvent 语义：直接 setter + input 事件
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
    setter.call(input, "sess-9")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][0].session).toBe("sess-9")
  })
})

// —— 票03：聚合视图 tab ——

function aggRow(over: Partial<UsageAggregateRow> = {}): UsageAggregateRow {
  return {
    key: "k1", keyLabel: "组一", calls: 3,
    inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 100,
    totalTokens: 3600, costUsd: 0.3, costComplete: true, currency: "USD", cacheHitRate: 0.5,
    ...over,
  }
}

describe("buildAggregateQuery（dim + 复用筛选器 → 参数序列化）", () => {
  const NOW = 1757000000000
  it("只带 dim/org/from（聚合面不支持 source/model/session）", () => {
    expect(buildAggregateQuery("day", { org: "", window: "" }, NOW)).toBe("dim=day")
    const p = new URLSearchParams(buildAggregateQuery("clone", { org: "o1", window: "7d" }, NOW))
    expect(p.get("dim")).toBe("clone")
    expect(p.get("org")).toBe("o1")
    expect(Number(p.get("from"))).toBe(NOW - 7 * 86_400_000)
    expect(p.has("model")).toBe(false)
  })
})

describe("UsageAggregateTable", () => {
  it("列齐全 + 四字段/命中率/cost 三态/占比条宽度", () => {
    render(<UsageAggregateTable rows={[
      aggRow(), // cost 0.3 / 合计 0.6 → 50.0%
      aggRow({ key: "k2", keyLabel: "组二", costUsd: 0.1 }), // → 16.7%
      aggRow({ key: "k3", keyLabel: "组三", costUsd: null, costComplete: true }), // — / 0%
      aggRow({ key: "k4", keyLabel: "组四", costUsd: 0.2, costComplete: false }), // ≈$0.2000 → 33.3%
    ]} />)
    const table = screen.getByRole("table")
    for (const h of ["组", "calls", "in", "out", "缓存读", "缓存写", "total", "命中率", "费用", "占比"]) {
      expect(within(table).getByText(h)).toBeDefined()
    }
    expect(within(table).getAllByText("1.0K").length).toBe(4) // in 列四行同源值
    expect(within(table).getAllByText("50%").length).toBeGreaterThanOrEqual(1) // 命中率列
    expect(within(table).getByText("—")).toBeDefined() // NULL cost 不显示 0
    expect(within(table).getByText("≈$0.2000")).toBeDefined()
    const bars = screen.getAllByTestId("agg-share")
    expect(bars[0].getAttribute("style")).toContain("width: 50%") // jsdom 归一化 50.0%→50%
    expect(bars[1].getAttribute("style")).toContain("width: 16.7%")
    expect(bars[2].getAttribute("style")).toContain("width: 0%")
  })

  it("others 归并行折叠态（半透明 muted，key=others）", () => {
    render(<UsageAggregateTable rows={[aggRow(), aggRow({ key: "others", keyLabel: "其他 (5 组)" })]} />)
    expect(screen.getByText("其他 (5 组)")).toBeDefined()
  })

  it("空行集 → 空态", () => {
    render(<UsageAggregateTable rows={[]} emptyText="暂无数据" />)
    expect(screen.getByText("暂无数据")).toBeDefined()
  })
})

describe("UsagePage 聚合 tab", () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockAgg.mockReset()
    mockFetch.mockResolvedValue({ calls: [], total: 0, page: 1, pageSize: 50 }) // 挂载期明细默认值
  })

  it("切聚合 tab 拉 dim=day；dim 切换重发请求；明细不再请求", async () => {
    mockAgg.mockResolvedValue({ dim: "day", rows: [aggRow()] })
    render(<UsagePage />)
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    screen.getByText("聚合").click()
    await waitFor(() => expect(mockAgg).toHaveBeenCalledTimes(1))
    expect(mockAgg.mock.calls[0][0]).toBe("day")
    expect(await screen.findByText("组一")).toBeDefined()

    const sel = screen.getByLabelText("聚合维度")
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!
    setVal.call(sel, "model")
    sel.dispatchEvent(new Event("change", { bubbles: true }))
    await waitFor(() => expect(mockAgg).toHaveBeenCalledTimes(2))
    expect(mockAgg.mock.calls[1][0]).toBe("model")
    expect(mockFetch).toHaveBeenCalledTimes(1) // 明细面未被聚合操作重复触发
  })

  it("时间窗复用：切 7d → from 进聚合请求", async () => {
    mockAgg.mockResolvedValue({ dim: "day", rows: [] })
    render(<UsagePage />)
    screen.getByText("聚合").click()
    await waitFor(() => expect(mockAgg).toHaveBeenCalledTimes(1))
    const sel = screen.getByLabelText("时间窗")
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!
    setVal.call(sel, "7d")
    sel.dispatchEvent(new Event("change", { bubbles: true }))
    await waitFor(() => expect(mockAgg).toHaveBeenCalledTimes(2))
    expect(mockAgg.mock.calls[1][1].window).toBe("7d")
  })
})
