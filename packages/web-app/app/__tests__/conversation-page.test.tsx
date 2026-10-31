import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/agent/chat/ChatTab", () => ({
  ChatTab: () => <div data-testid="chat-tab" />,
}))

import { ConversationHome } from "@/components/agent/chat/ConversationHome"

describe("对话首页", () => {
  it("只承载统一 ChatTab", () => {
    render(<ConversationHome />)

    expect(screen.getByTestId("chat-tab")).toBeDefined()
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
