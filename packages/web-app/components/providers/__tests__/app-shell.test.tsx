import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({
  pathname: "/",
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    back: nav.back,
    forward: nav.forward,
    refresh: nav.refresh,
    prefetch: nav.prefetch,
  }),
}))
vi.mock("@/components/agent/chat/ConversationHome", () => ({
  ConversationHome: () => <div data-testid="persistent-chat" />,
}))
vi.mock("@/components/shell/view-host", () => ({
  ViewHost: ({ activeView }: { activeView: string | null }) => (
    <div data-testid="view-host" data-active={activeView ?? ""} />
  ),
}))
vi.mock("@/components/layout/header", () => ({ Header: () => <header /> }))
vi.mock("@/components/layout/app-rail", () => ({ AppRail: () => <aside /> }))
vi.mock("@/components/layout/work-dock", () => ({ WorkDock: () => <aside /> }))
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }))

import { AppShell } from "../app-shell"

describe("AppShell 桌面壳", () => {
  beforeEach(() => {
    nav.pathname = "/"
  })

  it("顶视图走 ViewHost，对话常驻只隐藏不卸载；详情路由才渲染 children", () => {
    const { rerender } = render(
      <AppShell>
        <div data-testid="route-child" />
      </AppShell>,
    )

    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
    expect(screen.getByTestId("view-host").dataset.active).toBe("")
    expect(screen.queryByTestId("route-child")).toBeNull()

    nav.pathname = "/tasks"
    rerender(
      <AppShell>
        <div data-testid="route-child" />
      </AppShell>,
    )
    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
    expect(screen.getByTestId("view-host").dataset.active).toBe("tasks")
    expect(screen.queryByTestId("route-child")).toBeNull()
    expect(screen.getByTestId("persistent-chat").parentElement).toHaveClass("hidden")

    nav.pathname = "/workspaces/abc"
    rerender(
      <AppShell>
        <div data-testid="route-child" />
      </AppShell>,
    )
    expect(screen.getByTestId("route-child")).toBeInTheDocument()
    expect(screen.getByTestId("view-host").dataset.active).toBe("")
    expect(screen.getByTestId("persistent-chat")).toBeInTheDocument()
  })
})