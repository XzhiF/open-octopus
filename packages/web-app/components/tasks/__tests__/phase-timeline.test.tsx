// 票 11 AC3 + AC4 组件级渲染矩阵：PhaseTimeline（v4 多 phase / v3 legacy 单行 /
// 缺 derived 静默 / round chips / ⏳ 超预算）。
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { TaskDerivedView, TaskPhaseView, TaskRoundView } from "@/lib/tasks-api"
import { PhaseTimeline } from "../phase-timeline"

const NOW = Date.parse("2026-09-01T12:00:00Z")

function d(over: Omit<Partial<TaskDerivedView>, "phaseViews"> & { phaseViews?: unknown[] } = {}): TaskDerivedView {
  return {
    taskStatus: "running",
    isV4: true,
    phaseViews: [],
    ...over,
  } as unknown as TaskDerivedView
}

const round = (
  roundIndex: number,
  state: TaskRoundView["state"],
  decision: TaskRoundView["decision"],
  createdAt = "2026-09-01T11:59:00Z",
): TaskRoundView => ({
  roundIndex,
  state,
  decision,
  exec: { id: `e${roundIndex}`, status: state, phase_index: 1, round_index: roundIndex, created_at: createdAt },
})

const phase = (over: Partial<TaskPhaseView> & { index: number }): TaskPhaseView => ({
  name: `P${over.index}`,
  slug: `s${over.index}`,
  workflowRef: "builtin:x",
  status: "pending",
  rounds: [],
  currentRound: null,
  acceptedRound: null,
  awaitingRound: null,
  ...over,
} as TaskPhaseView)

describe("PhaseTimeline — v4 多 phase (AC3 行数=phases 数)", () => {
  const derived = d({
    phaseViews: [
      {
        index: 1, name: "认证地基", slug: "auth", workflowRef: "builtin:task-dev",
        status: "accepted", rounds: [round(1, "failed", "rejected"), round(2, "succeeded", "accepted")],
        currentRound: 2, acceptedRound: 2, awaitingRound: null,
      },
      {
        index: 2, name: "看板改造", slug: "board", workflowRef: "builtin:task-fix",
        status: "running", rounds: [round(1, "running", null)],
        currentRound: 1, acceptedRound: null, awaitingRound: null,
      },
      {
        index: 3, name: "归档收尾", slug: "archive", workflowRef: "builtin:task-archive",
        status: "pending", rounds: [], currentRound: null, acceptedRound: null, awaitingRound: null,
      },
    ],
  })

  it("每个 phase 一行，含名/workflowRef/状态标签 (AC3 行数=phases 数)", () => {
    render(<PhaseTimeline derived={derived} now={NOW} />)
    expect(screen.getAllByTestId(/^phase-row-/)).toHaveLength(3)
    expect(screen.getByText("认证地基")).toBeTruthy()
    expect(screen.getByText("看板改造")).toBeTruthy()
    expect(screen.getByText("归档收尾")).toBeTruthy()
    expect(screen.getByText("builtin:task-dev")).toBeTruthy()
    expect(screen.getByText("builtin:task-fix")).toBeTruthy()
    expect(screen.getByText("builtin:task-archive")).toBeTruthy()
    expect(screen.getByText("已通过")).toBeTruthy()
    expect(screen.getByText("执行中")).toBeTruthy()
    expect(screen.getByText("未开始")).toBeTruthy()
  })

  it("rounds 历史 chips 可追溯（r1 打回 + r2 通过）", () => {
    render(<PhaseTimeline derived={derived} now={NOW} />)
    expect(screen.getByTestId("phase-round-1-1")).toBeTruthy() // phase1 R1
    expect(screen.getByTestId("phase-round-1-2")).toBeTruthy() // phase1 R2
    expect(screen.getByText(/R1.*✗|✗/)).toBeTruthy()
    expect(screen.getByText(/✓/)).toBeTruthy()
  })

  it("awaiting_review 行有琥珀标识", () => {
    const awaiting = d({
      taskStatus: "awaiting_review",
      phaseViews: [
        {
          index: 1, name: "认证", slug: "a", workflowRef: "builtin:x",
          status: "awaiting_review", rounds: [round(1, "failed", null)],
          currentRound: 1, acceptedRound: null, awaitingRound: 1,
        },
      ],
    })
    render(<PhaseTimeline derived={awaiting} now={NOW} />)
    const row = screen.getByTestId("phase-row-1")
    expect(row.getAttribute("data-phase-status")).toBe("awaiting_review")
    expect(row.className).toContain("amber")
    expect(screen.getByText("待验收")).toBeTruthy()
  })
})

describe("PhaseTimeline — v3 legacy 单行 (AC3 不报错)", () => {
  it("isV4=false → 恰好一行 legacy", () => {
    render(<PhaseTimeline derived={d({ isV4: false, taskStatus: "running", phaseViews: [] })} now={NOW} />)
    const rows = screen.getAllByTestId(/^phase-row-/)
    expect(rows).toHaveLength(1)
    expect(screen.getByText(/^v3 单阶段/)).toBeTruthy()
  })

  it("derived 缺失（旧 server/mock）→ 静默不渲染，不抛错", () => {
    const { container } = render(<PhaseTimeline derived={undefined} now={NOW} />)
    expect(container.firstChild).toBeNull()
  })

  it("v4 但 phaseViews 空（作者未拆分）→ 0 行不抛错", () => {
    render(<PhaseTimeline derived={d({ phaseViews: [] })} now={NOW} />)
    expect(screen.queryAllByTestId(/^phase-row-/)).toHaveLength(0)
  })
})

describe("PhaseTimeline — ⏳ 超预算 (AC4)", () => {
  const running2h = d({
    phaseViews: [
      {
        index: 1, name: "长跑", slug: "a", workflowRef: "builtin:x",
        status: "running",
        rounds: [round(1, "running", null, "2026-09-01T10:00:00Z")],
        currentRound: 1, acceptedRound: null, awaitingRound: null,
      },
    ],
  })

  it("env 注入小阈值（budget=1s）→ 在跑轮出现 ⏳", () => {
    render(<PhaseTimeline derived={running2h} now={NOW} budgetMs={1000} />)
    const chip = screen.getByTestId("phase-round-1-1")
    expect(chip.getAttribute("data-overbudget")).toBe("true")
    expect(chip.textContent).toContain("⏳")
  })

  it("默认 1.5h 阈值 → 2h 在跑轮同样超（>1.5h）", () => {
    render(<PhaseTimeline derived={running2h} now={NOW} budgetMs={5_400_000} />)
    expect(screen.getByTestId("phase-round-1-1").getAttribute("data-overbudget")).toBe("true")
  })

  it("终态轮不标 ⏳ (advisory 只对在跑轮)", () => {
    render(<PhaseTimeline
      derived={d({
        phaseViews: [{
          index: 1, name: "已完", slug: "a", workflowRef: "builtin:x", status: "awaiting_review",
          rounds: [round(1, "succeeded", null, "2026-01-01T00:00:00Z")],
          currentRound: 1, acceptedRound: null, awaitingRound: 1,
        }],
      })}
      now={NOW} budgetMs={1}
    />)
    expect(screen.getByTestId("phase-round-1-1").getAttribute("data-overbudget")).toBe("false")
  })
})
