import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }))
vi.mock("@/components/agent/chat/ConversationHome", () => ({
  ConversationHome: () => <div data-testid="persistent-chat" />,
}))
vi.mock("@/components/layout/header", () => ({ Header: () => <header /> }))
vi.mock("@/components/layout/app-rail", () => ({ AppRail: () => <aside /> }))
vi.mock("@/components/layout/work-dock", () => ({ WorkDock: () => <aside /> }))
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }))

import { AppShell } from "../app-shell"

describe("AppShell 常驻对话", () => {
  beforeEach(() => {
    nav.pathname = "/"
  })

  it("离开对话页只隐藏、不卸载 ChatTab", () => {
    const { rerender } = render(
      <AppShell>
        <div data-testid="route-child" />
      </AppShell>,
    )

    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
    expect(screen.queryByTestId("route-child")).toBeNull()

    nav.pathname = "/tasks"
    rerender(
      <AppShell>
        <div data-testid="route-child" />
      </AppShell>,
    )

    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
    expect(screen.getByTestId("route-child")).toBeInTheDocument()
    expect(screen.getByTestId("persistent-chat").parentElement).toHaveClass("hidden")
  })
})
