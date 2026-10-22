import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/agent/chat/ChatTab", () => ({
  ChatTab: () => <div data-testid="chat-tab" />,
}))

vi.mock("@/components/tasks/task-modal", () => ({
  TaskModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="task-modal" /> : null,
}))

import ConversationPage from "../page"

describe("对话首页", () => {
  it("复用 ChatTab，并从草稿按钮打开既有 TaskModal", () => {
    render(<ConversationPage />)

    expect(
      screen.getByRole("heading", { name: "对话", level: 1 }),
    ).toBeDefined()
    expect(screen.getByTestId("chat-tab")).toBeDefined()
    expect(screen.queryByTestId("task-modal")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /新建任务草稿/ }))
    expect(screen.getByTestId("task-modal")).toBeDefined()
  })
})
