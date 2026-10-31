// 新建任务的项目绑定弹窗必须能切 org —— bug 2026-10-27。
//
// 对话式新建任务把 org 写死在 useOrgs()[0]（按 name 升序 = miyuan），弹窗里又没有
// org 开关，于是 org=xzf 的仓库完全选不到，任务还会被静默建到 miyuan。
// 这里锁住：draft 任务可切 org（并清空跨 org 的选择）；已建任务 org 只读。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { useState } from "react"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/tasks-api", () => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
}))

vi.mock("@/components/scheduler/project-selector", () => ({
  ProjectSelector: ({
    org,
    value,
    onChange,
  }: {
    org: string
    value: { name: string }[]
    onChange: (next: { name: string; source_path: string; group: string }[]) => void
  }) => (
    <div data-testid="project-selector" data-org={org} data-count={value.length}>
      <button
        type="button"
        onClick={() => onChange([{ name: "demo-repo", source_path: "", group: org }])}
      >
        pick-demo
      </button>
    </div>
  ),
}))

import { TaskProjectChip } from "../task-project-chip"

function Harness({
  initialOrg = "miyuan",
  orgs = ["miyuan", "xzf", "xzf-dev"],
  taskId,
}: {
  initialOrg?: string
  orgs?: string[]
  taskId?: string
}) {
  const [org, setOrg] = useState(initialOrg)
  const [projectIds, setProjectIds] = useState<string[]>([])
  return (
    <>
      <output data-testid="current-org">{org}</output>
      <TaskProjectChip
        org={org}
        orgs={orgs}
        onOrgChange={(next) => {
          setOrg(next)
          setProjectIds([])
        }}
        projectIds={projectIds}
        taskId={taskId}
        onSaved={(ids) => setProjectIds(ids)}
      />
    </>
  )
}

function openDialog() {
  fireEvent.click(screen.getByTestId("task-project-chip"))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("TaskProjectChip — org 选择（新建任务）", () => {
  it("draft 任务：弹窗内可选 org，切换后项目清单按新 org 加载", () => {
    render(<Harness />)
    openDialog()

    const select = screen.getByTestId("task-project-org") as HTMLSelectElement
    expect(select.value).toBe("miyuan")
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["miyuan", "xzf", "xzf-dev"])
    expect(screen.getByTestId("project-selector").dataset.org).toBe("miyuan")

    fireEvent.change(select, { target: { value: "xzf" } })

    expect(screen.getByTestId("current-org").textContent).toBe("xzf")
    expect(screen.getByTestId("project-selector").dataset.org).toBe("xzf")
  })

  it("切换 org 时清空上一个 org 的项目选择（跨 manifest 的 id 无意义）", () => {
    render(<Harness />)
    openDialog()

    fireEvent.click(screen.getByText("pick-demo"))
    expect(screen.getByTestId("project-selector").dataset.count).toBe("1")

    fireEvent.change(screen.getByTestId("task-project-org"), { target: { value: "xzf" } })

    expect(screen.getByTestId("project-selector").dataset.count).toBe("0")
  })

  it("已建任务（taskId 存在）org 只读：不渲染 org 选择器", () => {
    render(<Harness taskId="t1" />)
    openDialog()
    expect(screen.queryByTestId("task-project-org")).toBeNull()
  })

  it("只有单个 org 时不渲染选择器", () => {
    render(<Harness orgs={["xzf"]} initialOrg="xzf" />)
    openDialog()
    expect(screen.queryByTestId("task-project-org")).toBeNull()
  })
})
