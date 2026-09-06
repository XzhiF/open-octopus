import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { SelectedProject } from "@/components/scheduler/project-selector"

// ── Mocks (collaborators) ────────────────────────────────────────────

vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("@/hooks/useOrgs", () => ({
  useOrgs: () => ({
    orgs: [{ id: 1, name: "E2E_TD_org", path: "/tmp" }],
    loading: false,
    error: null,
  }),
}))
// ProjectSelector: stub a checkbox per project so selection is observable.
vi.mock("@/components/scheduler/project-selector", () => ({
  ProjectSelector: ({ value, onChange }: { value: SelectedProject[]; onChange: (v: SelectedProject[]) => void }) => (
    <div data-testid="project-selector">
      {["octopus-server", "octopus-engine"].map((p) => (
        <label key={p} className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={value.some((v) => v.name === p)}
            onChange={() =>
              onChange(
                value.some((v) => v.name === p)
                  ? value.filter((v) => v.name !== p)
                  : [...value, { name: p, source_path: "", group: "" }],
              )
            }
            data-project-checkbox={p}
          />
          {p}
        </label>
      ))}
    </div>
  ),
}))

import { TemplatePicker, type TemplatePickerValue } from "../template-picker"

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

// 契约修复改版（v4-only UI）：模板页只剩 codebase 语境（org + projects，恢复
// 票 11 下线的项目选择）。类型卡（coding/generic）与 skill 组勾选整体退役 —
// coding 直通 task-author 且直建 v4，generic 入口移除。

describe("TemplatePicker — v4-only 模板页", () => {
  it("恒呈现 ProjectSelector（恢复的项目选择），不再有类型卡 / skill 组 / goal-ac 痕迹", async () => {
    render(<TemplatePicker onCreate={() => {}} />)
    await waitFor(() => expect(screen.getByTestId("project-selector")).toBeTruthy())
    expect(document.querySelectorAll("[data-task-type]")).toHaveLength(0)
    expect(document.querySelectorAll("[data-skill-group]")).toHaveLength(0)
    expect(screen.queryByText("任务类型")).toBeNull()
    expect(screen.queryByText("Skill 组")).toBeNull()
    expect(screen.queryByText(/goal/i)).toBeNull()
    expect(screen.getByText(/直通 spec agent/)).toBeTruthy()
  })

  it("单组织时不渲染 org select（orgs.length<=1），但 org 仍随 payload 上送", async () => {
    render(<TemplatePicker onCreate={() => {}} />)
    await waitFor(() => expect(screen.getByTestId("project-selector")).toBeTruthy())
    expect(document.querySelector("select")).toBeNull()
  })
})

describe("TemplatePicker — onCreate payload", () => {
  it("零项目也可创建（对话内/看板预设仍可补语境）→ {org, projects:[]}", async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} />)
    await waitFor(() => expect(screen.getByTestId("project-selector")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: /开始编写/ }))
    expect(onCreate).toHaveBeenCalledOnce()
    const payload = onCreate.mock.calls[0][0] as TemplatePickerValue
    expect(payload.org).toBe("E2E_TD_org")
    expect(payload.projects).toEqual([])
  })

  it("勾选的项目以名字数组上送（→ POST project_ids → 直建 v4 的 home 语境）", async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} />)
    await waitFor(() => expect(screen.getByTestId("project-selector")).toBeTruthy())

    fireEvent.click(screen.getByLabelText("octopus-server"))
    fireEvent.click(screen.getByLabelText("octopus-engine"))
    fireEvent.click(screen.getByRole("button", { name: /开始编写/ }))

    const payload = onCreate.mock.calls[0][0] as TemplatePickerValue
    expect(payload.projects).toEqual(["octopus-server", "octopus-engine"])
  })

  it("busy 态禁用创建按钮（父层创建序列进行中）", async () => {
    render(<TemplatePicker onCreate={() => {}} busy />)
    await waitFor(() => expect(screen.getByTestId("project-selector")).toBeTruthy())
    const btn = screen.getByRole("button", { name: /创建中/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
