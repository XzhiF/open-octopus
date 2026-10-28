// 作业坞（任务浮窗右侧竖栏）文字标签：默认常驻显示在图标下方，
// 设置 → 外观 关闭后只留图标（但仍保留 aria-label / title 提示）。

import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskView } from "@/lib/tasks-api"

vi.mock("@/lib/yjs-provider", () => ({
  useYDoc: () => ({ doc: null, provider: null, connected: false, synced: false }),
  useYMap: () => ({ map: null, version: 0 }),
}))
vi.mock("@/lib/api-client", () => ({
  fetchFileContent: vi.fn(),
  saveFileEntry: vi.fn(),
}))

import { WorkspaceExplorerDock } from "../workspace-explorer-dock"
import { __resetDockLabelsForTests, setDockLabelsVisible } from "@/lib/ui-preferences"

const activity = {
  queue: [],
  events: [],
  runningTasks: [],
  allRunningTasks: [],
  runningAgents: [],
  subagents: [],
  count: 0,
  globalCount: 0,
}

const draftTask = {
  id: "task-1",
  name: "演示任务",
  status: "draft",
  org: "xzf",
} as unknown as TaskView

beforeEach(() => {
  localStorage.clear()
  __resetDockLabelsForTests()
})

describe("WorkspaceExplorerDock — 图标下方常驻文字", () => {
  it("默认显示每个入口的文字，且不再依赖 hover tooltip", () => {
    render(
      <WorkspaceExplorerDock workspaceId="ws-1" task={draftTask} activity={activity} onTaskAction={() => {}} />,
    )

    const files = screen.getByTestId("dock-files")
    expect(files.textContent).toContain("文件")
    expect(files.getAttribute("title")).toBeNull()

    expect(screen.getByTestId("dock-activity").textContent).toContain("活动")
    expect(screen.getByTestId("task-action-enqueue").textContent).toContain("入列")
    expect(screen.getByText("规格")).toBeTruthy()
    expect(screen.getByText("消耗")).toBeTruthy()

    // 坞内文字约定：不超过 3 个字符。
    const dock = screen.getByTestId("workspace-explorer-dock")
    for (const button of dock.querySelectorAll("button")) {
      expect([...(button.textContent ?? "")].length).toBeLessThanOrEqual(3)
    }
  })

  it("关闭偏好后立刻退回图标态，tooltip 补回名称", () => {
    render(
      <WorkspaceExplorerDock workspaceId="ws-1" task={draftTask} activity={activity} onTaskAction={() => {}} />,
    )

    act(() => setDockLabelsVisible(false))

    const files = screen.getByTestId("dock-files")
    expect(files.textContent).toBe("")
    expect(files.getAttribute("title")).toBe("文件")
    expect(screen.queryByText("入列")).toBeNull()
    expect(screen.getByTestId("task-action-enqueue").getAttribute("title")).toBe("入列")
  })
})
