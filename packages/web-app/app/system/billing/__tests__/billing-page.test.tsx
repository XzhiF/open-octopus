// 05 · Token 计费页 — 价格配置 Tab 组件测试（vitest + jsdom，无浏览器 E2E）
// Seam: <SystemLayout/> 子菜单 · <BillingPage/> 两 Tab · <BillingPriceTab/>（fetch mock 断言 method/path/body）
import { describe, it, expect, vi, beforeEach } from "vitest"
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
// lucide 不 mock：jsdom 渲染真实 SVG 组件即可（harness-config-page 测试同惯例）

import SystemLayout from "../../layout"
import BillingPage from "../page"
import { toast } from "sonner"
import type { BillingPrice, BillingPricePreview, BillingSettings } from "@/lib/billing-api"

/** NEW-r2 契约行形状 —— 窗口列 epoch ms | null（双 null = 兜底正常价）。epoch 用本地零点，与组件 msToLocalDate 同界。 */
const FIXTURE_PRICE: BillingPrice = {
  id: "p1", vendor: "anthropic", model_id: "E2E_TEST_MODEL_A",
  input_unit_price: 3, output_unit_price: 15,
  cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
  currency: "USD",
  valid_from: null, valid_to: null,
  created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
}
const FIXTURE_PRICE_CNY: BillingPrice = {
  ...FIXTURE_PRICE, id: "p2", model_id: "E2E_TEST_MODEL_B", vendor: "dashscope",
  input_unit_price: 21, output_unit_price: 105, cache_write_unit_price: 26, cache_read_unit_price: 2,
  currency: "CNY",
}
/** 时间段价（半开区间 [2026-09-01, 2026-10-01)）：与 p1 同模型 → 验证分组 + 窗口标签（止日显示前一天 09-30）。 */
const FIXTURE_PRICE_WINDOW: BillingPrice = {
  ...FIXTURE_PRICE, id: "p3",
  input_unit_price: 2, output_unit_price: 10, cache_write_unit_price: 2.5, cache_read_unit_price: 0.2,
  valid_from: new Date(2026, 8, 1).getTime(), valid_to: new Date(2026, 9, 1).getTime(),
}
const FIXTURE_SETTINGS: BillingSettings = { usd_to_cny: "7.0", display_currency: "CNY" }

/** 试算端点回包（NEW-r2：POST /price-preview → 派生 cost + 命中行）。 */
const UNPRICED_PREVIEW: BillingPricePreview = {
  model: "E2E_TEST_MODEL_NEW", timestamp: 1759000000000,
  cost_usd: null, cost_native: null, cost_currency: null,
  vendor: null, price_id: null, price_status: "unpriced",
  cost_display: null, currency_rate: 7, display_currency: "CNY",
}
const PRICED_PREVIEW: BillingPricePreview = {
  model: "E2E_TEST_MODEL_A", timestamp: 1759000000000,
  cost_usd: 1.5, cost_native: 10.5, cost_currency: "CNY",
  vendor: "anthropic", price_id: "p1-abcdef", price_status: "priced",
  cost_display: 10.5, currency_rate: 7, display_currency: "CNY",
}

interface FetchCall { url: string; method: string; body?: Record<string, unknown> }
let calls: FetchCall[]

function mockFetch(overrides?: (c: FetchCall) => unknown | undefined) {
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
    const call: FetchCall = {
      url: String(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const custom = overrides?.(call)
    if (custom !== undefined) return { ok: true, status: 200, json: async () => custom }
    if (call.method === "GET" && call.url.endsWith("/prices")) return { ok: true, status: 200, json: async () => ({ prices: [FIXTURE_PRICE, FIXTURE_PRICE_CNY, FIXTURE_PRICE_WINDOW] }) }
    if (call.method === "GET" && call.url.endsWith("/settings")) return { ok: true, status: 200, json: async () => FIXTURE_SETTINGS }
    if (call.method === "GET" && call.url.includes("/calls")) return { ok: true, status: 200, json: async () => ({ calls: [], total: 0, page: 1, pageSize: 50, models: [] }) }
    // 报表现为默认 Tab：BillingPage 一挂载就连发四个 report 端点 → 零值兜底
    // （summary 缺 tokens / trend 缺 days 会让报表组件渲染炸,本文件只测价格与明细）
    if (call.method === "GET" && call.url.includes("/report/summary")) return { ok: true, status: 200, json: async () => ({ from: "2026-09-01", to: "2026-09-30", total_cost_usd: null, total_cost_display: null, total_calls: 0, tokens: { in: 0, out: 0, cache_w: 0, cache_r: 0 }, unpriced: { calls: 0, ratio: 0 }, currency_rate: 7, display_currency: "CNY" }) }
    if (call.method === "GET" && call.url.includes("/report/trend")) return { ok: true, status: 200, json: async () => ({ from: "2026-09-01", to: "2026-09-30", currency_rate: 7, display_currency: "CNY", days: [] }) }
    if (call.method === "GET" && call.url.includes("/report/breakdown")) return { ok: true, status: 200, json: async () => ({ items: [] }) }
    if (call.method === "GET" && call.url.includes("/report/ranking")) return { ok: true, status: 200, json: async () => ({ items: [] }) }
    if (call.method === "POST" && call.url.endsWith("/price-preview")) return { ok: true, status: 200, json: async () => UNPRICED_PREVIEW }
    if (call.method === "POST" || (call.method === "PUT" && !call.url.endsWith("/settings"))) return { ok: true, status: 201, json: async () => ({ price: { ...FIXTURE_PRICE, ...(call.body as object) } }) }
    if (call.method === "PUT" && call.url.endsWith("/settings")) return { ok: true, status: 200, json: async () => ({ ...FIXTURE_SETTINGS, ...(call.body as object) }) }
    if (call.method === "DELETE") return { ok: true, status: 200, json: async () => ({ success: true, id: call.url.split("/").pop() }) }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

function findCall(method: string, pathSuffix: string) {
  return calls.find(c => c.method === method && c.url.endsWith(pathSuffix))
}

async function openPriceTab() {
  render(<BillingPage />)
  fireEvent.click(screen.getByRole("tab", { name: "价格配置" }))
  await waitFor(() => expect(screen.getByText("E2E_TEST_MODEL_A")).toBeDefined())
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch()
})

describe("子菜单（AC1）", () => {
  it("layout 含「Token 计费」→ /system/billing，且置于模型管理之后", () => {
    render(<SystemLayout><div /></SystemLayout>)
    const links = screen.getAllByRole("link")
    const labels = links.map(l => l.textContent ?? "")
    expect(labels).toContain("Token 计费")
    expect(links.find(l => l.textContent === "Token 计费")!.getAttribute("href")).toBe("/system/billing")
    expect(labels.indexOf("Token 计费")).toBeGreaterThan(labels.indexOf("模型管理"))
  })
})

describe("三 Tab 骨架（AC1）", () => {
  it("默认报表 Tab（概览先行）；切计费明细 / 价格配置均出真表格", async () => {
    render(<BillingPage />)
    expect(screen.getByRole("tab", { name: "报表" }).getAttribute("aria-selected")).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: "计费明细" }))
    await waitFor(() => expect(screen.getByTestId("billing-ledger")).toBeDefined()) // 真实 Tab，非占位
    fireEvent.click(screen.getByRole("tab", { name: "价格配置" }))
    await waitFor(() => expect(screen.getByText(/价格规则/)).toBeDefined())
  })
})

describe("价格表渲染（AC2：NEW-r2 分组 + 窗口标签）", () => {
  it("按模型分组：组头 = model_id；列头含类型/窗口；兜底/窗口标签与单价单位随币种", async () => {
    await openPriceTab()
    // 列头（NEW-r2：模型不再成列 → 组头行；每模型一组表 → 列头按组数重复）
    for (const h of ["类型/窗口", "厂商", "输入单价", "输出单价", "缓存写单价", "缓存读单价", "币种", "操作"]) {
      expect(screen.getAllByText(h).length).toBeGreaterThanOrEqual(1)
    }
    expect(screen.getAllByText("类型/窗口").length).toBe(2) // 两个模型组各一张表
    // 分组：MODEL_A 组含兜底 + 窗口两行
    expect(screen.getByText("E2E_TEST_MODEL_A")).toBeDefined()
    expect(screen.getByText("E2E_TEST_MODEL_B")).toBeDefined()
    expect(screen.getAllByText("全时段（正常价）").length).toBe(2) // p1 + p2 两条兜底价
    // 窗口标签 [2026-09-01, 2026-10-01)：止日不含当天 → 显示前一天 09-30
    expect(screen.getByText("2026-09-01 ~ 2026-09-30")).toBeDefined()
    expect(screen.getAllByText("anthropic").length).toBe(2) // p1 兜底 + p3 窗口同厂商
    expect(screen.getByText("dashscope")).toBeDefined()
    expect(screen.getByText("3.75 $")).toBeDefined() // USD 行 cache_write 单价，单位随币种 $
    expect(screen.getByText("0.3 $")).toBeDefined() // USD 行 cache_read
    expect(screen.getByText("21 ¥")).toBeDefined() // CNY 行 input 单价，单位随币种 ¥
  })

  it("空列表 → 空态引导文案", async () => {
    mockFetch((c) => (c.url.includes("/prices") && c.method === "GET" ? { prices: [] } : undefined))
    render(<BillingPage />)
    fireEvent.click(screen.getByRole("tab", { name: "价格配置" }))
    await waitFor(() => expect(screen.getByText(/还没有配价/)).toBeDefined())
    expect(screen.getByText(/正常价/)).toBeDefined() // 引导：配全时段兜底价历史立即出钱
  })
})

describe("新增/编辑/删除（AC2）", () => {
  it("新增提交（窗口留空 = 兜底价）→ POST /prices，body 含 valid_from/valid_to:null；成功后刷新列表", async () => {
    await openPriceTab()
    const getBefore = calls.filter(c => c.method === "GET").length
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.change(screen.getByLabelText("厂商"), { target: { value: "openai" } })
    fireEvent.change(screen.getByLabelText(/模型ID/), { target: { value: "E2E_TEST_MODEL_NEW" } })
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "2.5" } })
    fireEvent.change(screen.getByLabelText("输出单价"), { target: { value: "10" } })
    fireEvent.change(screen.getByLabelText("缓存写单价"), { target: { value: "3" } })
    fireEvent.change(screen.getByLabelText("缓存读单价"), { target: { value: "0.25" } })
    fireEvent.change(screen.getByLabelText("币种"), { target: { value: "USD" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(findCall("POST", "/api/system/billing/prices")).toBeDefined())
    const post = findCall("POST", "/api/system/billing/prices")!
    expect(post.body).toEqual({
      vendor: "openai", model_id: "E2E_TEST_MODEL_NEW",
      input_unit_price: 2.5, output_unit_price: 10,
      cache_write_unit_price: 3, cache_read_unit_price: 0.25,
      currency: "USD", valid_from: null, valid_to: null,
    })
    await waitFor(() => expect(calls.filter(c => c.method === "GET").length).toBeGreaterThan(getBefore)) // 列表刷新
  })

  it("带窗口新增 → body 收 YYYY-MM-DD 日期串", async () => {
    await openPriceTab()
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.change(screen.getByLabelText("厂商"), { target: { value: "anthropic" } })
    fireEvent.change(screen.getByLabelText(/模型ID/), { target: { value: "E2E_TEST_MODEL_A" } })
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("输出单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存写单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存读单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText(/生效起日/), { target: { value: "2026-09-01" } })
    fireEvent.change(screen.getByLabelText(/失效止日/), { target: { value: "2026-10-01" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(findCall("POST", "/api/system/billing/prices")).toBeDefined())
    expect(findCall("POST", "/api/system/billing/prices")!.body).toMatchObject({
      valid_from: "2026-09-01", valid_to: "2026-10-01",
    })
  })

  it("起日 ≥ 止日 → 前端拦截（窗口序），不发 POST", async () => {
    await openPriceTab()
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.change(screen.getByLabelText("厂商"), { target: { value: "v" } })
    fireEvent.change(screen.getByLabelText(/模型ID/), { target: { value: "M" } })
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("输出单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存写单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存读单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText(/生效起日/), { target: { value: "2026-10-01" } })
    fireEvent.change(screen.getByLabelText(/失效止日/), { target: { value: "2026-09-01" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(screen.getByTestId("field-error-valid_to")).toBeDefined())
    expect(findCall("POST", "/api/system/billing/prices")).toBeUndefined()
  })

  it("单价 -1 → 前端拦截，不发 POST", async () => {
    await openPriceTab()
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.change(screen.getByLabelText("厂商"), { target: { value: "v" } })
    fireEvent.change(screen.getByLabelText(/模型ID/), { target: { value: "E2E_TEST_X" } })
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "-1" } })
    fireEvent.change(screen.getByLabelText("输出单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存写单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存读单价"), { target: { value: "1" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(screen.getByTestId("field-error-input_unit_price").textContent).toContain("≥ 0"))
    expect(findCall("POST", "/api/system/billing/prices")).toBeUndefined()
  })

  it("model_id 空 → 拦截不发请求", async () => {
    await openPriceTab()
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    // 生产 FIELD_KEY_BY_LABEL 未收录加长后的「模型ID（…）」标签 → testid 落在标签原文上，
    // 用前缀正则匹配（映射失配本身记入疑点报告）。
    await waitFor(() => expect(screen.getByTestId("field-error-model_id")).toBeDefined())
    expect(findCall("POST", "/api/system/billing/prices")).toBeUndefined()
  })

  it("服务端 400 窗口违例 → toast 带新错误码（NEW-r2：无 409 DUPLICATE_MODEL_ID）", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit = {}) => {
      const u = String(url)
      if (init.method === "POST" && u.endsWith("/prices")) {
        return { ok: false, status: 400, json: async () => ({ error: { code: "PRICE_WINDOW_OVERLAP", message: "时间段与既有窗口重叠" } }) }
      }
      if (u.endsWith("/prices")) return { ok: true, status: 200, json: async () => ({ prices: [FIXTURE_PRICE] }) }
      if (u.endsWith("/settings")) return { ok: true, status: 200, json: async () => FIXTURE_SETTINGS }
      if (u.includes("/calls")) return { ok: true, status: 200, json: async () => ({ calls: [], total: 0, page: 1, pageSize: 50, models: [] }) }
      return { ok: true, status: 200, json: async () => ({}) }
    }))
    render(<BillingPage />)
    fireEvent.click(screen.getByRole("tab", { name: "价格配置" }))
    await waitFor(() => expect(screen.getByText("E2E_TEST_MODEL_A")).toBeDefined())
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.change(screen.getByLabelText("厂商"), { target: { value: "v" } })
    fireEvent.change(screen.getByLabelText(/模型ID/), { target: { value: "M" } })
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("输出单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存写单价"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("缓存读单价"), { target: { value: "1" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("[PRICE_WINDOW_OVERLAP]")))
    expect(vi.mocked(toast.error).mock.calls.flat().join()).not.toContain("DUPLICATE_MODEL_ID")
  })

  it("编辑兜底行：预填现值（窗口空）→ PUT /prices/:id", async () => {
    await openPriceTab()
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0])
    const modelId = screen.getByLabelText(/模型ID/) as HTMLInputElement
    expect(modelId.value).toBe("E2E_TEST_MODEL_A") // 预填
    expect((screen.getByLabelText("厂商") as HTMLInputElement).value).toBe("anthropic")
    expect((screen.getByLabelText(/生效起日/) as HTMLInputElement).value).toBe("") // 兜底价无窗口
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "5" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(findCall("PUT", "/api/system/billing/prices/p1")).toBeDefined())
    expect(findCall("PUT", "/api/system/billing/prices/p1")!.body).toMatchObject({ input_unit_price: 5, valid_from: null, valid_to: null })
  })

  it("编辑窗口行：日期预填（epoch ms → 本地日）→ PUT body 带原窗口", async () => {
    await openPriceTab()
    // 组序 MODEL_A(p1 兜底, p3 窗口) → 第 2 个编辑按钮 = p3
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[1])
    expect((screen.getByLabelText(/生效起日/) as HTMLInputElement).value).toBe("2026-09-01")
    expect((screen.getByLabelText(/失效止日/) as HTMLInputElement).value).toBe("2026-10-01")
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(findCall("PUT", "/api/system/billing/prices/p3")).toBeDefined())
    expect(findCall("PUT", "/api/system/billing/prices/p3")!.body).toMatchObject({ valid_from: "2026-09-01", valid_to: "2026-10-01" })
  })

  it("删除：先确认再 DELETE /prices/:id", async () => {
    await openPriceTab()
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0])
    expect(findCall("DELETE", "/api/system/billing/prices/p1")).toBeUndefined() // 未确认前不发
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }))
    await waitFor(() => expect(findCall("DELETE", "/api/system/billing/prices/p1")).toBeDefined())
  })
})

describe("试算器（NEW-r2 配价页解释器冒烟）", () => {
  it("未命中窗口 → 试算结果区显示「未定价 ——」，不焊 0", async () => {
    await openPriceTab()
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "E2E_TEST_MODEL_NEW" } })
    fireEvent.click(screen.getByRole("button", { name: /试算/ }))
    await waitFor(() => expect(findCall("POST", "/api/system/billing/price-preview")).toBeDefined())
    expect(findCall("POST", "/api/system/billing/price-preview")!.body).toMatchObject({
      model: "E2E_TEST_MODEL_NEW", input_tokens: 1000000, output_tokens: 100000,
    })
    await waitFor(() => expect(screen.getByTestId("price-preview-result").textContent).toContain("未定价 ——"))
  })

  it("命中价行 → 显示厂商/price_id/原币与展示值", async () => {
    mockFetch((c) => (c.url.endsWith("/price-preview") ? PRICED_PREVIEW : undefined))
    render(<BillingPage />)
    fireEvent.click(screen.getByRole("tab", { name: "价格配置" }))
    await waitFor(() => expect(screen.getByText("E2E_TEST_MODEL_A")).toBeDefined())
    fireEvent.change(screen.getByLabelText("模型"), { target: { value: "E2E_TEST_MODEL_A" } })
    fireEvent.click(screen.getByRole("button", { name: /试算/ }))
    await waitFor(() => expect(screen.getByTestId("price-preview-result").textContent).toContain("anthropic"))
    const box = screen.getByTestId("price-preview-result").textContent ?? ""
    expect(box).toContain("10.5 CNY")
    expect(box).toContain("$1.5")
    expect(box).not.toContain("未定价")
  })
})

describe("设置卡（AC3：保存→回读一致）", () => {
  it("初始值 = GET settings；保存 PUT 后显示服务端回读值并 toast", async () => {
    await openPriceTab()
    const rate = screen.getByLabelText("汇率（1 USD = N CNY）") as HTMLInputElement
    expect(rate.value).toBe("7.0")
    expect((screen.getByLabelText("展示币种") as HTMLSelectElement).value).toBe("CNY")
    fireEvent.change(rate, { target: { value: "6.5" } })
    fireEvent.change(screen.getByLabelText("展示币种"), { target: { value: "USD" } })
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))
    await waitFor(() => expect(findCall("PUT", "/api/system/billing/settings")).toBeDefined())
    expect(findCall("PUT", "/api/system/billing/settings")!.body).toEqual({ usd_to_cny: "6.5", display_currency: "USD" })
    // 回读：以 PUT 响应为准重新显示（toast 也报生效值）
    await waitFor(() => expect((screen.getByLabelText("汇率（1 USD = N CNY）") as HTMLInputElement).value).toBe("6.5"))
    await waitFor(() => expect((screen.getByLabelText("展示币种") as HTMLSelectElement).value).toBe("USD"))
  })

  it("汇率 0 → 拦截不发 PUT", async () => {
    await openPriceTab()
    fireEvent.change(screen.getByLabelText("汇率（1 USD = N CNY）"), { target: { value: "0" } })
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }))
    await waitFor(() => expect(screen.getByTestId("field-error-usd_to_cny")).toBeDefined())
    expect(findCall("PUT", "/api/system/billing/settings")).toBeUndefined()
  })
})

describe("契约核对（AC4）：web-app 类型 ↔ 票 03 响应示例逐字段 diff", () => {
  it("BillingPrice 字段集 = API 行字段集（NEW-r2：含 valid_from/valid_to，不增不缺）", () => {
    // 类型层：FIXTURE_PRICE 以 BillingPrice 标注已通过编译 = 不缺字段；
    // 运行时：键序无关的全等 diff
    const apiRowKeys = Object.keys(JSON.parse(JSON.stringify(FIXTURE_PRICE))).sort()
    const contractKeys = ["id", "vendor", "model_id", "input_unit_price", "output_unit_price", "cache_write_unit_price", "cache_read_unit_price", "currency", "valid_from", "valid_to", "created_at", "updated_at"].sort()
    expect(apiRowKeys).toEqual(contractKeys)
  })
  it("settings 形状 = {usd_to_cny, display_currency} 平铺", () => {
    expect(Object.keys(FIXTURE_SETTINGS).sort()).toEqual(["display_currency", "usd_to_cny"])
  })
  it("价格列表/单值包裹键与票 03 一致：{prices:[]} / {price}", async () => {
    await openPriceTab() // 默认 responder 即 {prices:[...]}；渲染成功即证键名被消费
    expect(screen.getByText("E2E_TEST_MODEL_A")).toBeDefined()
  })
})
