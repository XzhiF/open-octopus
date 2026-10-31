// 任务绑定的主会话不在「会话」列表重复出现（2026-10-28）：
// 一个任务 = 一条主对话线程。该会话若还挂着会话牌子，用户会以为是两个对话
// ——切换后中间转录"没变化"、运行状态"两边都亮"的困惑都源于此。

import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ChatSidebar } from "../chat-sidebar"
import type { AgentSession } from "@/lib/agent/types"
import type { TaskView } from "@/lib/tasks-api"

const baseTask = {
  id: "t1",
  repo_group: "xzf",
  name: "用户昵称敏感词过滤",
  status: "draft",
  version: 1,
  source_chat_session_id: "s-bound",
} as unknown as TaskView

const session = (id: string, title: string, extra: Partial<AgentSession> = {}): AgentSession =>
  ({
    id,
    title,
    org: "xzf",
    clone_name: null,
    session_type: "main",
    created_at: "2026-10-28T00:00:00Z",
    updated_at: "2026-10-28T00:00:00Z",
    last_message_at: null,
    is_active: true,
    ...extra,
  }) as AgentSession

const noop = () => {}

function renderSidebar(tasks: TaskView[], sessions: AgentSession[]) {
  return render(
    <ChatSidebar
      tasks={tasks}
      tasksLoading={false}
      activeTaskId={null}
      onSelectTask={noop}
      sessions={sessions}
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

describe("ChatSidebar — 任务线程会话去重", () => {
  it("被任务绑定的主会话不出现在会话列表，未绑定的照常显示", () => {
    const { container } = renderSidebar(
      [baseTask],
      [session("s-bound", "用户昵称敏感词过滤"), session("s-free", "随便聊聊")],
    )
    // 任务行照常存在。
    expect(screen.getByTestId("task-session-item")).toBeInTheDocument()
    // 会话区不再渲染被绑定的会话（任务行文字与同名会话标题无法用文案区分，
    // 直接按渲染的 data-session-id 断言）。
    expect(container.querySelector('[data-session-id="s-bound"]')).toBeNull()
    expect(container.querySelector('[data-session-id="s-free"]')).toBeTruthy()
  })

  it("clone 会话依旧被过滤（原有行为不回退）", () => {
    const { container } = renderSidebar([], [session("s-clone", "分身会话", { clone_name: "dev" })])
    expect(screen.getByText("暂无对话")).toBeInTheDocument()
    expect(container.querySelector('[data-session-id="s-clone"]')).toBeNull()
  })
})
