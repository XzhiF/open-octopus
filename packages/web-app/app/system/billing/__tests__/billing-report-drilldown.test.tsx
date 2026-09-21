// 04 · 报表 Tab：三分布图 + 双排行 + 点击跳明细（billing-report-3 ticket 04）组件测试
// Seam: <BillingPage/> 报表 Tab 分布/排行区渲染 + fireEvent 点击联动（非浏览器，spec 验证纪律：不做 E2E）。
// mock 票 02 breakdown/ranking 回包 fixture（期望值手贴自票 02 契约，禁自推 —— Tautological 禁令）；
// 联动断言 = 切 Tab + 明细筛选 DOM 值 + 注入后的 GET /calls 请求参数。API 聚合数字正确性 = 票 02 SQL 交叉已验。
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
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ data }: { data: unknown[]; children: React.ReactNode }) => (
    <div data-testid="trend-chart" data-points={data.length} />
  ),
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}))

import BillingPage from "../page"

// ── fixture（手贴自票 02 出参契约：items 费用降序、share 和=1；ranking items 已 TopN）──

interface BItem { key: string; cost_usd: number | null; cost_display: number | null; calls: number; share: number }
interface RItem { id: string; name: string; cost_usd: number | null; cost_display: number | null; calls: number }

const BREAKDOWNS: Record<string, BItem[]> = {
  model: [
    { key: "E2E_TEST_DM1", cost_usd: 50, cost_display: 350, calls: 20, share: 0.5 },
    { key: "E2E_TEST_DM2", cost_usd: 30, cost_display: 210, calls: 12, share: 0.3 },
    { key: "unknown", cost_usd: 20, cost_display: 140, calls: 8, share: 0.2 }, // 模型 NULL 组（cost 仍可 priced？否 —— 此组为 model NULL 老行，share 手贴自票 02 聚合规则）
  ],
  vendor: [
    { key: "E2E_TEST_DV1", cost_usd: 60, cost_display: 420, calls: 24, share: 0.6 },
    { key: "E2E_TEST_DV2", cost_usd: 25, cost_display: 175, calls: 10, share: 0.25 },
    { key: "unknown", cost_usd: 15, cost_display: 105, calls: 6, share: 0.15 },
  ],
  source: [
    { key: "workflow", cost_usd: 70, cost_display: 490, calls: 28, share: 0.7 },
    { key: "interaction", cost_usd: 20, cost_display: 140, calls: 8, share: 0.2 },
    { key: "unknown", cost_usd: 10, cost_display: 70, calls: 4, share: 0.1 },
  ],
}

const wsTop10: RItem[] = Array.from({ length: 10 }, (_, i) => ({
  id: `ws-${i + 1}`, name: `WS ${i + 1}`, cost_usd: 100 - i * 9, cost_display: (100 - i * 9) * 7, calls: 30 - i,
}))
const RANKINGS: Record<string, RItem[]> = {
  workspace: wsTop10,
  session: [
    { id: "sess-a1", name: "下钻会话甲", cost_usd: 40, cost_display: 280, calls: 9 },
    { id: "sess-b2", name: "下钻会话乙", cost_usd: 12, cost_display: 84, calls: 4 },
    { id: "unknown", name: "unknown", cost_usd: null, cost_display: null, calls: 2 }, // 全 unpriced 组 = NULL 垫底（KD4）
  ],
}

function summaryFixture() {
  return {
    from: "2026-09-01", to: "2026-09-30",
    total_cost_usd: 100, total_cost_display: 700, total_calls: 40,
    tokens: { in: 111, out: 222, cache_w: 33, cache_r: 44 },
    unpriced: { calls: 10, ratio: 0.25 },
    currency_rate: 7, display_currency: "CNY",
  }
}

/** 明细假数据：按筛选参数过滤固定四行 → 「首行归属正确、结果非空」在组件层可断言。 */
const CALL_ROWS = [
  { id: "c1", node_execution_id: null, execution_id: null, turn_index: 1, call_index: 0, model: "E2E_TEST_DM1", timestamp: 1790000000000, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 1, cost_native: 1, cost_currency: "USD", price_status: "priced", workspace_id: "ws-1", workflow_ref: null, node_id: null, session_id: "sess-a1", source_path: "workflow" },
  { id: "c2", node_execution_id: null, execution_id: null, turn_index: 1, call_index: 0, model: "E2E_TEST_DM2", timestamp: 1789000000000, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 2, cost_native: 2, cost_currency: "USD", price_status: "priced", workspace_id: "ws-1", workflow_ref: null, node_id: null, session_id: "sess-a1", source_path: "interaction" },
  { id: "c3", node_execution_id: null, execution_id: null, turn_index: 1, call_index: 0, model: "E2E_TEST_DM1", timestamp: 1788000000000, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: null, cost_native: null, cost_currency: null, price_status: "unpriced", workspace_id: "ws-2", workflow_ref: null, node_id: null, session_id: "sess-b2", source_path: "workflow" },
  { id: "c4", node_execution_id: null, execution_id: null, turn_index: 1, call_index: 0, model: null, timestamp: 1787000000000, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: null, cost_native: null, cost_currency: null, price_status: "unpriced", workspace_id: null, workflow_ref: null, node_id: null, session_id: null, source_path: null },
]

function callsFixture(params: URLSearchParams) {
  let rows = CALL_ROWS
  const model = params.get("model")
  const session = params.get("session_id")
  const ws = params.get("workspace_id")
  const src = params.get("source_path")
  const vendor = params.get("vendor")
  if (model) rows = rows.filter(r => r.model === model)
  if (session) rows = rows.filter(r => r.session_id === session)
  if (ws) rows = rows.filter(r => r.workspace_id === ws)
  if (src) rows = rows.filter(r => r.source_path === src || (src === "unknown" && r.source_path === null))
  if (vendor) rows = rows.filter(r => (vendor === "E2E_TEST_DV1" ? r.model === "E2E_TEST_DM1" : vendor === "E2E_TEST_DV2" ? r.model === "E2E_TEST_DM2" : false))
  return { calls: rows, total: rows.length, page: 1, pageSize: 50, models: ["E2E_TEST_DM1", "E2E_TEST_DM2"], source_subtotals: [] }
}

let urls: string[]

beforeEach(() => {
  vi.clearAllMocks()
  urls = []
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const u = String(input)
    urls.push(u)
    const q = new URL(u).searchParams
    if (u.includes("/report/summary")) return { ok: true, status: 200, json: async () => summaryFixture() }
    if (u.includes("/report/trend")) return { ok: true, status: 200, json: async () => ({ from: "2026-09-01", to: "2026-09-02", currency_rate: 7, display_currency: "CNY", days: [{ date: "2026-09-01", cost_usd: 100, cost_display: 700, calls: 40 }] }) }
    if (u.includes("/report/breakdown")) {
      const g = q.get("group_by") ?? "model"
      return { ok: true, status: 200, json: async () => ({ items: BREAKDOWNS[g], group_by: g, display_currency: "CNY", usd_to_cny: 7 }) }
    }
    if (u.includes("/report/ranking")) {
      const by = q.get("by") ?? "workspace"
      return { ok: true, status: 200, json: async () => ({ items: RANKINGS[by], by, limit: Number(q.get("limit")), display_currency: "CNY", usd_to_cny: 7 }) }
    }
    if (u.includes("/calls")) return { ok: true, status: 200, json: async () => callsFixture(q) }
    if (u.endsWith("/settings")) return { ok: true, status: 200, json: async () => ({ usd_to_cny: "7.0", display_currency: "CNY" }) }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

function lastCallsUrl(urlPart: RegExp): URL {
  const u = urls.filter(x => x.includes("/calls")).reverse().find(x => urlPart.test(x))
  expect(u, `未找到匹配 ${urlPart} 的 /calls 请求`).toBeDefined()
  return new URL(u!)
}

async function openReportTab() {
  render(<BillingPage />)
  fireEvent.click(screen.getByRole("tab", { name: "报表" }))
  await waitFor(() => expect(screen.getByTestId("breakdown-item-model-E2E_TEST_DM1")).toBeDefined())
}

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function dayOffset(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return dayStr(d)
}
const RANGE = { from: dayOffset(-29), to: dayOffset(0) }

describe("分布区渲染（US3 / AC1）", () => {
  it("三分布逐值映射：share 合计 100%±1%，最大项 = 回包首项，图例含 cost 与 share", async () => {
    await openReportTab()
    for (const g of ["model", "vendor", "source"] as const) {
      const items = BREAKDOWNS[g]
      // 首项 = 最大项（回包已降序）
      const first = screen.getByTestId(`breakdown-item-${g}-${items[0].key}`)
      expect(first).toBeDefined()
      // share 合计（从渲染的 data-share 累加）= 100%±1%
      const sum = items.reduce((s, it) => s + Number(first.ownerDocument.querySelector(`[data-testid="breakdown-item-${g}-${it.key}"]`)!.getAttribute("data-share")), 0)
      expect(Math.abs(sum - 1)).toBeLessThan(0.01)
      // 图例逐值：cost_display 金额 + share 百分化 + 调用数
      for (const it of items) {
        expect(screen.getByTestId(`breakdown-legend-${g}-${it.key}`).textContent)
          .toBe(`¥${it.cost_display} · ${Number((it.share * 100).toFixed(1))}% · ${it.calls} 次`)
      }
    }
  })

  it("breakdown 端点以三 group_by + 当前区间并发请求", async () => {
    await openReportTab()
    const bs = urls.filter(u => u.includes("/report/breakdown")).map(u => new URL(u))
    expect(new Set(bs.map(u => u.searchParams.get("group_by")))).toEqual(new Set(["model", "vendor", "source"]))
    for (const u of bs) {
      expect(u.searchParams.get("from")).toBe(RANGE.from)
      expect(u.searchParams.get("to")).toBe(RANGE.to)
    }
  })
})

describe("排行区渲染（US4 / AC2）", () => {
  it("workspace Top10 + session 列表与回包逐值一致；ranking 请求 by 双维 + limit=10", async () => {
    await openReportTab()
    expect(screen.getByTestId("ranking-item-workspace-1").textContent).toContain("WS 1")
    expect(screen.getByTestId("ranking-item-workspace-1").textContent).toContain("¥700")
    expect(screen.getByTestId("ranking-item-workspace-1").textContent).toContain("30 次")
    expect(screen.getByTestId("ranking-item-workspace-10").getAttribute("data-id")).toBe("ws-10")
    expect(screen.queryByTestId("ranking-item-workspace-11")).toBeNull() // 回包只给 Top10（KD25）
    expect(screen.getByTestId("ranking-item-session-1").textContent).toContain("下钻会话甲")
    expect(screen.getByTestId("ranking-item-session-3").textContent).toContain("—") // 全 unpriced 组 NULL → 占位不冒充
    const rs = urls.filter(u => u.includes("/report/ranking")).map(u => new URL(u))
    expect(new Set(rs.map(u => u.searchParams.get("by")))).toEqual(new Set(["workspace", "session"]))
    expect(rs.every(u => u.searchParams.get("limit") === "10")).toBe(true)
  })
})

describe("联动下钻（AC2/AC3 / 票面验证步骤2）", () => {
  it("点模型分布最大项 → 切实为明细 Tab，筛选收到 模型+区间，/calls 带 model 参数", async () => {
    await openReportTab()
    fireEvent.click(screen.getByTestId("breakdown-item-model-E2E_TEST_DM1"))
    await waitFor(() => expect(screen.getByTestId("billing-ledger")).toBeDefined())
    expect(screen.getByRole("tab", { name: "计费明细" }).getAttribute("aria-selected")).toBe("true")
    await waitFor(() => expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("E2E_TEST_DM1"))
    expect((screen.getByLabelText("起始时间") as HTMLInputElement).value).toBe(`${RANGE.from}T00:00`)
    expect((screen.getByLabelText("结束时间") as HTMLInputElement).value).toBe(`${RANGE.to}T23:59`)
    const q = lastCallsUrl(/model=E2E_TEST_DM1/).searchParams
    expect(q.get("from")).toBe(String(new Date(`${RANGE.from}T00:00`).getTime()))
    expect(q.get("to")).toBe(String(new Date(`${RANGE.to}T23:59`).getTime() + 59_999))
    // 明细结果非空且首行归属正确（模型列 = 注入值）
    const firstRow = screen.getByTestId("call-row-c1")
    expect(firstRow.textContent).toContain("E2E_TEST_DM1")
  })

  it("点 session 排行第 1 → session 筛选注入正确（含 id 可见）", async () => {
    await openReportTab()
    fireEvent.click(screen.getByTestId("ranking-item-session-1"))
    await waitFor(() => expect((screen.getByTestId("filter-session") as HTMLInputElement).value).toBe("sess-a1"))
    expect((screen.getByLabelText("起始时间") as HTMLInputElement).value).toBe(`${RANGE.from}T00:00`)
    const q = lastCallsUrl(/session_id=sess-a1/).searchParams
    expect(q.get("session_id")).toBe("sess-a1")
    expect(q.get("model")).toBeNull()
    expect(screen.getByTestId("call-row-c1")).toBeDefined() // 首行 session=sess-a1（mock 过滤规则）
  })

  it("点 workspace 排行第 3 → workspace 筛选注入", async () => {
    await openReportTab()
    fireEvent.click(screen.getByTestId("ranking-item-workspace-3"))
    await waitFor(() => expect((screen.getByTestId("filter-workspace") as HTMLInputElement).value).toBe("ws-3"))
    lastCallsUrl(/workspace_id=ws-3/)
  })

  it("点来源分布 workflow 项 → 来源筛选注入", async () => {
    await openReportTab()
    fireEvent.click(screen.getByTestId("breakdown-item-source-workflow"))
    await waitFor(() => expect((screen.getByLabelText("来源") as HTMLSelectElement).value).toBe("workflow"))
    lastCallsUrl(/source_path=workflow/)
  })

  it("'unknown' 厂商项可见且点击降级为仅区间筛选（无 vendor 参数）", async () => {
    await openReportTab()
    const unknownVendor = screen.getByTestId("breakdown-item-vendor-unknown")
    expect(unknownVendor).toBeDefined()
    fireEvent.click(unknownVendor)
    await waitFor(() => expect((screen.getByLabelText("起始时间") as HTMLInputElement).value).toBe(`${RANGE.from}T00:00`))
    expect((screen.getByTestId("filter-vendor") as HTMLInputElement).value).toBe("")
    const q = lastCallsUrl(/from=/).searchParams
    expect(q.get("vendor")).toBeNull()
    expect(q.get("model")).toBeNull()
    expect(q.get("from")).toBe(String(new Date(`${RANGE.from}T00:00`).getTime()))
  })

  it("模型/归属 'unknown' 组同样降级仅区间；来源 unknown 例外照常注入", async () => {
    await openReportTab()
    fireEvent.click(screen.getByTestId("breakdown-item-model-unknown"))
    await waitFor(() => expect(screen.getByTestId("billing-ledger")).toBeDefined())
    expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("")
    expect((screen.getByTestId("filter-session") as HTMLInputElement).value).toBe("")

    // 重置：先回报表再点来源 unknown
    fireEvent.click(screen.getByRole("tab", { name: "报表" }))
    await waitFor(() => expect(screen.getByTestId("breakdown-item-source-unknown")).toBeDefined())
    fireEvent.click(screen.getByTestId("breakdown-item-source-unknown"))
    await waitFor(() => expect((screen.getByLabelText("来源") as HTMLSelectElement).value).toBe("unknown"))
    lastCallsUrl(/source_path=unknown/)
  })

  it("排行 unknown 组点击 → 仅区间注入（id 不可精确筛）", async () => {
    await openReportTab()
    fireEvent.click(screen.getByTestId("ranking-item-session-3")) // id=unknown
    await waitFor(() => expect((screen.getByLabelText("起始时间") as HTMLInputElement).value).toBe(`${RANGE.from}T00:00`))
    expect((screen.getByTestId("filter-session") as HTMLInputElement).value).toBe("")
    const u = urls.filter(x => x.includes("/calls")).at(-1)!
    expect(u).not.toContain("session_id=unknown")
  })
})
