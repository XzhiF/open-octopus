// v49 看板成本统计：列头成本 chip + 页级合计，**草稿列也算**（草稿的钱挂在作者会话上，
// 由读模型 GET /api/tasks 的 ai_usage 带出）。断言三件事：
//   ① 列 chip = 该列各任务 ai_usage 合并（不是取平均）；
//   ② 金额跟随计费设置币种（这里 mock 成 CNY ×7）；
//   ③ 无账本的列不出 chip（不显示假 ¥0）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import type { Task, LlmUsageSummary } from "@octopus/shared"

vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: vi.fn(() => () => {}) }))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() } }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("") }))
vi.mock("@/components/tasks/task-modal", () => ({ TaskModal: () => null }))
vi.mock("@/components/tasks/trigger-dialog", () => ({ TriggerDialog: () => null }))
vi.mock("@/lib/billing-currency", () => ({
  useBillingCurrency: () => ({ currency: "CNY", rate: 7 }),
  billingCurrency: () => ({ currency: "CNY", rate: 7 }),
}))

const { listTasksMock } = vi.hoisted(() => ({ listTasksMock: vi.fn() }))
vi.mock("@/lib/tasks-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tasks-api")>("@/lib/tasks-api")
  return {
    ...actual,
    listTasks: listTasksMock,
    getTask: vi.fn(),
    deleteTask: vi.fn(),
    postAdvance: vi.fn(),
    postArchiveRetry: vi.fn(),
  }
})

import TasksPage from "../page"

function usage(inputTokens: number, cacheRead: number, usd: number): LlmUsageSummary {
  const u = { inputTokens, outputTokens: 200, cacheReadTokens: cacheRead, cacheCreationTokens: 10 }
  const tokens = inputTokens + 200 + cacheRead + 10
  return {
    totalCalls: 2,
    usage: u,
    totals: { tokens, cost: { usd, complete: true }, cacheHitRate: cacheRead / (inputTokens + cacheRead) },
  }
}

function makeTask(id: string, status: string, aiUsage?: LlmUsageSummary): Task {
  return {
    id, org: "default", name: `任务 ${id}`, status,
    task_spec: { goal: "g", ac: [], resources: [], authoring_resources: [] },
    authoring_resources: [], resources: [], skills: [], project_ids: [],
    version: 1, deleted_at: null,
    created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
    execution: null, ai_usage: aiUsage,
  } as unknown as Task
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("看板列成本 chip", () => {
  it("草稿列出 chip，金额 = 该列两任务合并后的 USD × 汇率", async () => {
    listTasksMock.mockResolvedValue({
      items: [
        makeTask("t-d1", "draft", usage(1000, 3000, 0.01)),
        makeTask("t-d2", "draft", usage(2000, 1000, 0.02)),
        makeTask("t-r1", "running"),
      ],
    })
    const { container } = render(<TasksPage />)
    await screen.findByText("任务看板")

    const chip = container.querySelector('[data-col-usage="draft"]')!
    expect(chip.textContent).toBe("¥0.21") // (0.01+0.02)×7
    expect(chip.getAttribute("title")).toContain("4 次请求")

    // 页级合计 = 全列合并（草稿有账、执行中无账 → 仍是 0.03×7）
    expect(container.querySelector("[data-board-usage]")!.textContent).toBe("¥0.21")
  })

  it("整列无账本 → 不出 chip（¥0 是假数据）", async () => {
    listTasksMock.mockResolvedValue({ items: [makeTask("t-r1", "running")] })
    const { container } = render(<TasksPage />)
    await screen.findByText("任务看板")
    expect(container.querySelector("[data-col-usage]")).toBeNull()
    expect(container.querySelector("[data-board-usage]")).toBeNull()
  })

  it("部分定价（complete=false）→ 金额带 ≈ 前缀", async () => {
    const partial = usage(1000, 0, 0.01)
    partial.totals.cost.complete = false
    listTasksMock.mockResolvedValue({ items: [makeTask("t-d1", "draft", partial)] })
    const { container } = render(<TasksPage />)
    await screen.findByText("任务看板")
    expect(container.querySelector("[data-col-usage='draft']")!.textContent).toBe("≈¥0.07")
  })
})
