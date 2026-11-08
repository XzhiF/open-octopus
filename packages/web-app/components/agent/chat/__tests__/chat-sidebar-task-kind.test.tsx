// 左侧任务列表的类型标识（2026-11-06，用户定稿方案 A）：
// 「开发任务」与「工作流开发」在任务行里可区分 —— 类型图标 + 状态点各占一列，
// 工作流开发用紫色（与作业坞「工作流」入口同色）。判定来源 task_spec.kind。

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ChatSidebar } from "../chat-sidebar"
import type { TaskView } from "@/lib/tasks-api"

const task = (id: string, name: string, kind?: "workflow-dev"): TaskView =>
  ({
    id,
    repo_group: "xzf",
    name,
    status: "draft",
    version: 1,
    source_chat_session_id: null,
    task_spec: kind ? { format: "v4", kind } : { format: "v4" },
  }) as unknown as TaskView

const noop = () => {}

function renderSidebar(props: { tasks?: TaskView[]; pendingTask?: { sessionId: string; title: string; kind?: "workflow-dev" } | null }) {
  return render(
    <ChatSidebar
      tasks={props.tasks ?? []}
      tasksLoading={false}
      activeTaskId={null}
      onSelectTask={noop}
      pendingTask={props.pendingTask ?? null}
      activePendingTask={!!props.pendingTask}
      sessions={[]}
      sessionsLoading={false}
      activeSessionId={null}
      onSelectSession={noop}
      onCreateSession={noop}
      onCreateTask={noop}
      onRenameSession={noop}
      onDeleteSession={noop}
      searchOpen={false}
      onSearchOpenChange={noop}
    />,
  )
}

describe("ChatSidebar — 任务类型标识（方案 A）", () => {
  it("工作流开发任务与开发任务各有自己的 type 标记，标题写明任务品类", () => {
    renderSidebar({
      tasks: [
        task("t-wf", "发布前校验工作流", "workflow-dev"),
        task("t-dev", "修复登录超时"),
      ],
    })

    const wf = document.querySelector('[data-task-id="t-wf"]') as HTMLElement
    const dev = document.querySelector('[data-task-id="t-dev"]') as HTMLElement

    expect(wf.getAttribute("data-task-kind")).toBe("workflow-dev")
    expect(dev.getAttribute("data-task-kind")).toBe("dev")

    expect(wf.querySelector('[data-task-kind-icon="workflow-dev"]')).toBeTruthy()
    expect(dev.querySelector('[data-task-kind-icon="dev"]')).toBeTruthy()

    // 类型图标与状态点同时存在（方案 A 的核心：两者各占一列，互不替代）。
    expect(wf.querySelector(".bg-pop-cyan")).toBeTruthy()

    expect(wf.getAttribute("title")).toContain("工作流开发任务")
    expect(dev.getAttribute("title")).toContain("开发任务")
    expect(dev.getAttribute("title")).not.toContain("工作流开发任务")
  })

  it("草稿中的 pending 行按 kind 显示工作流开发标记", () => {
    renderSidebar({ pendingTask: { sessionId: "", title: "新工作流开发任务", kind: "workflow-dev" } })
    const pending = screen.getByTestId("pending-task-item")
    expect(pending.getAttribute("data-task-kind")).toBe("workflow-dev")
    expect(pending.querySelector('[data-task-kind-icon="workflow-dev"]')).toBeTruthy()
    expect(pending.getAttribute("title")).toContain("工作流开发任务")
  })

  it("普通任务没有 kind 时回落为开发任务", () => {
    renderSidebar({ pendingTask: { sessionId: "", title: "新开发任务" } })
    const pending = screen.getByTestId("pending-task-item")
    expect(pending.getAttribute("data-task-kind")).toBe("dev")
    expect(pending.getAttribute("title")).toContain("开发任务")
  })
})
