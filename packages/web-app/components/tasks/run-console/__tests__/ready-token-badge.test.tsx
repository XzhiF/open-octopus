// 票10 — ready 右栏账台角标（原型 ⓬ railReady .tok-chip.rail）。
// 钉三态与浮层纪律：
//   ① 有账（source_chat_session_id + llm-calls 非零）→ 角标 = tok/cache/成本/▾（同草稿 chip 形制）；
//   ② 无会话 id → 不 fetch、不渲染（仿 chip 短路，无空壳）；
//   ③ 空账（totalCalls=0，含取数失败兜底零值）→ 不渲染，不出现「tok 0」假数据；
//   ④ 展开 = SessionCostLedger 明细单源（命中率 + 「完整台账」target=_blank），
//      portal 挂 body 不推挤右栏（触发钮 DOM 原样在场）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { LlmUsageAggregates } from "@octopus/shared"
import { ReadyTokenBadge } from "../ready-token-badge"

const mockFetchSessionLLMCalls = vi.fn()
vi.mock("@/lib/observability-api", () => ({
  fetchSessionLLMCalls: (id: string) => mockFetchSessionLLMCalls(id),
}))
vi.mock("@/lib/billing-currency", () => ({
  useBillingCurrency: () => ({ currency: "CNY", rate: 7 }),
}))
vi.mock("next/link", () => ({
  // 透传 href/target/rel 成真 <a>，钉「完整台账」新标签页行为（1e842875 同款，随 body 白拿）
  default: (props: { children: ReactNode; href?: string; target?: string; rel?: string }) => (
    <a href={props.href} target={props.target} rel={props.rel}>{props.children}</a>
  ),
}))

// 与草稿 chip 测试同一独立样本：totals 174.6K / 命中率 63.1%（分母含缓存写，ADR-0027）/ $0.4583→¥3.21
const USAGE: LlmUsageAggregates = {
  totalCalls: 30,
  usage: { inputTokens: 45200, outputTokens: 18700, cacheReadTokens: 98400, cacheCreationTokens: 12300 },
  totals: { tokens: 174600, cost: { usd: 0.4583, complete: true }, cacheHitRate: 98400 / (45200 + 98400 + 12300) },
  modelBreakdown: {
    "claude-sonnet-4.5": {
      calls: 24, inputTokens: 41000, outputTokens: 16200, cacheReadTokens: 98400, cacheCreationTokens: 12300,
      costUsd: 0.4416,
    },
  },
}
const EMPTY_AGG: LlmUsageAggregates = {
  totalCalls: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  totals: { tokens: 0, cost: { usd: null, complete: true }, cacheHitRate: null },
  modelBreakdown: {},
}

beforeEach(() => {
  mockFetchSessionLLMCalls.mockReset()
})

describe("ReadyTokenBadge — 三态短路", () => {
  it("有账 → 角标渲染 tok 总量 + cache 命中率 + 成本 + ▾（同 chip 形制）", async () => {
    mockFetchSessionLLMCalls.mockResolvedValue({ data: [], aggregates: USAGE })
    render(<ReadyTokenBadge sessionId="sess-1" />)
    const chip = await screen.findByTestId("ready-token-badge")
    expect(chip.textContent).toContain("tok 174.6K")
    expect(chip.textContent).toContain("cache 63.1%")
    expect(chip.textContent).toContain("¥3.21")
    expect(chip.textContent).toContain("▾")
    expect(mockFetchSessionLLMCalls).toHaveBeenCalledWith("sess-1")
  })

  it("无会话 id → 不 fetch、不渲染（无缝，无空壳）", () => {
    render(<ReadyTokenBadge sessionId={null} />)
    expect(screen.queryByTestId("ready-token-badge")).toBeNull()
    expect(mockFetchSessionLLMCalls).not.toHaveBeenCalled()
  })

  it("空账（totalCalls=0，取数失败兜底同形）→ 不渲染，不出现「tok 0」假数据", async () => {
    mockFetchSessionLLMCalls.mockResolvedValue({ data: [], aggregates: EMPTY_AGG })
    render(<ReadyTokenBadge sessionId="sess-1" />)
    await waitFor(() => expect(mockFetchSessionLLMCalls).toHaveBeenCalled())
    expect(screen.queryByTestId("ready-token-badge")).toBeNull()
  })

  it("取数抛错（网络层 reject）→ 静默不渲染，不砸右栏", async () => {
    mockFetchSessionLLMCalls.mockRejectedValue(new Error("network down"))
    render(<ReadyTokenBadge sessionId="sess-1" />)
    await waitFor(() => expect(mockFetchSessionLLMCalls).toHaveBeenCalled())
    expect(screen.queryByTestId("ready-token-badge")).toBeNull()
  })
})

describe("ReadyTokenBadge — 展开账台（明细单源 + 不推挤）", () => {
  const mountWithLedger = async () => {
    mockFetchSessionLLMCalls.mockResolvedValue({ data: [], aggregates: USAGE })
    const view = render(<ReadyTokenBadge sessionId="sess-1" />)
    const chip = await view.findByTestId("ready-token-badge")
    return { ...view, chip }
  }

  it("点开 → SessionCostLedger 明细：四分项 + 命中率（ADR-0027 口径 63.1%）+ 按模型 + 「完整台账」新标签", async () => {
    const { chip } = await mountWithLedger()
    fireEvent.click(chip)
    const panel = await screen.findByText("本会话 token 账")
    expect(panel).toBeTruthy()
    const body = document.querySelector('[data-slot="popover-content"]')
    expect(body?.textContent).toContain("缓存命中率")
    expect(body?.textContent).toContain("63.1%")
    expect(body?.textContent).toContain("claude-sonnet-4.5")
    // 「完整台账」target=_blank 随 body 单源白拿（1e842875 同款，不顶掉弹窗）
    const ledgerLink = screen.getByText(/完整台账/)
    expect(ledgerLink).toHaveAttribute("target", "_blank")
    expect(ledgerLink).toHaveAttribute("rel", "noopener")
  })

  it("浮层 portal 挂 body —— 触发钮原样在场，右栏子树零推挤（AC4）", async () => {
    const { container, chip } = await mountWithLedger()
    const parent = chip.parentElement as HTMLElement
    const idx = Array.prototype.indexOf.call(parent.children, chip)
    fireEvent.click(chip)
    await screen.findByText("本会话 token 账")
    const panel = document.querySelector('[data-slot="popover-content"]')
    expect(panel).toBeTruthy()
    // 面板在 portal（角标容器子树之外）→ 结构上不可能挤动 rail 布局；
    // 注：Radix asChild 会把 data-state 合进触发钮本身（属性抖，非 DOM 位移）。
    expect(container.contains(panel)).toBe(false)
    expect(parent.querySelector('[data-slot="popover-content"]')).toBeNull()
    // 触发钮不动：同一节点、同一父、同一子序。
    expect(chip.isConnected).toBe(true)
    expect(chip.parentElement).toBe(parent)
    expect(Array.prototype.indexOf.call(parent.children, chip)).toBe(idx)
  })
})
