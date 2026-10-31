// useChatTasks — 侧栏任务列表口径（2026-10-29）：
//   ① v4 派生状态覆盖持久态；② 按创建时间新 → 旧排序（用户点名）。
// 依赖全部 mock：listTasks / getTask / SSE。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { TaskView } from "@/lib/tasks-api"

const { listTasks, getTask } = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
}))

vi.mock("@/lib/tasks-api", () => ({ listTasks, getTask }))
vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: () => () => {} }))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://127.0.0.1:3001" }))

import { useChatTasks } from "../use-chat-tasks"

function task(partial: Partial<TaskView> & Pick<TaskView, "id" | "name" | "created_at">): TaskView {
  return {
    repo_group: "xzf",
    status: "draft",
    task_spec: { format: "v4" } as TaskView["task_spec"],
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workspace_id: null,
    version: 1,
    source_chat_session_id: `sess-${partial.id}`,
    doer_session_id: null,
    semantic_summary: null,
    deleted_at: null,
    updated_at: partial.created_at,
    completed_at: null,
    trigger_mode: "manual",
    trigger_at: null,
    cron_expression: null,
    cron_timezone: "Asia/Shanghai",
    trigger_enabled: true,
    next_fire_at: null,
    last_fired_at: null,
    execution: null,
    ai_usage: null,
    ...partial,
  } as TaskView
}

function derived(status: string) {
  return { isV4: true, taskStatus: status, phaseViews: [] }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useChatTasks", () => {
  it("按创建时间新 → 旧排序（服务端返回顺序不决定侧栏顺序）", async () => {
    const older = task({ id: "t-old", name: "旧任务", created_at: "2026-10-28T01:00:00.000Z" })
    const newest = task({ id: "t-new", name: "新任务", created_at: "2026-10-29T09:00:00.000Z" })
    const middle = task({ id: "t-mid", name: "中间任务", created_at: "2026-10-29T02:00:00.000Z" })
    listTasks.mockResolvedValue({ items: [older, newest, middle] })
    getTask.mockImplementation(async (id: string) => ({
      derived: derived(id === "t-new" ? "ready" : "draft"),
    }))

    const { result } = renderHook(() => useChatTasks())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.tasks.map((t) => t.id)).toEqual(["t-new", "t-mid", "t-old"])
  })

  it("派生状态覆盖持久态；draft 无会话的不进侧栏", async () => {
    const draftWithSession = task({ id: "t-a", name: "A", created_at: "2026-10-29T01:00:00.000Z" })
    const legacyDraft = task({
      id: "t-b", name: "B", created_at: "2026-10-29T02:00:00.000Z", source_chat_session_id: null,
    })
    const runningMirrored = task({
      id: "t-c", name: "C", created_at: "2026-10-29T03:00:00.000Z", status: "running",
    })
    listTasks.mockResolvedValue({ items: [draftWithSession, legacyDraft, runningMirrored] })
    getTask.mockImplementation(async (id: string) => ({ derived: derived(id === "t-c" ? "awaiting_review" : "draft") }))

    const { result } = renderHook(() => useChatTasks())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.tasks.map((t) => t.id)).toEqual(["t-c", "t-a"])
    expect(result.current.tasks.find((t) => t.id === "t-c")!.status).toBe("awaiting_review")
  })
})
