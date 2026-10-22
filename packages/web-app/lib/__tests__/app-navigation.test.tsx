import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({
  pathname: "/",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    back: nav.back,
    forward: nav.forward,
    refresh: nav.refresh,
    prefetch: nav.prefetch,
  }),
}))

import { AppNavProvider, useAppNavigation, usePathname, useSearchParams } from "../app-navigation"

function Probe() {
  const navValue = useAppNavigation()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  return (
    <div
      data-testid="probe"
      data-path={pathname}
      data-search={search}
      data-view={navValue?.view ?? ""}
      data-mode={navValue?.mode ?? ""}
    >
      <button data-testid="go-view" onClick={() => navValue?.navigate("/tasks?tab=x")} />
      <button data-testid="go-detail" onClick={() => navValue?.navigate("/workspaces/1")} />
    </div>
  )
}

describe("app-navigation 壳内路由", () => {
  beforeEach(() => {
    nav.pathname = "/"
    nav.search = ""
    vi.clearAllMocks()
  })

  it("顶层视图走壳内导航（不触发 Next）；详情路由交给 Next router", () => {
    render(
      <AppNavProvider>
        <Probe />
      </AppNavProvider>,
    )

    expect(screen.getByTestId("probe").dataset).toMatchObject({
      path: "/",
      view: "chat",
      mode: "view",
    })

    fireEvent.click(screen.getByTestId("go-view"))
    expect(screen.getByTestId("probe").dataset).toMatchObject({
      path: "/tasks",
      search: "tab=x",
      view: "tasks",
      mode: "view",
    })
    expect(nav.push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("go-detail"))
    expect(screen.getByTestId("probe").dataset.mode).toBe("detail")
    expect(nav.push).toHaveBeenCalledWith("/workspaces/1")
  })
})