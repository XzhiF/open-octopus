// 05 · 来源维度组件测试（billing-coverage-2 ticket 05 · vitest + jsdom，无浏览器 E2E）
// Seam: <BillingLedgerTab/> 来源列中文标签 / 筛选下拉 query 参数 / 顶部来源小计条换算。
// 手算期望：workflow 小计 cost_usd=0.75 ×汇率7 → ¥5.25；global_chat 全未定价 → cost NULL →「—」。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { BillingLedgerTab, sourcePathLabel, subtotalCostDisplay } from "@/components/system/billing/billing-ledger-tab"
import type { BillingCallRow, BillingSourceSubtotal } from "@/lib/billing-api"

interface FetchCall { url: string }
let calls: FetchCall[]

function srcRow(id: string, source: string | null, cost: number | null): BillingCallRow {
  return {
    id, node_execution_id: "e-1-n1", execution_id: "e-1", turn_index: 1, call_index: 0,
    model: "E2E_TEST_A", timestamp: 1700000000000,
    input_tokens: 100, output_tokens: 50, cache_read_tokens: 10, cache_creation_tokens: 5,
    cost_usd: cost, cost_native: cost, cost_currency: cost === null ? null : "USD",
    price_status: cost === null ? "unpriced" : "priced",
    workspace_id: "ws-1", workflow_ref: "wf.yaml", node_id: "n1", session_id: "s-1",
    source_path: source,
  }
}

const ROWS: BillingCallRow[] = [
  srcRow("r-wf", "workflow", 0.5),
  srcRow("r-ix", "interaction", 1),
  srcRow("r-ha", "harness", 0.125),
  srcRow("r-cc", "clone_chat", 2),
  srcRow("r-gc", "global_chat", null),
  srcRow("r-sc", "session_compress", 0.0625),
  srcRow("r-un", "unknown", 0.5),
  srcRow("r-null", null as unknown as string, 0.5), // 老行无 source 字段值 → 展示「未知」
]

const SUBTOTALS: BillingSourceSubtotal[] = [
  { source: "workflow", count: 3, priced_count: 2, cost_usd: 0.75 },
  { source: "global_chat", count: 1, priced_count: 0, cost_usd: null },
  { source: "unknown", count: 2, priced_count: 1, cost_usd: 0.5 },
]

function mockFetch(settings = { usd_to_cny: "7", display_currency: "CNY" }, subtotals: BillingSourceSubtotal[] | null = SUBTOTALS) {
  calls = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url)
    calls.push({ url: u })
    if (u.includes("/calls")) {
      return {
        ok: true, status: 200, json: async () => ({
          calls: ROWS, total: ROWS.length, page: 1, pageSize: 50, models: ["E2E_TEST_A"],
          ...(subtotals === null ? {} : { source_subtotals: subtotals }),
        }),
      }
    }
    if (u.includes("/settings")) return { ok: true, status: 200, json: async () => settings }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

async function renderTab(omitSubtotals = false) {
  mockFetch({ usd_to_cny: "7", display_currency: "CNY" }, omitSubtotals ? null : SUBTOTALS)
  render(<BillingLedgerTab />)
  await waitFor(() => expect(screen.getByTestId("source-badge-r-wf")).toBeDefined())
}

beforeEach(() => { vi.clearAllMocks() })

describe("纯函数 sourcePathLabel（中文标签逐值）", () => {
  it("七枚举值映射 + 未知/缺失兜底不报错", () => {
    expect(sourcePathLabel("workflow")).toBe("工作流")
    expect(sourcePathLabel("interaction")).toBe("交互")
    expect(sourcePathLabel("harness")).toBe("Harness")
    expect(sourcePathLabel("clone_chat")).toBe("分身聊天")
    expect(sourcePathLabel("global_chat")).toBe("全局聊天·主分身")
    expect(sourcePathLabel("session_compress")).toBe("会话压缩")
    expect(sourcePathLabel("unknown")).toBe("未知")
    expect(sourcePathLabel(null)).toBe("未知")
    expect(sourcePathLabel(undefined)).toBe("未知")
    expect(sourcePathLabel("weird_value")).toBe("未知")
  })
})

describe("纯函数 subtotalCostDisplay（小计换算 KD8/KD4）", () => {
  it("cost NULL（全未定价）→ legacy 占位不冒充 0；非 NULL → 按汇率折算", () => {
    expect(subtotalCostDisplay({ source: "global_chat", count: 1, priced_count: 0, cost_usd: null }, "CNY", 7)).toEqual({ kind: "legacy" })
    const d = subtotalCostDisplay({ source: "workflow", count: 3, priced_count: 2, cost_usd: 0.75 }, "CNY", 7)
    expect(d).toEqual({ kind: "amount", symbol: "¥", text: "5.25" })
  })
})

describe("表格来源列（AC：来源徽标渲染）", () => {
  it("八行来源各出正确中文标签；NULL 老行渲染「未知」不报错", async () => {
    await renderTab()
    const expectBadge = async (id: string, label: string) => {
      expect(screen.getByTestId(`source-badge-${id}`).textContent).toBe(label)
    }
    await expectBadge("r-wf", "工作流")
    await expectBadge("r-ix", "交互")
    await expectBadge("r-ha", "Harness")
    await expectBadge("r-cc", "分身聊天")
    await expectBadge("r-gc", "全局聊天·主分身")
    await expectBadge("r-sc", "会话压缩")
    await expectBadge("r-un", "未知")
    await expectBadge("r-null", "未知")
    expect(screen.getAllByText("来源").length).toBeGreaterThanOrEqual(2) // 列头 + 筛选下拉 Label
  })
})

describe("来源小计条（AC2 手算 + 口径注记）", () => {
  it("数字 = fixture 手算：workflow ¥5.25（0.75×7）3 条含未定价 1；global_chat「—」不冒充 0；unknown ¥3.5", async () => {
    await renderTab()
    const bar = screen.getByTestId("source-subtotals")
    expect(bar.textContent).toContain("来源小计")
    expect(screen.getByTestId("subtotal-workflow").textContent).toContain("工作流：¥5.25 · 3 条（含未定价 1）")
    expect(screen.getByTestId("subtotal-global_chat").textContent).toContain("全局聊天·主分身：— · 1 条（含未定价 1）")
    expect(screen.getByTestId("subtotal-unknown").textContent).toContain("未知：¥3.5 · 2 条")
    expect(bar.textContent).toContain("小计 = 已定价行求和") // 口径注记
  })

  it("响应不带 source_subtotals（旧服务端）→ 小计条隐藏，表格照常", async () => {
    await renderTab(true)
    expect(screen.queryByTestId("source-subtotals")).toBeNull()
    expect(screen.getByTestId("source-badge-r-wf")).toBeDefined()
  })
})

describe("筛选下拉（AC：query 参数正确）", () => {
  it("含七来源中文选项；切换 → GET 带 source_path；与其他筛选组合", async () => {
    await renderTab()
    for (const label of ["全部来源", "工作流", "交互", "Harness", "分身聊天", "全局聊天·主分身", "会话压缩", "未知"]) {
      expect(screen.getByRole("option", { name: label })).toBeDefined()
    }
    fireEvent.change(screen.getByLabelText("来源"), { target: { value: "session_compress" } })
    await waitFor(() => expect(calls.some(c => c.url.includes("source_path=session_compress"))).toBe(true))
    fireEvent.change(screen.getByLabelText("定价状态"), { target: { value: "unpriced" } })
    await waitFor(() => expect(calls.some(c => c.url.includes("source_path=session_compress") && c.url.includes("price_status=unpriced"))).toBe(true))
  })
})
