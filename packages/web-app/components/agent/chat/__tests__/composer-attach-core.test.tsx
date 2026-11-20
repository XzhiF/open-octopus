import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { listSkills, listClones, listMcpServers, listWorkspaceSkills } = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listClones: vi.fn(),
  listMcpServers: vi.fn(),
  listWorkspaceSkills: vi.fn(),
}))
vi.mock("@/lib/agent/api", () => ({ listSkills, listClones, listMcpServers }))
vi.mock("@/lib/api-client", () => ({ listWorkspaceSkills }))

import { ComposerAttachPopover, type ComposerSkillRef } from "../composer-attach-popover"

const baseProps = {
  skill: null as ComposerSkillRef | null,
  expert: null,
  onSkillChange: vi.fn(),
  onExpertChange: vi.fn(),
  triggerVariant: "core" as const,
}

describe("通讯台「星核」触发器（triggerVariant=core）", () => {
  beforeEach(() => {
    listSkills.mockReset().mockResolvedValue({ items: [] })
    listClones.mockReset().mockResolvedValue({ clones: [], total: 0 })
    listMcpServers.mockReset().mockResolvedValue({ servers: [] })
    listWorkspaceSkills.mockReset().mockResolvedValue({ items: [], total: 0 })
    vi.clearAllMocks()
  })

  it("渲染星核钮而不是 composer 的 ＋；点击开合面板", () => {
    const onOpenChange = vi.fn()
    render(
      <ComposerAttachPopover {...baseProps} open={false} onOpenChange={onOpenChange} />,
    )

    const trigger = screen.getByTestId("cockpit-attach")
    expect(trigger.querySelector("svg")).toBeTruthy()
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog")
    expect(screen.queryByTestId("composer-plus")).toBeNull()

    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it("挂载 SKILL / 委派分身时角标显示条目数", () => {
    render(
      <ComposerAttachPopover
        {...baseProps}
        skill={{ name: "open-spec" }}
        expert={{ name: "dev-clone", displayName: "开发分身" }}
        open={false}
        onOpenChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId("cockpit-attach-count")).toHaveTextContent("2")
  })

  it("展开后面板内容与 inline 触发器同一份", async () => {
    render(<ComposerAttachPopover {...baseProps} open onOpenChange={vi.fn()} />)
    expect(await screen.findByTestId("composer-plus-panel")).toBeInTheDocument()
    expect(await screen.findByTestId("attach-tab-skill")).toBeInTheDocument()
  })
})
