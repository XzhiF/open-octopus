// 任务看板页的 SSE 订阅面（票05 契约回归）：
//   · task_status / task_execution / task_trigger / task_trigger_failed 全部以
//     shared 常量注册（值即事件名 —— registry 键断言同时钉住「无裸字面量漂移」）。
//   · task_trigger_failed 是「到点但起不来」的唯一 UI 出口（toast 一行 reason）：
//     载荷字段词汇由 shared schema 把关 —— {action} 旧形状/坏 JSON 一律静默忽略，
//     合法事件无论 toast 与否都整盘刷新（游标已在服务端退休，盘面必须重读）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act } from "@testing-library/react"
import type { Task } from "@octopus/shared"

const sseListeners = new Map<string, (e: { data: string }) => void>()
vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn(
    (_url: string, eventType: string, listener: (e: { data: string }) => void) => {
      sseListeners.set(eventType, listener)
      return () => { sseListeners.delete(eventType) }
    },
  ),
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}))
vi.mock("sonner", () => ({ toast: toastMock }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}))

// 弹窗/对话框组件与本页 SSE 断言无关，桩掉免拖入 Radix/ReactFlow 全家桶。
vi.mock("@/components/tasks/task-modal", () => ({ TaskModal: () => null }))
vi.mock("@/components/tasks/trigger-dialog", () => ({ TriggerDialog: () => null }))
vi.mock("@/components/tasks/acceptance-modal", () => ({ AcceptanceModal: () => null }))

const { listTasksMock } = vi.hoisted(() => ({ listTasksMock: vi.fn() }))
vi.mock("@/lib/tasks-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tasks-api")>("@/lib/tasks-api")
  return { ...actual, listTasks: listTasksMock, deleteTask: vi.fn(), getTask: vi.fn(), postAdvance: vi.fn(), postArchiveRetry: vi.fn() }
})

import TasksPage from "../page"

function makeTask(id: string): Task {
  return {
    id, org: "default", name: `任务 ${id}`, status: "ready",
    task_spec: { goal: "g", ac: [], resources: [], authoring_resources: [] },
    authoring_resources: [], resources: [], skills: [], project_ids: [],
    version: 1, deleted_at: null,
    created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z",
    trigger_mode: "cron", trigger_at: null, cron_expression: "0 9 * * *",
    cron_timezone: "Asia/Shanghai", trigger_enabled: true,
    next_fire_at: null, last_fired_at: null, execution: null,
  } as unknown as Task
}

function dispatch(eventType: string, data: unknown): void {
  const listener = sseListeners.get(eventType)
  if (!listener) throw new Error(`no SSE listener registered for "${eventType}"`)
  listener({ data: typeof data === "string" ? data : JSON.stringify(data) })
}

beforeEach(() => {
  sseListeners.clear()
  vi.clearAllMocks()
  listTasksMock.mockResolvedValue({ items: [makeTask("t-board")] })
})

describe("TasksPage SSE 订阅", () => {
  it("registers the task-domain events via the shared constant names", async () => {
    render(<TasksPage />)
    await screen.findByText("任务看板")
    // 值 = 事件名（shared 单源）：断言 registry 键即断言常量没被字面量顶替。
    expect(sseListeners.has("task_status")).toBe(true)
    expect(sseListeners.has("task_execution")).toBe(true)
    expect(sseListeners.has("task_trigger")).toBe(true)
    expect(sseListeners.has("task_trigger_failed")).toBe(true)
  })

  it("task_trigger_failed（盘面任务）→ 一行 reason toast + 重读盘面", async () => {
    render(<TasksPage />)
    await screen.findByText("任务看板")
    const before = listTasksMock.mock.calls.length

    await act(async () => {
      dispatch("task_trigger_failed", {
        task_id: "t-board", reason: "phase spec 文件不存在", trigger_mode: "cron",
      })
    })
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("phase spec 文件不存在"))
    expect(listTasksMock.mock.calls.length).toBeGreaterThan(before)
  })

  it("坏载荷（旧 {action} 形状 / 非 JSON）→ 静默，不 toast 也不刷新", async () => {
    render(<TasksPage />)
    await screen.findByText("任务看板")
    const before = listTasksMock.mock.calls.length

    await act(async () => {
      dispatch("task_trigger_failed", { task_id: "t-board", reason: "x", action: "cron" })
    })
    await act(async () => {
      dispatch("task_trigger_failed", "not json")
    })
    expect(toastMock.error).not.toHaveBeenCalled()
    // 整盘轮询也可能触发 refetch —— 只断言「没被事件额外触发」：给 10s 轮询留窗口，
    // 这里 calls 增量应为 0（fake timers 未启用，10s 远未到）。
    expect(listTasksMock.mock.calls.length).toBe(before)
  })

  it("非盘面任务的合法事件 → 静默：不弹别人的 toast，也不触发刷新", async () => {
    render(<TasksPage />)
    await screen.findByText("任务看板")
    const before = listTasksMock.mock.calls.length

    await act(async () => {
      dispatch("task_trigger_failed", { task_id: "other", reason: "别人的失败", trigger_mode: "once" })
    })
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(listTasksMock.mock.calls.length).toBe(before)
  })
})
