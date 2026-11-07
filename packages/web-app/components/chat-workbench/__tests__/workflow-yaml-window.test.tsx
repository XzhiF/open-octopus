import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ExecutionDetailWire } from "@/lib/api-client"
import { fetchExecutionDetail, fetchWorkflowContent } from "@/lib/api-client"
import { subscribeSSE } from "@/lib/sse-manager"
import type { YamlTarget } from "../task-window-types"
import { WorkflowYamlWindow } from "../workflow-yaml-window"

vi.mock("@/lib/api-client", () => ({
  fetchExecutionDetail: vi.fn(),
  fetchWorkflowContent: vi.fn(),
}))
vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: vi.fn(() => () => {}) }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const ROOT_YAML = `apiVersion: octopus/v1
kind: Workflow
name: demo
nodes:
  - id: spec-resolve
    type: bash
    bash: |
      echo hi
  - id: ticket-dag
    type: dynamic_sub_workflow
    workflow: ticket-dag
  - id: review
    type: agent
`

const CURRENT_YAML = ROOT_YAML.replace("name: demo", "name: demo-current")

const CHILD_YAML = `apiVersion: octopus/v1
kind: Workflow
name: ticket-dag-8f3a21c4
nodes:
  - id: ticket-01
    type: agent
`

const HELPER_ROOT = `apiVersion: octopus/v1
name: demo
nodes:
  - id: call-helper
    type: sub_workflow
    workflow: helper
`

const HELPER_YAML = `apiVersion: octopus/v1
name: helper
nodes:
  - id: helper-node
    type: bash
`

const target: YamlTarget = {
  workspaceId: "ws-1",
  executionId: "exec-8f3a21c4",
  workflowRef: "matt-spec-dev",
  title: "matt-spec-dev",
  phaseIndex: 1,
  roundIndex: 2,
  status: "running",
  from: "dock",
}

const detail = (overrides: Partial<ExecutionDetailWire> = {}): ExecutionDetailWire => ({
  id: "exec-8f3a21c4",
  status: "running",
  workflow_ref: "matt-spec-dev",
  workflow_content: ROOT_YAML,
  workflow_content_source: "snapshot",
  started_at: "2026-10-22T06:03:00.000Z",
  completed_at: null,
  steps: [],
  ...overrides,
})

const mount = async (onClose = vi.fn()) => {
  const result = render(<WorkflowYamlWindow target={target} onClose={onClose} />)
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
  return { ...result, onClose }
}

const workflowRow = (ref: string) =>
  screen.getAllByTestId("yaml-workflow-row").find((row) => row.getAttribute("data-ref") === ref)

describe("WorkflowYamlWindow — 主工作流", () => {
  beforeEach(() => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(detail())
    vi.mocked(fetchWorkflowContent).mockImplementation(async (_ws, ref) => {
      if (ref === "matt-spec-dev") return { content: ROOT_YAML }
      if (ref === "ticket-dag") return { content: CHILD_YAML }
      return null
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("打开即显示本次运行的 YAML 快照 + 节点大纲", async () => {
    await mount()
    expect(screen.getByTestId("workflow-yaml-window")).toBeTruthy()
    expect(screen.getByTestId("yaml-subtitle").textContent).toContain("P1 · R2")
    expect(screen.getByTestId("yaml-code").textContent).toContain("spec-resolve")
    expect(screen.getAllByTestId("yaml-node-outline")).toHaveLength(3)
    expect(screen.getByTestId("yaml-source-label").textContent).toContain("运行快照")
  })

  it("没有快照时如实标注回退来源（工作区定义）", async () => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(
      detail({ workflow_content_source: "workspace" }),
    )
    await mount()
    expect(screen.getByTestId("yaml-fallback-banner").textContent).toContain("未找到运行快照")
    expect(screen.getByTestId("yaml-source-label").textContent).toContain("回退 · 工作区定义")
  })

  it("搜索：统计命中并支持 Enter 轮换", async () => {
    await mount()
    const input = screen.getByTestId("yaml-search")
    fireEvent.change(input, { target: { value: "ticket" } })
    await waitFor(() =>
      expect(screen.getByTestId("yaml-match-count").textContent).toContain("处"),
    )
    expect(document.querySelectorAll("mark").length).toBeGreaterThan(0)
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() =>
      expect(screen.getByTestId("yaml-match-count").textContent).toMatch(/^\d+\/\d+$/),
    )
  })

  it("快照与当前定义一致：隐藏来源切换（没有可选的第二个来源）", async () => {
    await mount()
    expect(screen.queryByTestId("yaml-source-snapshot")).toBeNull()
    expect(screen.queryByTestId("yaml-source-current")).toBeNull()
    expect(screen.getByTestId("yaml-source-label").textContent).toContain("运行快照")
  })

  it("差异条：快照与当前定义不同 → 可一键切换", async () => {
    vi.mocked(fetchWorkflowContent).mockImplementation(async (_ws, ref) => {
      if (ref === "matt-spec-dev") return { content: CURRENT_YAML }
      if (ref === "ticket-dag") return { content: CHILD_YAML }
      return null
    })
    await mount()
    await waitFor(() => expect(screen.getByTestId("yaml-diff-banner")).toBeTruthy())
    expect(screen.getByTestId("yaml-diff-banner").textContent).toContain("与当前定义有差异")
    expect(screen.getByTestId("yaml-source-snapshot")).toBeTruthy()

    fireEvent.click(screen.getByTestId("yaml-source-current"))
    await waitFor(() =>
      expect(screen.getByTestId("yaml-code").textContent).toContain("demo-current"),
    )
    expect(screen.getByTestId("yaml-source-label").textContent).toContain("当前定义")
    expect(screen.getByTestId("yaml-diff-banner").textContent).toContain("与运行快照有差异")
  })

  it("关闭按钮与 Esc 都回传 onClose（系统窗标题栏）", async () => {
    const { onClose } = await mount()
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("黄灯最小化后出现恢复入口，点它回到窗口", async () => {
    await mount()
    fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }))
    await waitFor(() => expect(screen.getByTestId("yaml-restore")).toBeTruthy())
    expect(screen.queryByTestId("workflow-yaml-window")).toBeNull()

    fireEvent.click(screen.getByTestId("yaml-restore"))
    await waitFor(() => expect(screen.getByTestId("workflow-yaml-window")).toBeTruthy())
  })

  it("绿灯最大化铺满工作台，双击标题栏还原", async () => {
    await mount()
    const win = screen.getByTestId("workflow-yaml-window")
    const before = win.style.width
    fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }))
    await waitFor(() => expect(win.style.width).not.toBe(before))
    expect(win.style.width).toBe(`${window.innerWidth}px`)

    fireEvent.doubleClick(screen.getByText(/^YAML ·/))
    await waitFor(() => expect(win.style.width).toBe(before))
  })
})

describe("WorkflowYamlWindow — 动态子工作流", () => {
  beforeEach(() => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(detail())
    vi.mocked(fetchWorkflowContent).mockImplementation(async (_ws, ref, opts) => {
      if (ref === "ticket-dag" && opts?.isDynamic) return { content: CHILD_YAML }
      if (ref === "matt-spec-dev") return { content: ROOT_YAML }
      return null
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("树上列出运行时生成的子流，点开切到子流 YAML", async () => {
    await mount()
    await waitFor(() => expect(workflowRow("ticket-dag")?.getAttribute("data-status")).toBe("ready"))

    fireEvent.click(workflowRow("ticket-dag")!)
    await waitFor(() =>
      expect(screen.getByTestId("yaml-subtitle").textContent).toContain("动态子工作流"),
    )
    expect(screen.getByTestId("yaml-code").textContent).toContain("ticket-01")
    expect(screen.getByTestId("yaml-code").textContent).not.toContain("spec-resolve")
    // 动态子流没有工作区定义 → 来源切换整个隐藏（只有一个来源，没有可选项）
    expect(screen.queryByTestId("yaml-source-snapshot")).toBeNull()
    expect(screen.queryByTestId("yaml-source-current")).toBeNull()
    expect(screen.getByTestId("yaml-source-label").textContent).toContain("动态快照")
    // 子流没有工作区定义 → 不出现「快照 vs 当前」差异条
    expect(screen.queryByTestId("yaml-diff-banner")).toBeNull()
  })

  it("还没生成：树上留一条禁用的「生成中…」，SSE runtime_node_added 后自动补齐", async () => {
    let runtimeListener: ((event: MessageEvent) => void) | null = null
    vi.mocked(subscribeSSE).mockImplementation((_url, _type, listener) => {
      runtimeListener = listener
      return () => {}
    })
    vi.mocked(fetchWorkflowContent).mockImplementation(async (_ws, ref, opts) => {
      if (ref === "ticket-dag" && opts?.isDynamic) return null
      if (ref === "matt-spec-dev") return { content: ROOT_YAML }
      return null
    })

    await mount()
    await waitFor(() => expect(workflowRow("ticket-dag")?.getAttribute("data-status")).toBe("missing"))
    const pendingRow = workflowRow("ticket-dag")!
    expect(pendingRow.textContent).toContain("生成中…")
    expect(pendingRow).toBeDisabled()

    // 快照落盘后，SSE 一来就重取
    vi.mocked(fetchWorkflowContent).mockImplementation(async (_ws, ref, opts) => {
      if (ref === "ticket-dag" && opts?.isDynamic) return { content: CHILD_YAML }
      if (ref === "matt-spec-dev") return { content: ROOT_YAML }
      return null
    })
    act(() => {
      runtimeListener?.({
        data: JSON.stringify({ executionId: "exec-8f3a21c4" }),
      } as MessageEvent)
    })
    await waitFor(() => expect(workflowRow("ticket-dag")?.getAttribute("data-status")).toBe("ready"))
  })

  it("终态执行仍缺快照：说「未生成」，不说「生成中」", async () => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(detail({ status: "completed" }))
    vi.mocked(fetchWorkflowContent).mockImplementation(async (_ws, ref, opts) => {
      if (ref === "ticket-dag" && opts?.isDynamic) return null
      if (ref === "matt-spec-dev") return { content: ROOT_YAML }
      return null
    })

    await mount()
    await waitFor(() => expect(workflowRow("ticket-dag")?.getAttribute("data-status")).toBe("missing"))
    expect(workflowRow("ticket-dag")?.textContent).toContain("未生成")
    expect(workflowRow("ticket-dag")?.textContent).not.toContain("生成中")
  })
})

describe("WorkflowYamlWindow — 静态子流", () => {
  beforeEach(() => {
    vi.mocked(fetchExecutionDetail).mockResolvedValue(
      detail({ workflow_content: HELPER_ROOT }),
    )
    vi.mocked(fetchWorkflowContent).mockImplementation(async (_ws, ref) => {
      if (ref === "helper") return { content: HELPER_YAML }
      if (ref === "matt-spec-dev") return { content: HELPER_ROOT }
      return null
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("静态子流取工作区定义：没有运行快照，来源切换隐藏", async () => {
    await mount()
    await waitFor(() => expect(workflowRow("helper")?.getAttribute("data-status")).toBe("ready"))
    expect(workflowRow("helper")?.textContent).toContain("子流")

    fireEvent.click(workflowRow("helper")!)
    await waitFor(() =>
      expect(screen.getByTestId("yaml-code").textContent).toContain("helper-node"),
    )
    expect(screen.getByTestId("yaml-subtitle").textContent).toContain("子工作流")
    expect(screen.queryByTestId("yaml-source-snapshot")).toBeNull()
    expect(screen.queryByTestId("yaml-source-current")).toBeNull()
    expect(screen.getByTestId("yaml-source-label").textContent).toBe("当前定义")
  })
})
