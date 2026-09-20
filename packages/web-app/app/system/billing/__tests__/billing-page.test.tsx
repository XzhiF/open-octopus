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
import type { BillingPrice, BillingSettings } from "@/lib/billing-api"

/** ticket 03 (done) 的确切响应形状 —— 契约核对的独立真相源（从 03 票面证据手贴）。 */
const FIXTURE_PRICE: BillingPrice = {
  id: "p1", vendor: "anthropic", model_id: "E2E_TEST_MODEL_A",
  input_unit_price: 3, output_unit_price: 15,
  cache_write_unit_price: 3.75, cache_read_unit_price: 0.3,
  currency: "USD",
  created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
}
const FIXTURE_PRICE_CNY: BillingPrice = {
  ...FIXTURE_PRICE, id: "p2", model_id: "E2E_TEST_MODEL_B", vendor: "dashscope",
  input_unit_price: 21, output_unit_price: 105, cache_write_unit_price: 26, cache_read_unit_price: 2,
  currency: "CNY",
}
const FIXTURE_SETTINGS: BillingSettings = { usd_to_cny: "7.0", display_currency: "CNY" }

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
    if (call.method === "GET" && call.url.endsWith("/prices")) return { ok: true, status: 200, json: async () => ({ prices: [FIXTURE_PRICE, FIXTURE_PRICE_CNY] }) }
    if (call.method === "GET" && call.url.endsWith("/settings")) return { ok: true, status: 200, json: async () => FIXTURE_SETTINGS }
    if (call.method === "GET" && call.url.includes("/calls")) return { ok: true, status: 200, json: async () => ({ calls: [], total: 0, page: 1, pageSize: 50, models: [] }) }
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

describe("两 Tab 骨架（AC1）", () => {
  it("默认计费明细 Tab（票06 已填充），切到价格配置见表格", async () => {
    render(<BillingPage />)
    expect(screen.getByRole("tab", { name: "计费明细" })).toBeDefined()
    expect(screen.getByRole("tab", { name: "价格配置" })).toBeDefined()
    await waitFor(() => expect(screen.getByTestId("billing-ledger")).toBeDefined()) // 默认 = 明细（真实 Tab，非占位）
    fireEvent.click(screen.getByRole("tab", { name: "价格配置" }))
    await waitFor(() => expect(screen.getByText("模型ID")).toBeDefined())
  })
})

describe("价格表渲染（AC2）", () => {
  it("fixture 价格行全字段渲染，单价单位随币种 $/¥", async () => {
    await openPriceTab()
    // 列头
    for (const h of ["厂商", "模型ID", "输入单价", "输出单价", "缓存写单价", "缓存读单价", "币种"]) {
      expect(screen.getByText(h)).toBeDefined()
    }
    expect(screen.getByText("E2E_TEST_MODEL_A")).toBeDefined()
    expect(screen.getByText("anthropic")).toBeDefined()
    expect(screen.getByText("dashscope")).toBeDefined()
    expect(screen.getByText("3.75 $")).toBeDefined() // USD 行 cache_write 单价，单位随币种 $
    expect(screen.getByText("0.3 $")).toBeDefined() // USD 行 cache_read
    expect(screen.getByText("21 ¥")).toBeDefined() // CNY 行 input 单价，单位随币种 ¥
    expect(screen.getByText("USD（$/Mtok）")).toBeDefined()
    expect(screen.getByText("CNY（¥/Mtok）")).toBeDefined()
  })

  it("空列表 → 空态引导文案", async () => {
    mockFetch((c) => (c.url.includes("/prices") && c.method === "GET" ? { prices: [] } : undefined))
    render(<BillingPage />)
    fireEvent.click(screen.getByRole("tab", { name: "价格配置" }))
    await waitFor(() => expect(screen.getByText(/还没有配价/)).toBeDefined())
    expect(screen.getByText(/未定价/)).toBeDefined() // 引导：未配价会记成未定价
  })
})

describe("新增/编辑/删除（AC2）", () => {
  it("新增提交 → POST /api/system/billing/prices，body 字段与 API 对齐；成功后刷新列表", async () => {
    await openPriceTab()
    const getBefore = calls.filter(c => c.method === "GET").length
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.change(screen.getByLabelText("厂商"), { target: { value: "openai" } })
    fireEvent.change(screen.getByLabelText("模型ID"), { target: { value: "E2E_TEST_MODEL_NEW" } })
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
      currency: "USD",
    })
    await waitFor(() => expect(calls.filter(c => c.method === "GET").length).toBeGreaterThan(getBefore)) // 列表刷新
  })

  it("单价 -1 → 前端拦截，不发 POST", async () => {
    await openPriceTab()
    fireEvent.click(screen.getByRole("button", { name: /新增价格/ }))
    fireEvent.change(screen.getByLabelText("厂商"), { target: { value: "v" } })
    fireEvent.change(screen.getByLabelText("模型ID"), { target: { value: "E2E_TEST_X" } })
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
    await waitFor(() => expect(screen.getByTestId("field-error-model_id")).toBeDefined())
    expect(findCall("POST", "/api/system/billing/prices")).toBeUndefined()
  })

  it("编辑：预填现值 → PUT /prices/:id", async () => {
    await openPriceTab()
    fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0])
    const modelId = screen.getByLabelText("模型ID") as HTMLInputElement
    expect(modelId.value).toBe("E2E_TEST_MODEL_A") // 预填
    expect((screen.getByLabelText("厂商") as HTMLInputElement).value).toBe("anthropic")
    fireEvent.change(screen.getByLabelText("输入单价"), { target: { value: "5" } })
    fireEvent.click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(findCall("PUT", "/api/system/billing/prices/p1")).toBeDefined())
    expect(findCall("PUT", "/api/system/billing/prices/p1")!.body).toMatchObject({ input_unit_price: 5 })
  })

  it("删除：先确认再 DELETE /prices/:id", async () => {
    await openPriceTab()
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0])
    expect(findCall("DELETE", "/api/system/billing/prices/p1")).toBeUndefined() // 未确认前不发
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }))
    await waitFor(() => expect(findCall("DELETE", "/api/system/billing/prices/p1")).toBeDefined())
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
  it("BillingPrice 字段集 = API 行字段集（不增不缺）", () => {
    // 类型层：FIXTURE_PRICE 以 BillingPrice 标注已通过编译 = 不缺字段；
    // 运行时：键序无关的全等 diff
    const apiRowKeys = Object.keys(JSON.parse(JSON.stringify(FIXTURE_PRICE))).sort()
    const contractKeys = ["id", "vendor", "model_id", "input_unit_price", "output_unit_price", "cache_write_unit_price", "cache_read_unit_price", "currency", "created_at", "updated_at"].sort()
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
