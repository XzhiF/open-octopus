import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, fireEvent, waitFor } from "@testing-library/react"
import type { Task, TaskSpec, TaskPhase } from "@octopus/shared"
import { getHomeFile, putHomeFile, TaskApiError } from "@/lib/tasks-api"
import { PhaseSpecDialog, isUiEditableSpecPath, specSkeleton } from "../phase-spec-dialog"

vi.mock("@/lib/tasks-api", () => {
  class TaskApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = "TaskApiError"
      this.status = status
    }
  }
  return {
    getHomeFile: vi.fn(),
    putHomeFile: vi.fn(),
    listHomeDir: vi.fn().mockResolvedValue([] as never),
    TaskApiError,
  }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function makePhase(overrides: Partial<TaskPhase> = {}): TaskPhase {
  return {
    index: 1, name: "P1", slug: "p1",
    specPath: "./.scratch/20260905/p1/spec.md",
    workflowRef: "built-in/matt-dev-pipeline",
    inputValues: {},
    ...overrides,
  } as TaskPhase
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1", org: "o", name: "n", status: "draft",
    task_spec: { format: "v4", phases: [] } as unknown as TaskSpec,
    skills: [], project_ids: [], resources: [], authoring_resources: [],
    version: 1, deleted_at: null,
    created_at: "", updated_at: "", completed_at: null,
    ...overrides,
  } as Task
}

function renderDialog(phase: TaskPhase, task = makeTask()) {
  return render(
    <PhaseSpecDialog task={task} phase={phase} open onOpenChange={() => {}} />,
  )
}

// Radix Dialog 在 jsdom 下会给 body 留 pointer-events:none（user-event 的
// pointer 检查会炸）→ 统一 fireEvent；等待器用抛错式（querySelector 返回
// null 不会让 waitFor 重试）。
function qMust<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el as T
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("isUiEditableSpecPath — 客户端预判（与 server 守卫同规）", () => {
  it.each([
    ["./.scratch/20260905/p1/spec.md", true],
    [".scratch/d/s/spec.md", true],
    ["./artifacts/x.md", false],          // 非 .scratch
    [".scratch/d/notes.txt", false],      // 非 .md
    ["C:/tmp/x.md", false],               // 绝对路径
    ["/home/x/spec.md", false],           // 绝对路径
    [".scratch/../context.md", false],    // 逃逸（rel 后首段不是 .scratch）
    ["", false],
  ])("%s → %s", (p, expected) => {
    expect(isUiEditableSpecPath(p)).toBe(expected)
  })
})

describe("PhaseSpecDialog — 三态", () => {
  it("404 → 空态 +「创建骨架」→ putHomeFile 写模板（Key Decisions 表头逐字对齐 K8）", async () => {
    vi.mocked(getHomeFile).mockRejectedValue(new TaskApiError("missing", 404))
    vi.mocked(putHomeFile).mockResolvedValue({ path: "p", bytes: 10 })
    renderDialog(makePhase())

    await waitFor(() => qMust("[data-spec-skeleton-button]"))
    fireEvent.click(qMust("[data-spec-skeleton-button]"))

    await waitFor(() => expect(putHomeFile).toHaveBeenCalledOnce())
    const [taskId, path, content] = vi.mocked(putHomeFile).mock.calls[0]
    expect(taskId).toBe("t1")
    expect(path).toBe(".scratch/20260905/p1/spec.md") // ADR-0018: home 相对 posix 位（去 ./ 前缀）
    expect(content).toContain("# Phase 1: P1")
    expect(content).toContain("| # | Decision | Conclusion | Reason |") // K8 行稳定锚点
    expect(content).toContain("## User Stories")
    // 落盘后进编辑态
    await waitFor(() => qMust("[data-spec-editor]"))
  })

  it("200 → textarea 载入内容；编辑后保存按钮从 disabled 变可点，PUT 带新内容", async () => {
    vi.mocked(getHomeFile).mockResolvedValue({ path: "p", content: "# 原始\n" })
    vi.mocked(putHomeFile).mockResolvedValue({ path: "p", bytes: 9 })
    renderDialog(makePhase())

    await waitFor(() => qMust("[data-spec-editor]"))
    const editor = document.querySelector("[data-spec-editor]") as HTMLTextAreaElement
    expect(editor.value).toBe("# 原始\n")
    const saveBtn = qMust("[data-spec-save-button]") as unknown as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true) // 未 dirty

    fireEvent.change(editor, { target: { value: "# 原始\n追加一行" } })
    await waitFor(() =>
      expect((qMust("[data-spec-save-button]") as unknown as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(qMust("[data-spec-save-button]"))
    await waitFor(() => expect(putHomeFile).toHaveBeenCalledOnce())
    expect(vi.mocked(putHomeFile).mock.calls[0][2]).toBe("# 原始\n追加一行")
  })

  it("403（server 判定出白名单）→ 只读说明，无编辑器", async () => {
    vi.mocked(getHomeFile).mockRejectedValue(new TaskApiError("forbidden", 403))
    renderDialog(makePhase())
    await waitFor(() => expect(document.querySelector("[data-spec-unsupported]")).toBeTruthy())
    expect(document.querySelector("[data-spec-editor]")).toBeNull()
  })

  it("绝对路径 specPath → 客户端预判，不发 GET", async () => {
    renderDialog(makePhase({ specPath: "/home/agent/elsewhere/spec.md" }))
    await waitFor(() => expect(document.querySelector("[data-spec-unsupported]")).toBeTruthy())
    expect(getHomeFile).not.toHaveBeenCalled()
  })

  it("500 → 错误态提示（不白屏）", async () => {
    vi.mocked(getHomeFile).mockRejectedValue(new Error("boom"))
    renderDialog(makePhase())
    await waitFor(() => expect(document.querySelector("[data-spec-error]")).toBeTruthy())
  })

  it("保存 409（非可编辑窗口）→ toast 呈现，不静默", async () => {
    const { toast } = await import("sonner")
    vi.mocked(getHomeFile).mockResolvedValue({ path: "p", content: "# x\n" })
    vi.mocked(putHomeFile).mockRejectedValue(new TaskApiError("Cannot edit batch files of a task in status 'archiving'", 409))
    renderDialog(makePhase({ specPath: "./.scratch/a/spec.md" }), makeTask({ status: "archiving" }))

    await waitFor(() => qMust("[data-spec-editor]"))
    fireEvent.change(document.querySelector("[data-spec-editor]")!, { target: { value: "# x\ny" } })
    await waitFor(() =>
      expect((qMust("[data-spec-save-button]") as unknown as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(qMust("[data-spec-save-button]"))
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining("archiving"),
      ),
    )
  })
})

describe("specSkeleton 模板", () => {
  it("包含 gate/matt 产物协议的锚点小节", () => {
    const s = specSkeleton(makePhase())
    expect(s).toContain("# Phase 1: P1")
    expect(s).toContain("| # | Decision | Conclusion | Reason |")
    expect(s).toContain("## 验收方式")
    expect(s).toContain("issues/")
  })
})
