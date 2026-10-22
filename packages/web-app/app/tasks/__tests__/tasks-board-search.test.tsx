// 票06 S4 — 任务板前端最小搜索框「消费 q 参数」。
// 断言外部行为（expected 真相源 = 票面清单 #4：搜索框把关键词作为 q 传给 listTasks）：
//   ① 看板顶部有搜索输入框（消费面可见）；
//   ② 输入关键词 → listTasks 被以 { q: <关键词> } 再次调用（前端确实消费 q 参数、
//      走服务端过滤，而非仅本地字符串）；
//   ③ 清空输入 → 回到无 q 的全量列盘（q=undefined，回归保护）。
// 不断言卡片样式（任务板 UI 改版是 Out of Scope）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { Task } from "@octopus/shared"

vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: vi.fn(() => () => {}) }))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() } }))
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

function makeTask(id: string, status: string, semantic_summary?: string | null): Task {
  return {
    id, org: "default", name: `任务 ${id}`, status,
    task_spec: { goal: "g", ac: [], resources: [], authoring_resources: [] },
    authoring_resources: [], resources: [], skills: [], project_ids: [],
    version: 1, deleted_at: null,
    created_at: "2026-09-25T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
    execution: null, semantic_summary,
  } as unknown as Task
}

beforeEach(() => {
  vi.clearAllMocks()
  listTasksMock.mockResolvedValue({ items: [makeTask("a1", "done", "干了什么：做 actuator 端点")] })
})

describe("票06 看板搜索框消费 q 参数", () => {
  it("输入关键词 → listTasks 以 { q } 再调用（前端消费服务端 q 通道）", async () => {
    render(<TasksPage />)
    await screen.findByText("任务看板")
    const box = screen.getByTestId("task-search")
    fireEvent.change(box, { target: { value: "actuator" } })

    // 消费面：关键词作为 q 透传给 listTasks（服务端 LIKE 命中 name ∨ semantic_summary）。
    await vi.waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledWith({ q: "actuator" })
    })
  })

  it("清空输入 → 回到无 q 全量列盘（q=undefined）", async () => {
    render(<TasksPage />)
    await screen.findByText("任务看板")
    const box = screen.getByTestId("task-search")
    fireEvent.change(box, { target: { value: "  " } })
    await vi.waitFor(() => {
      expect(listTasksMock).toHaveBeenCalledWith({ q: undefined })
    })
  })
})
