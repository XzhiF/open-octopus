import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/agent/api", () => ({
  getSessionRole: vi.fn(),
  setSessionRole: vi.fn(),
  getCloneSessionRole: vi.fn(),
  setCloneSessionRole: vi.fn(),
  listClones: vi.fn(),
}))
vi.mock("@/lib/tasks-api", () => ({
  getTaskChatRole: vi.fn(),
  setTaskChatRole: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import * as agentApi from "@/lib/agent/api"
import { ExpertIdentityChip } from "../expert-identity-chip"

const ROLE = {
  session_id: "s1",
  active_expert: "workspace",
  active_kind: "clone",
  expert: null,
  clone: {
    id: "workspace",
    display_name: "全栈开发助手",
    type: "built-in",
    skills: [],
    memory_scope: "shared",
    status: "active",
  },
  revision: 1,
  delivered_revision: 1,
}

const CLONES = [
  {
    name: "workspace",
    display_name: "全栈开发助手",
    type: "built-in",
    persona: "# 全栈开发助手…",
    skills: [],
    memory_scope: "shared",
    status: "active",
  },
  {
    name: "archive",
    display_name: "工程分析师",
    type: "built-in",
    persona: "# Archive 分身…",
    skills: ["octo-wiki"],
    memory_scope: "shared",
    status: "idle",
  },
  {
    name: "my-dev",
    display_name: "我的开发分身",
    type: "user",
    persona: "自定义…",
    skills: ["octo-dev-copilot"],
    memory_scope: "isolated",
    status: "idle",
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agentApi.getSessionRole).mockResolvedValue(ROLE as never)
  vi.mocked(agentApi.listClones).mockResolvedValue({ clones: CLONES, total: CLONES.length } as never)
})

describe("ExpertIdentityChip", () => {
  it("loads and displays the currently active clone identity", async () => {
    render(<ExpertIdentityChip kind="agent" sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId("expert-identity-chip").textContent).toContain("全栈开发助手")
    })
    expect(screen.getByTestId("expert-identity-chip")).toHaveAttribute("data-expert-id", "workspace")
    expect(agentApi.getSessionRole).toHaveBeenCalledWith("s1")
  })

  it("lists clones in system / user groups and filters by search", async () => {
    render(<ExpertIdentityChip kind="agent" sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId("expert-identity-chip").textContent).toContain("全栈开发助手")
    })

    fireEvent.click(screen.getByTestId("expert-identity-chip"))
    const input = await screen.findByTestId("identity-search")
    await waitFor(() => expect(screen.getByTestId("identity-search")).toBeInTheDocument())

    // Grouped roster.
    expect(await screen.findByText("系统分身")).toBeInTheDocument()
    expect(screen.getByText("我的分身")).toBeInTheDocument()
    expect(screen.getByText("工程分析师")).toBeInTheDocument()
    expect(screen.getByText("我的开发分身")).toBeInTheDocument()

    // Search narrows to the matching clone; the reset row stays pinned.
    fireEvent.change(input, { target: { value: "分析" } })
    expect(screen.getByText("工程分析师")).toBeInTheDocument()
    expect(screen.queryByText("我的开发分身")).toBeNull()
    expect(screen.getByText("恢复基础身份")).toBeInTheDocument()

    fireEvent.change(input, { target: { value: "zzz" } })
    expect(screen.getByText("未找到匹配的分身")).toBeInTheDocument()
  })

  it("switching posts the clone name and clears back to base", async () => {
    vi.mocked(agentApi.setSessionRole).mockResolvedValue({
      ...ROLE,
      active_expert: "archive",
      clone: { ...ROLE.clone, id: "archive", display_name: "工程分析师" },
    } as never)

    render(<ExpertIdentityChip kind="agent" sessionId="s1" />)
    await waitFor(() => {
      expect(screen.getByTestId("expert-identity-chip").textContent).toContain("全栈开发助手")
    })

    fireEvent.click(screen.getByTestId("expert-identity-chip"))
    const option = await screen.findByText("工程分析师")
    fireEvent.click(option)
    await waitFor(() => expect(agentApi.setSessionRole).toHaveBeenCalledWith("s1", "archive"))
  })
})