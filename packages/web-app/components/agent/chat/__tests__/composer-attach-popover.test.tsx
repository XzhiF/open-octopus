import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { listSkills, listClones, listWorkspaceSkills } = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listClones: vi.fn(),
  listWorkspaceSkills: vi.fn(),
}))
vi.mock("@/lib/agent/api", () => ({ listSkills, listClones }))
vi.mock("@/lib/api-client", () => ({ listWorkspaceSkills }))

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

describe("composer ＋ 面板（技能 / 分身分层）", () => {
  beforeEach(() => {
    // 与真实服务端一致：技能列表在 items 里（曾经只读 .skills → 技能页永远空）。
    listSkills.mockReset().mockResolvedValue({
      items: [{
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
    listWorkspaceSkills.mockReset().mockResolvedValue({ items: [], total: 0 })
    vi.clearAllMocks()
  })

  it("技能 / 分身分两类；挂 SKILL 后切到分身页委派，随本轮发送", async () => {
    const onSend = vi.fn()
    render(<ChatArea {...baseProps} onSend={onSend} />)

    fireEvent.click(screen.getByTestId("composer-plus"))
    await waitFor(() => expect(listSkills).toHaveBeenCalled())
    await waitFor(() => expect(listClones).toHaveBeenCalled())

    // 默认技能页：只有 SKILL，不再和分身堆在一起
    expect(await screen.findByText("open-spec")).toBeInTheDocument()
    expect(screen.queryByText("开发分身")).toBeNull()

    fireEvent.click(await screen.findByText("open-spec"))

    // 分身页：委派
    fireEvent.click(screen.getByTestId("attach-tab-clone"))
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

  it("搜索只作用于当前类别：技能页不命中分身，分身页不命中 SKILL", async () => {
    render(<ChatArea {...baseProps} />)
    fireEvent.click(screen.getByTestId("composer-plus"))
    await waitFor(() => expect(listSkills).toHaveBeenCalled())

    const input = await screen.findByTestId("attach-search")
    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText("未找到匹配的 SKILL")).toBeInTheDocument()
    expect(screen.queryByText("开发分身")).toBeNull()

    fireEvent.click(screen.getByTestId("attach-tab-clone"))
    fireEvent.change(input, { target: { value: "开发" } })
    expect(await screen.findByText("开发分身")).toBeInTheDocument()
    expect(screen.queryByText("open-spec")).toBeNull()

    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText("未找到匹配的分身")).toBeInTheDocument()
    expect(screen.queryByText("开发分身")).toBeNull()
  })

  it("选了工作区：技能页置顶「工作区自带」（只读）", async () => {
    listWorkspaceSkills.mockResolvedValue({
      items: [{
        name: "code-review",
        source: "workspace",
        token_count: 100,
        file_size: 400,
        last_modified: null,
      }],
      total: 1,
    })
    render(
      <ChatArea
        {...baseProps}
        workspaceContext={{ id: "ws-1", label: "kpi-10" }}
        identity={{ activeName: "dev-clone", label: "开发分身", onSwitch: vi.fn() }}
        heroEmpty
      />,
    )

    fireEvent.click(screen.getByTestId("composer-plus"))
    await waitFor(() => expect(listWorkspaceSkills).toHaveBeenCalledWith("ws-1"))

    const bound = await screen.findByTestId("attach-bound-workspace-skills")
    expect(bound.textContent).toContain("code-review")
    expect(bound.textContent).toContain("kpi-10")
    expect(bound.textContent).toContain("随工作区生效")
    // 身份自带那一层仍在
    expect(screen.getByTestId("attach-bound-skills").textContent).toContain("open-spec")
  })

  it("没有工作区上下文时不拉工作区技能", async () => {
    render(<ChatArea {...baseProps} />)
    fireEvent.click(screen.getByTestId("composer-plus"))
    await waitFor(() => expect(listSkills).toHaveBeenCalled())
    expect(listWorkspaceSkills).not.toHaveBeenCalled()
    expect(screen.queryByTestId("attach-bound-workspace-skills")).toBeNull()
  })

  it("hero（新会话）：技能页置顶「身份自带」，分身页只留委派", async () => {
    render(
      <ChatArea
        {...baseProps}
        identity={{ activeName: "dev-clone", label: "开发分身", onSwitch: vi.fn() }}
        heroEmpty
      />,
    )

    // ＋ 仍是橙色加号：身份由下方单选选择器负责。
    expect(screen.getByTestId("composer-plus").textContent).not.toContain("开发分身")

    fireEvent.click(screen.getByTestId("composer-plus"))
    await waitFor(() => expect(listClones).toHaveBeenCalled())

    // 选中身份 → 头部带身份，技能页置顶它自带的 SKILL（只读）
    expect(screen.getByTestId("attach-identity-chip").textContent).toContain("开发分身")
    const bound = await screen.findByTestId("attach-bound-skills")
    expect(bound.textContent).toContain("open-spec")
    expect(bound.textContent).toContain("随身份生效")
    expect(screen.getAllByText("身份自带").length).toBeGreaterThan(0)

    // 分身页：hero 没有切换，只有委派
    fireEvent.click(screen.getByTestId("attach-tab-clone"))
    expect(await screen.findByTestId("delegate-clone-dev-clone")).toBeInTheDocument()
    expect(screen.queryByTestId("switch-identity-base")).toBeNull()
    expect(screen.queryByTestId("switch-identity-dev-clone")).toBeNull()
  })

  it("身份：＋ 显示当前身份，分身页「切换」调 onSwitch（再点恢复基础身份）", async () => {
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
    fireEvent.click(screen.getByTestId("attach-tab-clone"))
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
