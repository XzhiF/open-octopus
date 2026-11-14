import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/agent/chat/ChatTab", () => ({
  ChatTab: () => <div data-testid="chat-tab" />,
}))

// useCabins 会真的 fetch /api/cabins；测试不等它，请求在环境 teardown 后才
// reject，finally 里的 setState 会变成 "window is not defined" 的未处理拒绝。
// 与本用例（只验 ChatTab 承载）无关，按同目录其它用例的做法直接 mock。
vi.mock("@/hooks/use-cabins", () => ({
  useCabins: () => ({ cabins: [], loading: false, refresh: () => {} }),
}))

import { ConversationHome } from "@/components/agent/chat/ConversationHome"

describe("对话首页", () => {
  it("只承载统一 ChatTab", () => {
    render(<ConversationHome />)

    expect(screen.getByTestId("chat-tab")).toBeDefined()
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})
