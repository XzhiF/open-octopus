// 验收方案状态卡（2026-10-31 删旧编译清单后）—— 无 ready 方案时第三步只挂这张卡。
// 纪律：不编造清单；无场景硬闸；归档只读不给重新生成。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const { mockRegenerate, mockToast } = vi.hoisted(() => ({
  mockRegenerate: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/tasks-api", () => ({ regenerateAcceptancePlan: mockRegenerate }))
vi.mock("sonner", () => ({ toast: mockToast }))

import { PlanStatusCard } from "../plan-status-card"

function renderCard(props: Partial<Parameters<typeof PlanStatusCard>[0]> = {}) {
  const onRegenerated = vi.fn()
  const utils = render(
    <PlanStatusCard
      taskId="t1"
      roundIndex={1}
      status="missing"
      readOnly={false}
      onRegenerated={onRegenerated}
      {...props}
    />,
  )
  return { ...utils, onRegenerated }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRegenerate.mockResolvedValue({ ok: true })
})

describe("PlanStatusCard", () => {
  it("generating：说明生成中，无重新生成按钮", () => {
    renderCard({ status: "generating" })
    const card = screen.getByTestId("plan-status-card")
    expect(card.getAttribute("data-plan-status")).toBe("generating")
    expect(card.textContent).toContain("验收方案生成中")
    expect(card.textContent).toContain("仍可以直接通过或退回")
    expect(screen.queryByTestId("plan-regenerate")).toBeNull()
  })

  it("failed：显示原因，重新生成调用 API 并通知父级", async () => {
    const { onRegenerated } = renderCard({ status: "failed", error: "steps 超限" })
    const card = screen.getByTestId("plan-status-card")
    expect(card.textContent).toContain("验收方案生成失败")
    expect(card.textContent).toContain("steps 超限")
    fireEvent.click(screen.getByTestId("plan-regenerate"))
    await waitFor(() => expect(mockRegenerate).toHaveBeenCalledWith("t1"))
    await waitFor(() => expect(onRegenerated).toHaveBeenCalledTimes(1))
    expect(mockToast.success).toHaveBeenCalled()
  })

  it("failed 被拒：toast 原因，不通知父级", async () => {
    mockRegenerate.mockResolvedValueOnce({ ok: false, reason: "已有人工勾选" })
    const { onRegenerated } = renderCard({ status: "failed" })
    fireEvent.click(screen.getByTestId("plan-regenerate"))
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining("已有人工勾选")))
    expect(onRegenerated).not.toHaveBeenCalled()
  })

  it("missing：明示无方案但仍可拍板", () => {
    renderCard({ status: "missing" })
    const card = screen.getByTestId("plan-status-card")
    expect(card.textContent).toContain("本轮没有验收方案")
    expect(card.textContent).toContain("没有场景清单时不设硬闸")
    expect(screen.queryByTestId("plan-regenerate")).toBeNull()
  })

  it("readOnly（归档回看）：以台账为准，无重新生成", () => {
    renderCard({ status: "missing", readOnly: true })
    const card = screen.getByTestId("plan-status-card")
    expect(card.getAttribute("data-plan-status")).toBe("archived")
    expect(card.textContent).toContain("本轮没有可回看的验收方案")
    expect(card.textContent).toContain("acceptance-ledger-r1.md")
    expect(screen.queryByTestId("plan-regenerate")).toBeNull()
  })

  it("ready 但清单为空（理论态）按无方案处理", () => {
    renderCard({ status: "ready" })
    expect(screen.getByTestId("plan-status-card").getAttribute("data-plan-status")).toBe("missing")
    expect(screen.getByText("本轮没有验收方案")).toBeTruthy()
  })
})
