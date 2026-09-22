// 06 · 计费明细 Tab 组件测试（vitest + jsdom，无浏览器 E2E）
// Seam: <BillingLedgerTab/> + 纯函数 convertCostToDisplay（fetch mock 断言 query 参数与渲染换算）。
// billing NEW-r2：行上 cost_usd/price_status 为查询时派生值（账本不存钱、无 legacy 快照态）。
// 手算期望：PRICED 行 cost_usd=22.05；CNY 展示 × 汇率 7 → 154.35（¥ 前缀）；USD 直显 $22.05。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { BillingLedgerTab, convertCostToDisplay } from "@/components/system/billing/billing-ledger-tab"

interface FetchCall { url: string }
let calls: FetchCall[]

const ROW_PRICED = {
  id: "r-priced", node_execution_id: "e-1-n1", execution_id: "e-1", turn_index: 1, call_index: 0,
  model: "E2E_TEST_A", timestamp: 1700000001000,
  input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_creation_tokens: 100,
  cost_usd: 22.05, price_status: "priced",
  workspace_id: "ws-1", workflow_ref: "wf.yaml", node_id: "n1", session_id: "s-1",
}
const ROW_UNPRICED = {
  ...ROW_PRICED, id: "r-unpriced", model: "E2E_TEST_B",
  cost_usd: null, price_status: "unpriced",
}

function mockFetch(settings: { usd_to_cny: string; display_currency: string }, total = 2) {
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url)
    calls.push({ url: u })
    if (u.includes("/calls")) {
      return { ok: true, status: 200, json: async () => ({ calls: [ROW_PRICED, ROW_UNPRICED], total, page: 1, pageSize: 50, models: ["E2E_TEST_A", "E2E_TEST_B"] }) }
    }
    if (u.includes("/settings")) return { ok: true, status: 200, json: async () => settings }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

async function renderTab(settings = { usd_to_cny: "7", display_currency: "CNY" }, total = 2) {
  mockFetch(settings, total)
  render(<BillingLedgerTab />)
  // 行模型 ID 与模型下拉 option 同名 → 断言至少出现表格 + 下拉两处
  await waitFor(() => expect(screen.getAllByText("E2E_TEST_A").length).toBeGreaterThanOrEqual(2))
}

beforeEach(() => { vi.clearAllMocks() })

describe("纯函数 convertCostToDisplay（AC3 换算）", () => {
  it("CNY = cost_usd × 汇率（22.05×7=154.35 容差 0.01）；USD 直显", () => {
    const cny = convertCostToDisplay(ROW_PRICED, "CNY", 7)
    expect(cny.kind).toBe("amount")
    if (cny.kind === "amount") {
      expect(cny.symbol).toBe("¥")
      expect(Number(cny.text)).toBeCloseTo(154.35, 2)
    }
    const usd = convertCostToDisplay(ROW_PRICED, "USD", 7)
    if (usd.kind !== "amount") throw new Error("USD priced 应为 amount")
    expect(usd.text).toBe("22.05") // 直显不乘
    expect(usd.symbol).toBe("$")
  })
  it("unpriced → 徽标态（无数字）；cost NULL（含派生前 null price_status）→ 同归 unpriced 占位（NEW-r2 无 legacy 态）", () => {
    expect(convertCostToDisplay({ cost_usd: null, price_status: "unpriced" }, "CNY", 7)).toEqual({ kind: "unpriced" })
    expect(convertCostToDisplay({ cost_usd: null, price_status: null }, "CNY", 7)).toEqual({ kind: "unpriced" })
  })
})

describe("表格渲染（AC1/AC2 显示面）", () => {
  it("列头齐全；CNY 展示时金额 = ¥154.35 手算值；unpriced 徽标且费用列无数字", async () => {
    await renderTab()
    for (const h of ["时间", "模型", "输入", "输出", "缓存写", "缓存读", "状态"]) {
      expect(screen.getAllByText(h).length).toBeGreaterThanOrEqual(1) // 列头（模型同在下拉 label）
    }
    expect(screen.getByText("费用（¥）")).toBeDefined() // 表头随展示币种
    expect(screen.getByText("¥154.35")).toBeDefined() // 22.05×7 手算
    const badge = screen.getByTestId("badge-unpriced")
    expect(badge.textContent).toBe("未定价") // 费用列只有徽标，无数字
    expect(badge.textContent).not.toMatch(/\d/)
    // 四类 token 各列（两行同值 → 各 ≥2 个匹配）
    expect(screen.getAllByText("1000").length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText("100").length).toBeGreaterThanOrEqual(2)
  })

  it("切展示币种 USD → 金额随动为 $22.05", async () => {
    await renderTab({ usd_to_cny: "7", display_currency: "USD" })
    expect(screen.getByText("$22.05")).toBeDefined()
    expect(screen.getByText("费用（$）")).toBeDefined()
  })
})

describe("筛选与分页（AC2 参数面）", () => {
  it("定价状态筛选 → GET 带 price_status=unpriced；模型筛选 → 带 model", async () => {
    await renderTab()
    fireEvent.change(screen.getByLabelText("定价状态"), { target: { value: "unpriced" } })
    await waitFor(() => expect(calls.some(c => c.url.includes("price_status=unpriced"))).toBe(true))
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "E2E_TEST_A" } })
    await waitFor(() => expect(calls.some(c => c.url.includes("price_status=unpriced") && c.url.includes("model=E2E_TEST_A"))).toBe(true))
    // 模型下拉候选来自 API models 字段
    expect(screen.getByRole("option", { name: "E2E_TEST_B" })).toBeDefined()
  })

  it("total=60 → 2 页；下一页 GET 带 page=2", async () => {
    await renderTab({ usd_to_cny: "7", display_currency: "CNY" }, 60)
    expect(screen.getByTestId("ledger-page-indicator").textContent).toBe("第 1 / 2 页")
    fireEvent.click(screen.getByRole("button", { name: "下一页" }))
    await waitFor(() => expect(calls.some(c => c.url.includes("page=2"))).toBe(true))
  })
})

describe("行展开归属维度", () => {
  it("展开显示 execution/node/session/workflow 与 observability 跳转链接", async () => {
    await renderTab()
    fireEvent.click(screen.getAllByRole("button", { name: "展开归属" })[0])
    const detail = await screen.findByTestId("ledger-detail-r-priced")
    expect(detail.textContent).toContain("e-1")
    expect(detail.textContent).toContain("s-1")
    expect(detail.textContent).toContain("wf.yaml")
    const link = detail.querySelector("a")!
    expect(link.getAttribute("href")).toBe("/workspaces/ws-1/executions/e-1/observability")
  })
})
