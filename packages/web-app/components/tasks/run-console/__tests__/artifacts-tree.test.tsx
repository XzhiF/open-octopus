// 作业坞「产物」按目录树展示（2026-10-29 用户需求）：不再平铺清单，
// 门牌路径折成 任务目录 / 工作区 两棵树，目录可折叠、文件行保留预览与复制。

import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ArtifactsTab, buildArtifactTree } from "../artifacts-tab"
import type { ArtifactManifestBody, ArtifactManifestItem } from "@/lib/types"

const ITEMS: ArtifactManifestItem[] = [
  { name: "spec.md", path: "home:.scratch/task/spec.md", bytes: 120, mtime: "" },
  { name: "01-shell.md", path: "home:.scratch/task/issues/01-shell.md", bytes: 80, mtime: "" },
  { name: "x.html", path: "ws:public/prototype/x.html", bytes: 300, mtime: "" },
]

const BODY: ArtifactManifestBody = {
  groups: [{ key: "spec", label: "规格 · 票", items: ITEMS }],
}

describe("buildArtifactTree — 门牌路径折成目录树", () => {
  it("home: / ws: 两棵树；目录在前，文件挂在最深目录下", () => {
    const roots = buildArtifactTree(ITEMS)
    expect(roots.map((n) => n.name)).toEqual(["home:", "ws:"])
    const home = roots[0]
    expect(home.dir).toBe(true)
    const scratch = home.children[0]
    expect(scratch.name).toBe(".scratch")
    const task = scratch.children[0]
    expect(task.name).toBe("task")
    // 目录优先：issues 在 spec.md 前
    expect(task.children.map((n) => n.name)).toEqual(["issues", "spec.md"])
    expect(task.children[0].children[0].item?.path).toBe("home:.scratch/task/issues/01-shell.md")
  })
})

describe("ArtifactsTab — 目录树渲染", () => {
  it("分组内展示目录树（任务目录 / 工作区），文件行保留预览与复制", () => {
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    const group = screen.getByTestId("artifacts-group-spec")
    expect(group.textContent).toContain("任务目录")
    expect(group.textContent).toContain("工作区")
    expect(group.textContent).toContain("spec.md")
    expect(group.textContent).toContain("issues")
    expect(group.textContent).toContain("01-shell.md")
    expect(screen.getAllByTestId("artifact-row")).toHaveLength(3)
    expect(screen.getAllByTestId("artifact-preview-btn")).toHaveLength(3)
    expect(screen.getAllByTestId("artifact-copy-btn")).toHaveLength(3)
  })

  it("点目录可折叠：子文件行收起；再点展开", () => {
    render(<ArtifactsTab taskId="t1" body={BODY} loading={false} />)
    fireEvent.click(screen.getByText("issues"))
    expect(screen.queryByText("01-shell.md")).toBeNull()
    expect(screen.getAllByTestId("artifact-row")).toHaveLength(2)
    fireEvent.click(screen.getByText("issues"))
    expect(screen.getByText("01-shell.md")).toBeInTheDocument()
  })
})
