// billing-report-3 票03 · 报表 Tab（区间选择 + 汇总卡 + 按日趋势）组件测试
// Seam: <BillingPage/> 报表 Tab → <BillingReportTab/>。vitest + jsdom，mock 四 report 端点回包 —— 不做浏览器 E2E（spec 验证纪律）。
// 趋势数据点数经 recharts stub（data-points）断言；API 侧数字正确性由票 01（SQL 交叉）保证，本票不重复。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  usePathname: () => "/system/billing",
  redirect: vi.fn(),
}))
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
// recharts 在 jsdom 中 ResponsiveContainer 无尺寸不渲染 —— stub 透传数据点数/虚线属性供断言
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: React.ReactNode }) => (
    <div data-testid="trend-chart" data-points={data.length}>{children}</div>
  ),
  Line: ({ dataKey, strokeDasharray, name }: { dataKey: string; strokeDasharray?: string; name?: string }) => (
    <div data-testid={`trend-line-${dataKey}`} data-dash={strokeDasharray ?? ""} data-name={name ?? ""} />
  ),
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}))

import BillingPage from "../page"
import type { BillingReportSummary, BillingReportTrend } from "@/lib/billing-api"

// ── fixture（期望值手贴自票 01 契约，非被测 API 自推）────────────────────────

function summaryFixture(over: Partial<BillingReportSummary> = {}): BillingReportSummary {
  return {
    from: "2026-09-01", to: "2026-09-30",
    total_cost_usd: 100, total_cost_display: 700,
    total_calls: 40,
    tokens: { in: 111, out: 222, cache_w: 33, cache_r: 44 },
    unpriced: { calls: 10, ratio: 0.25 },
    currency_rate: 7, display_currency: "CNY",
    ...over,
  }
}

function trendFixture(days: Array<{ date: string; cost_display: number | null; calls: number }>): BillingReportTrend {
  return {
    from: days[0]?.date ?? "", to: days[days.length - 1]?.date ?? "",
    currency_rate: 7, display_currency: "CNY",
    days: days.map(d => ({ cost_usd: d.cost_display === null ? null : d.cost_display / 7, ...d })),
  }
}

const CUR_DAYS = [
  { date: "2026-09-01", cost_display: 70, calls: 4 },
  { date: "2026-09-02", cost_display: 140, calls: 8 },
  { date: "2026-09-03", cost_display: 700, calls: 10 }, // 尖峰日 10×（US2 可辨识 = 数据本身）
]
const PREV_DAYS = [
  { date: "2026-08-29", cost_display: 10, calls: 1 },
  { date: "2026-08-30", cost_display: 20, calls: 2 },
  { date: "2026-08-31", cost_display: 30, calls: 3 },
]

interface FetchCall { url: string; method: string }
let calls: FetchCall[]

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function localToday(): Date { return new Date() }
function dayOffset(n: number): string {
  const d = localToday()
  d.setDate(d.getDate() + n)
  return dayStr(d)
}

function mockFetch(opts?: {
  summary?: () => unknown
  trend?: (from: string, to: string) => unknown
  fail?: boolean
  delayMs?: number
}) {
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method ?? "GET" })
    if (opts?.delayMs) await new Promise(r => setTimeout(r, opts.delayMs))
    const q = new URL(u).searchParams
    if (opts?.fail) return { ok: false, status: 500, json: async () => ({ error: { code: "READ_FAILED", message: "数据库不可用" } }) }
    if (u.includes("/report/summary")) {
      return { ok: true, status: 200, json: async () => (opts?.summary ?? (() => summaryFixture()))() }
    }
    if (u.includes("/report/trend")) {
      const from = q.get("from") ?? "", to = q.get("to") ?? ""
      // 当前默认区间 from=今日-29；overlay 上一等长区间 from=今日-59
      const isPrev = from === dayOffset(-59)
      const trendOverride = opts?.trend
      const body = trendOverride ? trendOverride(from, to) : trendFixture(isPrev ? PREV_DAYS : CUR_DAYS)
      return { ok: true, status: 200, json: async () => body }
    }
    if (u.endsWith("/prices")) return { ok: true, status: 200, json: async () => ({ prices: [] }) }
    if (u.endsWith("/settings")) return { ok: true, status: 200, json: async () => ({ usd_to_cny: "7.0", display_currency: "CNY" }) }
    if (u.includes("/calls")) return { ok: true, status: 200, json: async () => ({ calls: [], total: 0, page: 1, pageSize: 50, models: [], source_subtotals: [] }) }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

function trendCalls(): string[] {
  return calls.filter(c => c.url.includes("/report/trend")).map(c => c.url)
}
function callWith(urlStart: string): FetchCall | undefined {
  return calls.find(c => c.url.includes(urlStart))
}

async function openReportTab() {
  render(<BillingPage />)
  fireEvent.click(screen.getByRole("tab", { name: "报表" }))
}

beforeEach(() => { vi.clearAllMocks(); mockFetch() })
afterEach(() => { vi.unstubAllGlobals() })

describe("报表 Tab 骨架", () => {
  it("页含三 Tab（报表 → 计费明细 → 价格配置），默认 = 报表（概览先行）", async () => {
    render(<BillingPage />)
    expect(screen.getByRole("tab", { name: "计费明细" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "价格配置" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "报表" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "报表" }).getAttribute("aria-selected")).toBe("true")
    await waitFor(() => expect(screen.getByTestId("billing-report")).toBeDefined())
  })
})

describe("汇总卡逐值（票面 fixture 手算）", () => {
  it("总费用/调用数/四类 token/未定价占比 = 回包值", async () => {
    await openReportTab()
    await waitFor(() => expect(screen.getByTestId("summary-cost")).toBeDefined())
    expect(screen.getByTestId("summary-cost").textContent).toBe("¥700") // 100 USD × 7
    expect(screen.getByTestId("summary-calls").textContent).toBe("40")
    expect(screen.getByTestId("summary-token-in").textContent).toBe("111")
    expect(screen.getByTestId("summary-token-out").textContent).toBe("222")
    expect(screen.getByTestId("summary-token-cache-w").textContent).toBe("33")
    expect(screen.getByTestId("summary-token-cache-r").textContent).toBe("44")
    expect(screen.getByTestId("summary-unpriced-ratio").textContent).toBe("25%") // 10/40 手算
    expect(screen.getByTestId("summary-unpriced-calls").textContent).toContain("10")
  })

  it("未定价占比角标 tooltip 解释「计数量不计费用」口径", async () => {
    await openReportTab()
    await waitFor(() => expect(screen.getByTestId("summary-unpriced-ratio")).toBeDefined())
    expect(screen.getByTestId("summary-unpriced-calls").getAttribute("title")).toContain("计数量不计费用")
    expect(screen.getByTestId("summary-unpriced-ratio").getAttribute("title")).toContain("计数量不计费用")
  })

  it("展示币种 USD 态：$ 前缀 + 直显值；CNY 态随动（fixture 两态）", async () => {
    mockFetch({ summary: () => summaryFixture({ total_cost_display: 100, currency_rate: 1, display_currency: "USD" }) })
    await openReportTab()
    await waitFor(() => expect(screen.getByTestId("summary-cost").textContent).toBe("$100"))
  })

  it("total_cost_display = null（全 unpriced 区间）→ 占位不冒充数字", async () => {
    mockFetch({ summary: () => summaryFixture({ total_cost_usd: null, total_cost_display: null, unpriced: { calls: 40, ratio: 1 } }) })
    await openReportTab()
    await waitFor(() => expect(screen.getByTestId("summary-cost").textContent).toBe("—"))
    await waitFor(() => expect(screen.getByTestId("summary-unpriced-ratio").textContent).toBe("100%"))
  })
})

describe("趋势折线（US2）", () => {
  it("数据点数 = trend 回包 days 数；当前区间实线 + 上一等长区间虚线", async () => {
    await openReportTab()
    await waitFor(() => expect(screen.getByTestId("trend-chart")).toBeDefined())
    expect(screen.getByTestId("trend-chart").getAttribute("data-points")).toBe("3")
    expect(screen.getByTestId("trend-line-cost")).toBeDefined()
    const prev = screen.getByTestId("trend-line-prevCost")
    expect(prev.getAttribute("data-dash")).not.toBe("") // 虚线叠加
  })

  it("并发拉上一等长区间：默认 30 天 → overlay trend 的 from/to = 前 30 天", async () => {
    await openReportTab()
    await waitFor(() => expect(trendCalls().length).toBeGreaterThanOrEqual(2))
    const cur = new URL(trendCalls().find(u => u.includes(`from=${dayOffset(-29)}`))!)
    expect(cur.searchParams.get("to")).toBe(dayOffset(0))
    const prev = trendCalls().find(u => u.includes(`from=${dayOffset(-59)}`))!
    const prevUrl = new URL(prev)
    expect(prevUrl.searchParams.get("to")).toBe(dayOffset(-30))
  })
})

describe("区间参数联动（AC1）", () => {
  it("默认 30 天：summary/trend 发出 from=今日-29、to=今日", async () => {
    await openReportTab()
    await waitFor(() => expect(callWith("/report/summary")).toBeDefined())
    const s = new URL(callWith("/report/summary")!.url)
    expect(s.searchParams.get("from")).toBe(dayOffset(-29))
    expect(s.searchParams.get("to")).toBe(dayOffset(0))
  })

  it("切 7 天 → 重发请求 from=今日-6、to=今日，且数字与回包一致", async () => {
    await openReportTab()
    await waitFor(() => expect(callWith("/report/summary")).toBeDefined())
    mockFetch({ summary: () => summaryFixture({ total_cost_display: 7, total_calls: 2, tokens: { in: 1, out: 2, cache_w: 3, cache_r: 4 }, unpriced: { calls: 0, ratio: 0 } }) })
    fireEvent.click(screen.getByRole("button", { name: "7 天" }))
    await waitFor(() => {
      const s = calls.filter(c => c.url.includes("/report/summary")).map(c => new URL(c.url))
        .find(u => u.searchParams.get("from") === dayOffset(-6))
      expect(s).toBeDefined()
      expect(s!.searchParams.get("to")).toBe(dayOffset(0))
    })
    await waitFor(() => expect(screen.getByTestId("summary-calls").textContent).toBe("2"))
    await waitFor(() => expect(screen.getByTestId("summary-token-in").textContent).toBe("1"))
  })

  it("自定义：改起始日期 → 发出对应 from", async () => {
    await openReportTab()
    await waitFor(() => expect(callWith("/report/summary")).toBeDefined())
    const before = calls.length
    fireEvent.change(screen.getByLabelText("起始日期"), { target: { value: "2026-09-05" } })
    await waitFor(() => expect(calls.length).toBeGreaterThan(before))
    const s = new URL(calls.filter(c => c.url.includes("/report/summary")).at(-1)!.url)
    expect(s.searchParams.get("from")).toBe("2026-09-05")
  })
})

describe("加载/空/错误态（AC3）", () => {
  it("加载中显示 spinner 态，回包后切换为内容", async () => {
    mockFetch({ delayMs: 60 })
    await openReportTab()
    expect(screen.getByTestId("report-loading")).toBeDefined()
    await waitFor(() => expect(screen.getByTestId("summary-cost")).toBeDefined(), { timeout: 3000 })
    expect(screen.queryByTestId("report-loading")).toBeNull()
  })

  it("空数据区间（total_calls=0、逐日全 0）→ 渲染空态不报错", async () => {
    mockFetch({
      summary: () => summaryFixture({ total_cost_usd: 0, total_cost_display: 0, total_calls: 0, tokens: { in: 0, out: 0, cache_w: 0, cache_r: 0 }, unpriced: { calls: 0, ratio: 0 } }),
      trend: () => trendFixture([{ date: dayOffset(-29), cost_display: 0, calls: 0 }]),
    })
    await openReportTab()
    await waitFor(() => expect(screen.getByTestId("report-empty")).toBeDefined())
    expect(screen.queryByTestId("trend-chart")).toBeNull()
    expect(screen.queryByTestId("report-error")).toBeNull()
    // 汇总卡仍渲染（数字 = 0，与回包一致）
    expect(screen.getByTestId("summary-calls").textContent).toBe("0")
  })

  it("端点 500 → 错误态显示 API 错误消息，不崩", async () => {
    mockFetch({ fail: true })
    await openReportTab()
    await waitFor(() => expect(screen.getByTestId("report-error")).toBeDefined())
    expect(screen.getByTestId("report-error").textContent).toContain("数据库不可用")
    expect(screen.queryByTestId("trend-chart")).toBeNull()
  })
})
