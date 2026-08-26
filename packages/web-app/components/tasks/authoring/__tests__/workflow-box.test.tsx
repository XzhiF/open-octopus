import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { WorkflowBox } from "../workflow-box"
import type { Task, TaskSpec } from "@octopus/shared"

// Mock the API modules
vi.mock("@/lib/tasks-api", () => ({
  updateTask: vi.fn().mockResolvedValue({ id: "test-task", version: 2 }),
}))

vi.mock("@/lib/workflow-presets-api", () => ({
  listWorkflowPresets: vi.fn().mockResolvedValue({ presets: [] }),
  listBuiltInWorkflows: vi.fn().mockResolvedValue([]),
  getBuiltInWorkflowDetail: vi.fn().mockResolvedValue({
    ref: "built-in/test-flow",
    content: "",
    parsed: { name: "Test Flow", inputs: {} },
  }),
}))

vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://localhost:3001",
}))

function makeTask(overrides: Partial<Task> & { task_spec?: Partial<TaskSpec> } = {}): Task {
  const spec: TaskSpec = {
    goal: "Test goal",
    ac: ["ac1"],
    resources: [],
    authoring_resources: [],
    skill_groups: [],
    decisions: [],
    ac_confirmed: [],
    ...(overrides.task_spec ?? {}),
  } as TaskSpec
  return {
    id: "test-task",
    org: "test",
    name: "Test Task",
    status: "draft",
    task_spec: spec,
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    version: 1,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Task
}

describe("WorkflowBox", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders '未绑定' when no workflow_ref", () => {
    render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    expect(screen.getByText("未绑定")).toBeTruthy()
    expect(screen.getByText("绑定工作流")).toBeTruthy()
  })

  it("renders workflow_ref badge when bound", () => {
    render(
      <WorkflowBox
        task={makeTask({ workflow_ref: "built-in/test-flow" })}
        onMutated={() => {}}
      />,
    )
    expect(screen.getByText("built-in/test-flow")).toBeTruthy()
    expect(screen.getByText("更换工作流")).toBeTruthy()
  })

  it("renders input value chips when input_values present", () => {
    render(
      <WorkflowBox
        task={makeTask({
          workflow_ref: "built-in/test-flow",
          task_spec: {
            goal: "test",
            ac: ["ac1"],
            resources: [],
            authoring_resources: [],
            skill_groups: [],
            decisions: [],
            ac_confirmed: [],
            input_values: { idea: "hello world" },
          },
        })}
        onMutated={() => {}}
      />,
    )
    // The chip shows "idea: hello world" (truncated if > 20 chars)
    expect(screen.getByText(/idea:/)).toBeTruthy()
  })

  it("has data-workflow-box attribute", () => {
    const { container } = render(<WorkflowBox task={makeTask()} onMutated={() => {}} />)
    expect(container.querySelector("[data-workflow-box]")).toBeTruthy()
  })
})
