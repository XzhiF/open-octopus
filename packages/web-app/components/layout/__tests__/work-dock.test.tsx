import type { ReactNode } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ remove: vi.fn() }))

vi.mock("next/navigation", () => ({
  usePathname: () => "/tasks",
}))

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string
    children: ReactNode
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("@/hooks/use-nav-history", () => ({
  useNavHistory: () => ({
    entries: [{ href: "/tasks", label: "任务看板", sub: "/tasks" }],
    total: 1,
    remove: mocks.remove,
  }),
}))

vi.mock("@/hooks/use-active-tasks", () => ({
  useActiveTasks: () => ({
    tasks: [{ id: "T-1", name: "示例作业", status: "running" }],
    total: 1,
    loading: false,
  }),
}))

import { WorkDock } from "../work-dock"

beforeEach(() => {
  mocks.remove.mockClear()
  window.localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  })
})

describe("WorkDock", () => {
  it("渲染导航记录与活跃作业", () => {
    render(<WorkDock />)

    expect(
      screen.getByRole("complementary", { name: "作业坞" }),
    ).toBeDefined()
    expect(
      screen.getByRole("link", { name: /任务看板/ }).getAttribute("href"),
    ).toBe("/tasks")

    const taskLink = screen.getByRole("link", { name: /示例作业/ })
    expect(taskLink.getAttribute("href")).toBe("/tasks?task=T-1")
    expect(screen.getByText("执行中")).toBeDefined()
  })

  it("可移除导航记录并持久化收起态", () => {
    render(<WorkDock />)

    fireEvent.click(
      screen.getByRole("button", { name: "移除导航 任务看板" }),
    )
    expect(mocks.remove).toHaveBeenCalledWith("/tasks")

    fireEvent.click(screen.getByRole("button", { name: "收起作业坞" }))
    expect(window.localStorage.getItem("octopus.dock.collapsed")).toBe("1")
    expect(
      screen.getByRole("button", { name: "展开作业坞" }),
    ).toBeDefined()
  })
})
