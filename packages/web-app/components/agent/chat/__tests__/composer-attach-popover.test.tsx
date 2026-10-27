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

describe("composer ＋ 面板（单层：分身 / SKILL）", () => {
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

  it("一个 ＋ 入口列出分身与 SKILL；委派随本轮发送，SKILL 变 /前缀", async () => {
    const onSend = vi.fn()
    render(<ChatArea {...baseProps} onSend={onSend} />)

    fireEvent.click(screen.getByTestId("composer-plus"))
    await waitFor(() => expect(listSkills).toHaveBeenCalled())
    await waitFor(() => expect(listClones).toHaveBeenCalled())

    // 单层：分身与 SKILL 同屏，不存在「添加 → 分身」的二级下钻
    expect(await screen.findByText("开发分身")).toBeInTheDocument()
    expect(screen.getByText("open-spec")).toBeInTheDocument()

    fireEvent.click(await screen.findByText("open-spec"))
    fireEvent.click(await screen.findByTestId("delegate-clone-dev-clone"))
    fireEvent.click(screen.getByTestId("composer-plus")) // 收起面板

    expect(screen.getByText("/open-spec")).toBeInTheDocument()
    expect(screen.getByText("分身 · 开发分身")).toBeInTheDocument()

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "看一下这个 spec" } })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })

    expect(onSend).toHaveBeenCalledWith("/open-spec 看一下这个 spec", {
      subagents: [{ id: "dev-clone", label: "开发分身" }],
    })
    expect(screen.queryByText("/open-spec")).toBeNull()
    expect(screen.queryByText("分身 · 开发分身")).toBeNull()
  })

  it("搜索一次过过滤两组：命中分身时 SKILL 组整体收起", async () => {
    render(<ChatArea {...baseProps} />)
    fireEvent.click(screen.getByTestId("composer-plus"))
    await waitFor(() => expect(listSkills).toHaveBeenCalled())

    const input = await screen.findByTestId("attach-search")
    fireEvent.change(input, { target: { value: "开发" } })
    expect(screen.getByText("开发分身")).toBeInTheDocument()
    expect(screen.queryByText("open-spec")).toBeNull()
    expect(screen.queryByText(/SKILL 1/)).toBeNull()

    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText("未找到匹配项")).toBeInTheDocument()
    expect(screen.queryByText("开发分身")).toBeNull()
  })

  it("身份：＋ 显示当前身份，面板里「切换」调 onSwitch（再点恢复基础身份）", async () => {
    const onSwitch = vi.fn()
    const { rerender } = render(
      <ChatArea
        {...baseProps}
        identity={{ activeName: null, label: null, onSwitch }}
      />,
    )

    const plus = screen.getByTestId("composer-plus")
    expect(plus.textContent).not.toContain("开发分身")

    fireEvent.click(plus)
    await waitFor(() => expect(listClones).toHaveBeenCalled())
    fireEvent.click(await screen.findByTestId("switch-identity-dev-clone"))
    expect(onSwitch).toHaveBeenCalledWith("dev-clone", "开发分身")

    // 外层把角色状态回灌后，＋ 原地变成紫色身份 chip（仍是同一个控件）
    rerender(
      <ChatArea
        {...baseProps}
        identity={{ activeName: "dev-clone", label: "开发分身", onSwitch }}
      />,
    )
    const trigger = screen.getByTestId("composer-plus")
    expect(trigger.textContent).toContain("开发分身")
    expect(trigger.getAttribute("aria-label")).toContain("开发分身")

    // 基础身份行可直接切回 null（面板切换后保持打开）
    fireEvent.click(await screen.findByTestId("switch-identity-base"))
    expect(onSwitch).toHaveBeenCalledWith(null, null)
  })
})
