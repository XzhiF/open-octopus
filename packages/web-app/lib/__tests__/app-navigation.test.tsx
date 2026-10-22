import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { AppNavProvider, useAppNavigation } from "../app-navigation"

function Probe() {
  const nav = useAppNavigation()
  return (
    <div
      data-testid="probe"
      data-path={nav?.pathname ?? ""}
      data-search={nav?.searchParams.toString() ?? ""}
      data-view={nav?.view ?? ""}
      data-mode={nav?.mode ?? ""}
      data-tab={nav?.tabKey ?? ""}
    >
      <button data-testid="go-view" onClick={() => nav?.navigate("/tasks?tab=x")} />
      <button data-testid="go-detail" onClick={() => nav?.navigate("/workspaces/1")} />
    </div>
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppNavProvider>
        <Probe />
      </AppNavProvider>
    </MemoryRouter>,
  )
}

describe("app-navigation 壳内路由", () => {
  it("视图导航更新 URL，视图仍由壳内常驻宿主管理", () => {
    renderAt("/")
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
  })

  it("详情路由进入 detail 模式并暴露 tab key", () => {
    renderAt("/")
    fireEvent.click(screen.getByTestId("go-detail"))
    expect(screen.getByTestId("probe").dataset).toMatchObject({
      path: "/workspaces/1",
      mode: "detail",
      tab: "workspace:1",
      view: "",
    })
  })

  it("退役路径重定向到知识中心", async () => {
    renderAt("/wiki/old-page?org=x")
    expect(await screen.findByTestId("probe")).toHaveAttribute("data-path", "/knowledge")
    expect(screen.getByTestId("probe").dataset.mode).toBe("view")
  })
})
