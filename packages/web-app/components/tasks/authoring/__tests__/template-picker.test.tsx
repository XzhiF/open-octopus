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

// ── AC1: GET /api/skill-groups renders the group list (checkbox multi-select) ─

describe("TemplatePicker — skill-group list (AC1)", () => {
  it("fetches /api/skill-groups and renders one checkbox per group", async () => {
    render(<TemplatePicker onCreate={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText("open-spec")).toBeDefined()
      expect(screen.getByText("matt-pocock")).toBeDefined()
    })
    expect(mockListSkillGroups).toHaveBeenCalledOnce()
  })

  it("the built-in default group shows the 「不物化」 note (D17)", async () => {
    render(<TemplatePicker onCreate={() => {}} />)
    await waitFor(() => {
      // default group label + the D17 marker note.
      const defaultLabel = screen.getByText("default")
      expect(defaultLabel).toBeDefined()
      expect(screen.getByText(/不物化/)).toBeDefined()
    })
  })

  it("multi-select: selecting 2+ groups surfaces the integration-mode hint (D2/D3)", async () => {
    render(<TemplatePicker onCreate={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    // Select two groups.
    fireEvent.click(screen.getByLabelText("open-spec"))
    fireEvent.click(screen.getByLabelText("matt-pocock"))

    expect(screen.getByText(/整合模式/)).toBeDefined()
  })
})

// ── AC1: create button enabled only after a group is selected ────────

describe("TemplatePicker — create button (AC1)", () => {
  it("开始编写 is disabled until a skill group is selected", async () => {
    render(<TemplatePicker onCreate={() => {}} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    const btn = screen.getByRole("button", { name: /开始编写/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText("default"))
    expect(btn.disabled).toBe(false)
  })
})

// ── AC2/D13: onCreate payload = task_type + skill_groups + preset{org,projects} ─

describe("TemplatePicker — onCreate payload (AC2/D13)", () => {
  it("coding template: emits task_type=coding + selected groups + preset{org,projects}", async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    // Pick coding task type (default) + 2 groups + 1 project.
    fireEvent.click(screen.getByLabelText("default"))
    fireEvent.click(screen.getByLabelText("open-spec"))
    fireEvent.click(screen.getByTestId("project-selector").querySelector('[data-project-checkbox="octopus-server"]')!)

    fireEvent.click(screen.getByRole("button", { name: /开始编写/ }))

    expect(onCreate).toHaveBeenCalledOnce()
    const payload = onCreate.mock.calls[0][0] as TemplatePickerValue
    expect(payload.task_type).toBe("coding")
    expect(payload.skill_groups).toEqual(["default", "open-spec"])
    expect(payload.preset.org).toBe("E2E_TD_org")
    expect(payload.preset.projects).toEqual(["octopus-server"])
  })

  it("generic template: emits task_type=generic (preset optional)", async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} />)
    await waitFor(() => expect(screen.getByText("open-spec")).toBeDefined())

    // Switch to generic.
    fireEvent.click(screen.getByRole("button", { name: /通用任务/ }))
    fireEvent.click(screen.getByLabelText("default"))
    fireEvent.click(screen.getByRole("button", { name: /开始编写/ }))

    const payload = onCreate.mock.calls[0][0] as TemplatePickerValue
    expect(payload.task_type).toBe("generic")
    expect(payload.skill_groups).toEqual(["default"])
  })
})
