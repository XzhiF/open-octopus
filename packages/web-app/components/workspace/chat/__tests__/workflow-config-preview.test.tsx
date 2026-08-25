import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { WorkflowConfigPreview } from "../workflow-config-preview"

const validConfig = {
  schema_version: "2.0",
  type: "workflow",
  workspace_spec: {
    org: "xzf",
    branch_prefix: "log-cleanup",
    projects: [{ name: "open-octopus", source_path: "", group: "" }],
  },
  workflow_chain: [{ workflow_ref: "test-task-workflow.yaml", input_values: {} }],
  max_retain: 10,
}

describe("T-11: WorkflowConfigPreview", () => {
  // AC24: 提取的 JSON 通过 workflowConfigSchema.parse() → 显示预览卡
  it("AC24: 有效 JSON → 渲染预览卡（workspace_spec / workflow_chain / max_retain）", () => {
    const content = "```json\n" + JSON.stringify(validConfig) + "\n```"
    render(<WorkflowConfigPreview content={content} />)
    expect(screen.getByTestId("workflow-config-preview")).toBeInTheDocument()
    expect(screen.getByText("xzf")).toBeInTheDocument()
    expect(screen.getByText("log-cleanup")).toBeInTheDocument()
    expect(screen.getByText(/test-task-workflow\.yaml/)).toBeInTheDocument()
    expect(screen.getByText("10")).toBeInTheDocument()
  })

  // AC25: parse 失败 → inline error + "重新生成" 按钮
  it("AC25: JSON.parse 失败 → inline error + 重新生成按钮", () => {
    const content = "```json\n{ broken json\n```"
    render(<WorkflowConfigPreview content={content} onRetry={() => {}} />)
    expect(screen.getByTestId("workflow-config-error")).toBeInTheDocument()
    expect(screen.getByText(/JSON/i)).toBeInTheDocument()
    expect(screen.getByTestId("workflow-config-retry")).toBeInTheDocument()
  })

  // AC25 反假跑: 故意构造错误 JSON → 按钮可点
  it("AC25 反假跑: 重新生成按钮点击触发 onRetry", () => {
    const content = "```json\n{ broken\n```"
    const onRetry = vi.fn()
    render(<WorkflowConfigPreview content={content} onRetry={onRetry} />)
    const button = screen.getByTestId("workflow-config-retry")
    fireEvent.click(button)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("no fenced block → render null (no preview, no error)", () => {
    const { container } = render(<WorkflowConfigPreview content="plain text" />)
    expect(container.firstChild).toBeNull()
  })

  it("schema error (workflow_chain empty) → inline error", () => {
    const broken = { ...validConfig, workflow_chain: [] }
    const content = "```json\n" + JSON.stringify(broken) + "\n```"
    render(<WorkflowConfigPreview content={content} />)
    expect(screen.getByTestId("workflow-config-error")).toBeInTheDocument()
  })
})
