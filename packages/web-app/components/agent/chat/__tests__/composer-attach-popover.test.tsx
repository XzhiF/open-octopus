import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { listSkills, listClones } = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listClones: vi.fn(),
}))
vi.mock("@/lib/agent/api", () => ({ listSkills, listClones }))

import { ChatArea } from "../ChatArea"

const baseProps = {
  messages: [],
  streaming: false,
  streamContent: "",
  streamThinking: "",
  isThinking: false,
  toolCalls: [],
  pendingConfirm: null,
  error: null,
  statusMessage: "",
  onSend: vi.fn(),
  onStop: vi.fn(),
  onConfirm: vi.fn(),
  hasSession: false,
  currentModel: "pro",
  onModelChange: vi.fn(),
  tui: true,
  showComposerAttach: true,
}

describe("composer + 挂载", () => {
  beforeEach(() => {
    listSkills.mockReset().mockResolvedValue({
      skills: [{
        name: "open-spec",
        source: "builtin",
        token_count: 1200,
        file_size: 100,
        last_modified: null,
        has_local_backup: false,
      }],
    })
    listClones.mockReset().mockResolvedValue({
      clones: [{
        name: "dev-clone",
        display_name: "开发分身",
        type: "user",
        persona: "",
        skills: ["open-spec"],
        memory_scope: "shared",
        status: "active",
      }],
      total: 1,
    })
    vi.clearAllMocks()
  })

  it("列出系统 SKILL 与分身，SKILL 加前缀、专家走 delegate_to 随消息发送", async () => {
    const onSend = vi.fn()
    render(<ChatArea {...baseProps} onSend={onSend} />)

    fireEvent.click(screen.getByRole("button", { name: /挂载/ }))
    await waitFor(() => expect(listSkills).toHaveBeenCalled())
    await waitFor(() => expect(listClones).toHaveBeenCalled())

    fireEvent.click(await screen.findByText("open-spec"))
    fireEvent.click(screen.getByRole("button", { name: /^分身/ }))
    fireEvent.click(await screen.findByText("开发分身"))

    expect(screen.getByText("/open-spec")).toBeInTheDocument()
    expect(screen.getByText("分身 · 开发分身")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "完成" }))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "看一下这个 spec" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })

    expect(onSend).toHaveBeenCalledWith("/open-spec 看一下这个 spec", { delegate_to: "dev-clone" })
    expect(screen.queryByText("/open-spec")).toBeNull()
    expect(screen.queryByText("分身 · 开发分身")).toBeNull()
  })

  it("搜索过滤当前分类；当前分类无果时提示另一分类有匹配", async () => {
    render(<ChatArea {...baseProps} />)
    fireEvent.click(screen.getByRole("button", { name: /挂载/ }))
    await waitFor(() => expect(listSkills).toHaveBeenCalled())

    const input = await screen.findByTestId("attach-search")
    fireEvent.change(input, { target: { value: "open" } })
    expect(screen.getByText("open-spec")).toBeInTheDocument()

    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText("未找到匹配的 SKILL")).toBeInTheDocument()
    expect(screen.queryByText("open-spec")).toBeNull()

    // 「开发」只命中分身（display_name 开发分身）→ 跨分类提示可一键切换
    fireEvent.change(input, { target: { value: "开发" } })
    expect(screen.getByText("未找到匹配的 SKILL")).toBeInTheDocument()
    const hint = screen.getByTestId("attach-search-other-tab")
    expect(hint.textContent).toContain("分身")
    fireEvent.click(hint)
    expect(await screen.findByText("开发分身")).toBeInTheDocument()
  })
})
