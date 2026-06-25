import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AlertCard } from "../alert-card"
import type { Alert } from "@/lib/analytics-types"

const mockAlert: Alert = {
  id: "test-alert-1",
  severity: "critical",
  category: "consecutive_failures",
  title: "workflow-x 连续失败 4 次",
  description: "从 2026-06-01 开始",
  workflow_ref: "workflow-x",
  metadata: { streakLength: 4 },
  detected_at: "2026-06-04T14:32:00Z",
}

describe("AlertCard", () => {
  it("渲染告警标题和描述", () => {
    render(<AlertCard alert={mockAlert} onDrillDown={() => {}} />)
    expect(screen.getByText("workflow-x 连续失败 4 次")).toBeInTheDocument()
    expect(screen.getByText("从 2026-06-01 开始")).toBeInTheDocument()
  })

  it("critical 级别显示 destructive 样式", () => {
    const { container } = render(<AlertCard alert={mockAlert} onDrillDown={() => {}} />)
    const card = container.firstElementChild
    expect(card?.className).toContain("border-l-destructive")
  })

  it("warning 级别显示 amber 样式", () => {
    const warningAlert = { ...mockAlert, severity: "warning" as const }
    const { container } = render(<AlertCard alert={warningAlert} onDrillDown={() => {}} />)
    const card = container.firstElementChild
    expect(card?.className).toContain("amber")
  })

  it("点击查看详情触发 onDrillDown", () => {
    const onDrillDown = vi.fn()
    render(<AlertCard alert={mockAlert} onDrillDown={onDrillDown} />)
    fireEvent.click(screen.getByText("查看详情"))
    expect(onDrillDown).toHaveBeenCalledWith(mockAlert)
  })
})
