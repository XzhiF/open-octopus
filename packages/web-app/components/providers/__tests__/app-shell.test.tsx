import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"

vi.mock("@/components/agent/chat/ConversationHome", () => ({
  ConversationHome: () => <div data-testid="persistent-chat" />,
}))
vi.mock("@/components/shell/view-host", () => ({
  ViewHost: ({ activeView }: { activeView: string | null }) => (
    <div data-testid="view-host" data-active={activeView ?? ""} />
  ),
}))
vi.mock("@/components/shell/detail-tab-bar", () => ({
  DetailTabBar: () => <div data-testid="detail-tab-bar" />,
}))
vi.mock("@/components/shell/detail-tabs-host", () => ({
  DetailTabsHost: () => <div data-testid="detail-tabs-host" />,
}))
vi.mock("@/components/shell/standalone-host", () => ({
  StandaloneHost: () => <div data-testid="standalone-host" />,
}))
vi.mock("@/components/shell/not-found-view", () => ({
  NotFoundView: () => <div data-testid="not-found-view" />,
}))
vi.mock("@/components/layout/header", () => ({ Header: () => <header /> }))
vi.mock("@/components/layout/app-rail", () => ({ AppRail: () => <aside /> }))
vi.mock("@/components/layout/work-dock", () => ({ WorkDock: () => <aside /> }))
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }))

import { AppShell } from "../app-shell"

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  )
}

describe("AppShell 桌面壳", () => {
  it("对话视图常驻，ViewHost 不激活", () => {
    renderAt("/")
    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
    expect(screen.getByTestId("view-host").dataset.active).toBe("")
    expect(screen.getByTestId("persistent-chat").parentElement).not.toHaveClass("hidden")
  })

  it("顶层视图走 ViewHost，对话只隐藏不卸载", () => {
    renderAt("/tasks")
    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
    expect(screen.getByTestId("view-host").dataset.active).toBe("tasks")
    expect(screen.getByTestId("persistent-chat").parentElement).toHaveClass("hidden")
  })

  it("详情路由隐藏对话与顶层视图，交给详情标签宿主", () => {
    renderAt("/workspaces/abc")
    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
    expect(screen.getByTestId("view-host").dataset.active).toBe("")
    expect(screen.getByTestId("persistent-chat").parentElement).toHaveClass("hidden")
    expect(screen.getByTestId("detail-tabs-host")).toBeInTheDocument()
  })
})
