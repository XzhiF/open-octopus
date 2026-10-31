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
        repo_group: "xzf",
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

  it("目录浏览器默认位置比居中再高一档（顶部留白 = 居中时的一半）", async () => {
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
    await waitFor(() => expect(browseDirectories).toHaveBeenCalled())

    // 全站 Dialog 居中在 top-50%；这里改成 translateY = -(25vh + 25%)，
    // 于是顶边落在 (视口高 - 弹窗高)/4 —— 与弹窗高度无关。
    const content = document.querySelector('[data-slot="dialog-content"]')
    expect(content).toHaveClass("translate-y-[calc(-25vh_-_25%)]")
  })

  it("选了身份 → 默认档文案跟着身份走", async () => {
    const onChange = vi.fn()
    render(
      <CwdPicker
        mode="main"
        org="xzf"
        value={{ kind: "default", label: "Main Agent 工作区" }}
        onChange={onChange}
        hero
        defaultLabel="开发分身 工作区"
        defaultHint="该分身自己的目录"
      />,
    )

    // 虚线 chip 不再泛称「选择工作区」，直接说明会落在哪。
    expect(screen.getByTestId("cwd-chip").textContent).toContain("开发分身 工作区")

    fireEvent.click(screen.getByTestId("cwd-chip"))
    const row = (await screen.findByText("该分身自己的目录")).closest("button")!
    expect(row).toHaveTextContent("开发分身 工作区")

    // 取默认档 → 存下的 label 也是身份的工作区，不是 Main Agent。
    fireEvent.click(row)
    expect(onChange).toHaveBeenCalledWith({ kind: "default", label: "开发分身 工作区" })
  })
})
