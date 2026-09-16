// execution-summary 纯件回归（2026-09-21 执行弹窗改版后，本文件只剩公共词表/
// 判据/plumbing 与两张卡 —— 弹窗主体迁入 run-console/__tests__/task-run-console.test.tsx）。
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import type { TaskExecutionBadge } from "@/lib/tasks-api"

vi.mock("@/lib/observability-api", () => ({ fetchLLMCalls: vi.fn() }))
vi.mock("@/lib/sse-manager", () => ({ subscribeSSE: () => () => {} }))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))
vi.mock("../authoring/artifact-viewer-dialog", () => ({ ArtifactViewerDialog: () => null }))

import {
  runErrorOf, RUN_ERROR_STATUSES, execLabel, deepLinkTarget, mergeAggregates, TaskAiUsageCard,
} from "../execution-summary"
import type { LLMCallAggregates } from "@/lib/types"

const row = (over: Partial<TaskExecutionBadge>): TaskExecutionBadge => ({
  id: "e1", status: "running", workflow_ref: "wf", name: null,
  phase_index: null, round_index: null, workspace_id: "ws-1",
  started_at: null, completed_at: null, created_at: "2026-09-21T00:00:00Z", error_summary: null,
  ...over,
})

const AGG_A = {
  totalCalls: 2, toolCalls: 3,
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 150 },
  totals: { tokens: 150, cost: { usd: 1, complete: true } },
  modelBreakdown: { "m1": { calls: 2, inputTokens: 100, outputTokens: 50, costUsd: 1 } },
} as unknown as LLMCallAggregates

const AGG_B = {
  totalCalls: 1, toolCalls: 0,
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 15 },
  totals: { tokens: 15, cost: { usd: 0.5, complete: false } },
  modelBreakdown: { "m1": { calls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.5 }, "m2": { calls: 1, inputTokens: 0, outputTokens: 0, costUsd: null } },
} as unknown as LLMCallAggregates

describe("runErrorOf — 票05 §新事实-2 状态门控", () => {
  it("红词表才放行；绿行带遗留键也返回 null", () => {
    expect(RUN_ERROR_STATUSES.has("failed")).toBe(true)
    expect(runErrorOf(row({ status: "failed", error_summary: "x" }))).toBe("x")
    expect(runErrorOf(row({ status: "aborted", error_summary: "x" }))).toBe("x")
    expect(runErrorOf(row({ status: "completed_with_failures", error_summary: "x" }))).toBe("x")
    expect(runErrorOf(row({ status: "completed", error_summary: "x" }))).toBeNull()
    expect(runErrorOf(row({ status: "running", error_summary: "x" }))).toBeNull()
  })
})

describe("execLabel / deepLinkTarget", () => {
  it("v4 phase/round 落行 → 轮次标题优先；否则 name → workflow_ref → id", () => {
    expect(execLabel(row({ phase_index: 2, round_index: 3 }))).toBe("Phase 2 · Round 3")
    expect(execLabel(row({ phase_index: 1 }))).toBe("Phase 1")
    expect(execLabel(row({ name: "后端" }))).toBe("后端")
    expect(execLabel(row({}))).toBe("wf")
  })
  it("深链 = workspace 执行详情；无 workspace_id → null", () => {
    expect(deepLinkTarget(row({ id: "e9", workspace_id: "ws-1" }))).toBe("/workspaces/ws-1?tab=detail&execId=e9")
    expect(deepLinkTarget(row({ workspace_id: "" }))).toBeNull()
  })
})

describe("mergeAggregates — C3 合并单源", () => {
  it("逐模型合并 + 成本 complete 取与", () => {
    const m = mergeAggregates([AGG_A, AGG_B])!
    expect(m.totalCalls).toBe(3)
    expect(m.modelBreakdown["m1"].calls).toBe(3)
    expect(m.modelBreakdown["m1"].costUsd).toBe(1.5)
    expect(m.modelBreakdown["m2"].costUsd).toBeNull()
    expect(m.totals.cost.complete).toBe(false)
  })
  it("空表 → null（无数据不臆造）", () => {
    expect(mergeAggregates([])).toBeNull()
  })
})

describe("TaskAiUsageCard（ADR-0022 三层完整口径：总计/按模型/分轮）", () => {
  it("无 run 不渲染；有账 → 七量纲瓷砖 + 模型行 + 分轮行", () => {
    const { rerender } = render(<TaskAiUsageCard agg={null} loading={false} runCount={0} />)
    expect(screen.queryByText("任务 AI 消耗")).toBeNull()
    rerender(
      <TaskAiUsageCard
        agg={AGG_A} loading={false} runCount={2}
        rounds={[{ key: "e1", label: "Phase 1 · Round 1", agg: AGG_A }, { key: "e2", label: "Phase 1 · Round 2", agg: null }]}
      />,
    )
    expect(screen.getByText("任务 AI 消耗")).toBeTruthy()
    // 总计瓷砖标签 + 三层小标题
    expect(screen.getByText("总计")).toBeTruthy()
    expect(screen.getByText("按模型")).toBeTruthy()
    expect(screen.getByText("分轮账本")).toBeTruthy()
    // 模型以整行呈现（名字在），不再是旧的 `m×N` 徽章
    expect(screen.getByText("m1")).toBeTruthy()
    expect(screen.queryByText(/m1×\d/)).toBeNull()
    // 分轮：缺数轮标「缺数」不臆造
    expect(screen.getByText("Phase 1 · Round 1")).toBeTruthy()
    expect(screen.getByText("缺数")).toBeTruthy()
  })
})
