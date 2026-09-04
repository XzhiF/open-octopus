import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { SelectedProject } from "@/components/scheduler/project-selector"

// ── Mocks (collaborators) ────────────────────────────────────────────

vi.mock("@/lib/skill-groups-api", () => ({
  listSkillGroups: vi.fn(),
}))

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

import { listSkillGroups } from "@/lib/skill-groups-api"
import { TemplatePicker, type TemplatePickerValue } from "../template-picker"

const mockListSkillGroups = vi.mocked(listSkillGroups)

const GROUPS = [
  { group: "default", displayName: "default", skills: [] },
  { group: "open-spec", displayName: "open-spec", skills: [{ name: "open-spec", description: "spec.md" }] },
  { group: "matt-pocock", displayName: "matt-pocock", skills: [{ name: "tdd", description: "TDD" }] },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockListSkillGroups.mockResolvedValue({ groups: GROUPS })
})

afterEach(() => {
  vi.clearAllMocks()
})

// 票 11 (task-phase-redesign AC1): coding 型直通 task-author — Skill 组勾选与
// preset(org+projects) 预选控件均不渲染；generic 型保留 v3 现状。原「默认 coding
// 即渲染组列表」的断言随 AC1 迁移到 generic 分支，coding 分支改为断言控件不存在。

async function renderGenericWithGroups() {
  render(<TemplatePicker onCreate={() => {}} />)
  fireEvent.click(screen.getByRole("button", { name: /通用任务/ }))
  await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())
}

// ── AC1 (v3 现状, generic 保留): GET /api/skill-groups renders the group list ─

describe("TemplatePicker — skill-group list (generic 保留现状)", () => {
  it("fetches /api/skill-groups and renders one checkbox per group (generic)", async () => {
    await renderGenericWithGroups()
    expect(mockListSkillGroups).toHaveBeenCalledOnce()
    expect(screen.getByLabelText("open-spec")).toBeTruthy()
    expect(screen.getByLabelText("matt-pocock")).toBeTruthy()
  })

  it("the built-in default group shows the 「不物化」 note (D17, generic)", async () => {
    await renderGenericWithGroups()
    const defaultLabel = screen.getByText("default")
    expect(defaultLabel).toBeTruthy()
    expect(screen.getByText(/不物化/)).toBeTruthy()
  })

  it("multi-select: selecting 2+ groups surfaces the integration-mode hint (D2/D3, generic)", async () => {
    await renderGenericWithGroups()
    fireEvent.click(screen.getByLabelText("open-spec"))
    fireEvent.click(screen.getByLabelText("matt-pocock"))
    expect(screen.getByText(/整合模式/)).toBeTruthy()
  })
})

// ── 票 11 AC1: coding 直通 — 无技能组/preset 控件 ───────────────────

describe("TemplatePicker — coding 直通 (票 11 AC1)", () => {
  it("coding (默认类型) 不渲染任何 [data-skill-group] 勾选与 codebase/preset 段", async () => {
    render(<TemplatePicker onCreate={() => {}} />)
    await waitFor(() => expect(mockListSkillGroups).toHaveBeenCalledOnce())
    // 组列表已拉取，但 coding 型不呈现勾选控件。
    expect(screen.queryByTestId("project-selector")).toBeNull()
    expect(document.querySelectorAll("[data-skill-group]")).toHaveLength(0)
    expect(screen.queryByText("Skill 组")).toBeNull()
    expect(screen.queryByText(/codebase/)).toBeNull()
  })

  it("从 generic 切回 coding 即时隐藏勾选控件（类型分流）", async () => {
    await renderGenericWithGroups()
    expect(document.querySelectorAll("[data-skill-group]").length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: /开发任务/ }))
    expect(document.querySelectorAll("[data-skill-group]")).toHaveLength(0)
  })
})

// ── create button (v2 design: groups optional — 开始编写 never gated) ─

describe("TemplatePicker — create button (AC1)", () => {
  it("开始编写 is enabled without an explicit group (D17: built-in default always available)", async () => {
    await renderGenericWithGroups()
    const btn = screen.getByRole("button", { name: /开始编写/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it("coding 直通：无需任何勾选即可创建", async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} />)
    await waitFor(() => expect(mockListSkillGroups).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: /开始编写/ }))
    expect(onCreate).toHaveBeenCalledOnce()
  })
})

// ── onCreate payloads ────────────────────────────────────────────────

describe("TemplatePicker — onCreate payload", () => {
  it("coding template (票 11): emits task_type=coding + 空组 + 空 projects (直通)", async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} />)
    await waitFor(() => expect(mockListSkillGroups).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole("button", { name: /开始编写/ }))

    expect(onCreate).toHaveBeenCalledOnce()
    const payload = onCreate.mock.calls[0][0] as TemplatePickerValue
    expect(payload.task_type).toBe("coding")
    expect(payload.skill_groups).toEqual([])
    expect(payload.preset.projects).toEqual([])
    expect(payload.preset.org).toBe("E2E_TD_org") // 默认首个组织（仅 home 落位用）
  })

  it("generic template: emits task_type=generic + selected groups (preset optional) — 现状保留", async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} />)
    fireEvent.click(screen.getByRole("button", { name: /通用任务/ }))
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    fireEvent.click(screen.getByLabelText("default"))
    fireEvent.click(screen.getByLabelText("open-spec"))
    fireEvent.click(screen.getByRole("button", { name: /开始编写/ }))

    const payload = onCreate.mock.calls[0][0] as TemplatePickerValue
    expect(payload.task_type).toBe("generic")
    expect(payload.skill_groups).toEqual(["default", "open-spec"])
  })
})
