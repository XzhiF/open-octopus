// 目录选择器：不再手输路径，改用服务端目录浏览（非系统敏感目录）。
// 选中的目录注册为工作空间后回填 CwdChoice。

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { listWorkspaces, browseDirectories, attachWorkspaceDirectory } = vi.hoisted(() => ({
  listWorkspaces: vi.fn(),
  browseDirectories: vi.fn(),
  attachWorkspaceDirectory: vi.fn(),
}))

vi.mock("@/lib/api-client", () => ({
  listWorkspaces,
  browseDirectories,
  attachWorkspaceDirectory,
}))

import { CwdPicker } from "../cwd-picker"

const homeBrowse = {
  path: "/home/u",
  parent: "/home",
  home: "/home/u",
  roots: [{ name: "/", path: "/" }],
  dirs: [
    { name: "projects", path: "/home/u/projects" },
    { name: "Downloads", path: "/home/u/Downloads" },
  ],
  canSelect: true,
}

const projectsBrowse = {
  ...homeBrowse,
  path: "/home/u/projects",
  parent: "/home/u",
  dirs: [{ name: "kpi-10", path: "/home/u/projects/kpi-10" }],
}

beforeEach(() => {
  listWorkspaces.mockReset().mockResolvedValue([])
  browseDirectories.mockReset().mockImplementation(async (target?: string) =>
    target === "/home/u/projects" ? projectsBrowse : homeBrowse,
  )
  attachWorkspaceDirectory.mockReset().mockResolvedValue({
    id: "ws-1",
    name: "projects-abc123",
    path: "/home/u/projects",
  })
})

describe("CwdPicker — 目录浏览器", () => {
  it("浏览目录 → 进入子目录 → 选中并注册", async () => {
    const onChange = vi.fn()
    render(
      <CwdPicker
        mode="main"
        org="xzf"
        value={{ kind: "default", label: "Main Agent 工作区" }}
        onChange={onChange}
        hero
      />,
    )

    fireEvent.click(screen.getByTestId("cwd-chip"))
    fireEvent.click(await screen.findByTestId("cwd-browse-open"))
    await waitFor(() => expect(browseDirectories).toHaveBeenCalled())
    expect(await screen.findByTestId("cwd-browse-path")).toHaveTextContent("/home/u")

    // 旧的「手输路径」入口不再存在
    expect(screen.queryByPlaceholderText("/Users/you/projects/my-app")).toBeNull()

    fireEvent.click(screen.getByText("projects"))
    await waitFor(() => expect(browseDirectories).toHaveBeenCalledWith("/home/u/projects"))
    expect(await screen.findByTestId("cwd-browse-path")).toHaveTextContent("/home/u/projects")

    fireEvent.click(screen.getByTestId("cwd-browse-select"))
    await waitFor(() =>
      expect(attachWorkspaceDirectory).toHaveBeenCalledWith({
        org: "xzf",
        path: "/home/u/projects",
      }),
    )
    expect(onChange).toHaveBeenCalledWith({
      kind: "directory",
      workspaceId: "ws-1",
      path: "/home/u/projects",
      label: "projects",
    })
  })

  it("敏感目录错误会显示出来", async () => {
    browseDirectories.mockRejectedValueOnce(new Error("系统敏感目录不能浏览: /etc"))
    render(
      <CwdPicker
        mode="main"
        org="xzf"
        value={{ kind: "default", label: "Main Agent 工作区" }}
        onChange={vi.fn()}
        hero
      />,
    )

    fireEvent.click(screen.getByTestId("cwd-chip"))
    fireEvent.click(await screen.findByTestId("cwd-browse-open"))
    expect(await screen.findByText(/系统敏感目录不能浏览/)).toBeInTheDocument()
    expect(screen.getByTestId("cwd-browse-select")).toBeDisabled()
  })
})
