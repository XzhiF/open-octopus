import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { Task } from "@octopus/shared"

// ── Mocks (collaborators) ────────────────────────────────────────────

// updateTask: the [rename] PUT — assert call + If-Match version.
vi.mock("@/lib/tasks-api", () => ({
  updateTask: vi.fn(),
}))

// Isolate the title from the Radix Dialog portal (EditableTitle renders
// DialogTitle; in TaskModal that lives under a real Dialog, here it's a bare h2).
vi.mock("@/components/ui/dialog", () => ({
  DialogTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <h2 data-testid="dialog-title" className={className}>{children}</h2>
  ),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { updateTask } from "@/lib/tasks-api"
import { toast } from "sonner"
import { EditableTitle } from "../editable-title"

const mockUpdateTask = vi.mocked(updateTask)

// ── Fixtures ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    org: "E2E_TD_org",
    name: "v3 draft",
    status: "draft",
    task_spec: {
      goal: "", ac: [], skill_groups: ["default"], task_type: "coding",
      goal_confirmed: false, ac_confirmed: [], decisions: [], resources: [], authoring_resources: [],
    },
    authoring_resources: [],
    resources: [],
    skills: [],
    project_ids: [],
    workflow_ref: undefined,
    version: 3,
    source_chat_session_id: "sess-1",
    deleted_at: null,
    created_at: "2026-08-17T00:00:00Z",
    updated_at: "2026-08-17T00:00:00Z",
    completed_at: null,
    ...overrides,
  } as Task
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateTask.mockResolvedValue({} as Task)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Editable draft title: click → edit mode → blur commits → onMutated ─

describe("EditableTitle — draft title click-to-edit", () => {
  it("draft: shows the name with an edit affordance; click swaps in an input", () => {
    const task = makeTask({ id: "t1" })
    render(<EditableTitle task={task} onMutated={() => {}} />)

    // The title is clickable (title tooltip) with the name as its label.
    const titleBtn = screen.getByTitle("点击编辑标题") as HTMLButtonElement
    expect(titleBtn.textContent).toContain("v3 draft")

    fireEvent.click(titleBtn)

    // Edit mode: an input pre-filled with the current name (select-all ready).
    const input = screen.getByLabelText("编辑任务标题") as HTMLInputElement
    expect(input.value).toBe("v3 draft")
    // The clickable title is gone while editing.
    expect(screen.queryByTitle("点击编辑标题")).toBeNull()
  })

  it("edit + blur → PUT {name} with the If-Match version + onMutated + toast", async () => {
    const task = makeTask({ id: "t1", version: 3 })
    const onMutated = vi.fn()
    render(<EditableTitle task={task} onMutated={onMutated} />)

    fireEvent.click(screen.getByTitle("点击编辑标题"))
    const input = screen.getByLabelText("编辑任务标题") as HTMLInputElement
    fireEvent.change(input, { target: { value: "新标题" } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("t1", { name: "新标题" }, 3)
    })
    expect(onMutated).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalled()
  })

  it("Enter commits (blur path); Escape cancels without saving", async () => {
    const task = makeTask({ id: "t1" })
    const onMutated = vi.fn()
    render(<EditableTitle task={task} onMutated={onMutated} />)

    // Enter → commit fires directly (the ref guard makes the unmount blur a
    // no-op, so Enter can't double-save with the onBlur path).
    fireEvent.click(screen.getByTitle("点击编辑标题"))
    const input = screen.getByLabelText("编辑任务标题") as HTMLInputElement
    fireEvent.change(input, { target: { value: "enter save" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => {
      expect(mockUpdateTask).toHaveBeenCalledWith("t1", { name: "enter save" }, 3)
    })

    // Escape → back to the label (the prop name; the dirty draft is discarded),
    // no save.
    fireEvent.click(screen.getByTitle("点击编辑标题"))
    const input2 = screen.getByLabelText("编辑任务标题") as HTMLInputElement
    fireEvent.focus(input2)
    fireEvent.change(input2, { target: { value: "should not save" } })
    fireEvent.keyDown(input2, { key: "Escape" })

    expect(mockUpdateTask).toHaveBeenCalledTimes(1)
    expect(screen.getByTitle("点击编辑标题").textContent).toContain("v3 draft")
  })

  it("blur without a change (or blank) is a no-op", async () => {
    const task = makeTask({ id: "t1", name: "unchanged" })
    const onMutated = vi.fn()
    render(<EditableTitle task={task} onMutated={onMutated} />)

    // Unchanged value → no PUT.
    fireEvent.click(screen.getByTitle("点击编辑标题"))
    const input = screen.getByLabelText("编辑任务标题") as HTMLInputElement
    fireEvent.change(input, { target: { value: "unchanged" } })
    fireEvent.blur(input)
    expect(mockUpdateTask).not.toHaveBeenCalled()

    // Whitespace-only → trimmed to blank → no PUT.
    fireEvent.click(screen.getByTitle("点击编辑标题"))
    const input2 = screen.getByLabelText("编辑任务标题") as HTMLInputElement
    fireEvent.change(input2, { target: { value: "   " } })
    fireEvent.blur(input2)
    expect(mockUpdateTask).not.toHaveBeenCalled()
    expect(onMutated).not.toHaveBeenCalled()
  })

  it("non-draft: static label, no edit affordance", () => {
    const task = makeTask({ id: "t1", status: "done" })
    render(<EditableTitle task={task} onMutated={() => {}} />)

    expect(screen.getByTestId("dialog-title").textContent).toBe("v3 draft")
    expect(screen.queryByTitle("点击编辑标题")).toBeNull()
  })
})
