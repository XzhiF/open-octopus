// 票 04 · ◆ 节点页签 —— NodesTab 组件测试（seam = 壳内 [data-tab-host="nodes"]
// 挂载的统一只读清单）。期望行为逐条对票 04 AC：
//   AC1 执行中可见节点清单 + 当前节点高亮 + 随执行推进刷新（5s 轮询）
//   AC2 展开行看事件流，干预数据出 ⚑ 行
//   AC3 深链携带执行上下文（既有执行详情视图 /workspaces/:ws?tab=detail&execId=）
//   AC4 只读：无任何变更类按钮
//   AC5 abort 后 ⏹ 语义而非误导性「进行中」
// 数据全部走既有端点（execution 详情 + agent-events），零新增后端。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react"
import type { TaskExecutionBadge } from "@octopus/shared"
import type { AgentEvent, StepExecution } from "@/lib/types"

const { mockFetchExecutionDetail, mockFetchAgentEvents } = vi.hoisted(() => ({
  mockFetchExecutionDetail: vi.fn(),
  mockFetchAgentEvents: vi.fn(),
}))

vi.mock("@/lib/api-client", () => ({
  fetchExecutionDetail: mockFetchExecutionDetail,
  fetchAgentEvents: mockFetchAgentEvents,
}))
vi.mock("@/lib/server-config", () => ({ getServerUrl: () => "http://localhost:3001" }))

import { NodesTab } from "../nodes-tab"

// ── fixtures（task-fix 真实节点集：precheck → fix → fail-fast）────────

const YAML = `
name: task-fix
nodes:
  - id: precheck
    type: bash
  - id: fix
    name: 修复轮 · 按反馈修改
    type: agent
  - id: fail-fast
    type: bash
`

function badge(status: string, over: Partial<TaskExecutionBadge> = {}): TaskExecutionBadge {
  return {
    id: "exec-1", status, workflow_ref: "built-in/task-fix", name: null,
    phase_index: 1, round_index: 2, workspace_id: "ws-1",
    started_at: "2026-10-08T09:00:00Z",
    completed_at: ["completed", "failed", "cancelled", "aborted"].includes(status) ? "2026-10-08T09:10:00Z" : null,
    created_at: "2026-10-08T08:59:00Z", error_summary: null,
    ...over,
  }
}

function detail(over: Record<string, unknown> = {}) {
  return {
    id: "exec-1", status: "running", workflow_ref: "built-in/task-fix",
    workflow_content: YAML,
    steps: [
      { stepId: "precheck", stepName: "precheck", status: "completed", duration: 22, costUsd: 0, costComplete: true, startedAt: "2026-10-08T09:00:00Z", completedAt: "2026-10-08T09:00:22Z" },
      { stepId: "fix", stepName: "fix", status: "running", startedAt: "2026-10-08T09:00:22Z" },
    ] as StepExecution[],
    ...over,
  }
}

const renderTab = (run: TaskExecutionBadge | null, mode: "flow" | "takeover" | "fixing" = "flow", live = true) =>
  render(<NodesTab run={run} mode={mode} live={live} />)

beforeEach(() => {
  mockFetchExecutionDetail.mockReset()
  mockFetchAgentEvents.mockReset()
  mockFetchAgentEvents.mockResolvedValue({ executionId: "exec-1", events: [], source: "sqlite", _degraded: false, _message: null })
})
afterEach(() => { vi.useRealTimers() })

describe("NodesTab — AC1 节点清单 + 高亮 + 刷新", () => {
  it("执行中：三行清单 ✓/●/○、类型徽标（Agent/Bash）、用时成本列、1/3 完成、当前节点行高亮", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail())
    renderTab(badge("running"))
    expect(await screen.findByTestId("node-row-fail-fast")).toBeTruthy()

    const rows = () => screen.getAllByTestId(/^node-row/)
    expect(rows()).toHaveLength(3)
    expect(screen.getByTestId("node-row-precheck").textContent).toContain("✓")
    expect(screen.getByTestId("node-row-fix").textContent).toContain("●")
    expect(screen.getByTestId("node-row-fail-fast").textContent).toContain("○")
    // 人可读名（YAML name 优先）
    expect(screen.getByTestId("node-row-fix").textContent).toContain("修复轮 · 按反馈修改")
    // 类型徽标
    expect(screen.getByTestId("node-row-precheck").textContent).toContain("Bash")
    expect(screen.getByTestId("node-row-fix").textContent).toContain("Agent")
    // 用时/成本：完成行给落库用时；进行中行 ⏱ 走秒；未执行 —
    expect(screen.getByTestId("node-row-precheck").textContent).toContain("22s")
    expect(screen.getByTestId("node-row-fail-fast").textContent).toContain("—")
    // 当前节点高亮 + N/M 完成汇总
    expect(screen.getByTestId("node-row-fix").getAttribute("data-node-current")).toBe("true")
    expect(screen.getByTestId("nodes-summary").textContent).toContain("1/3")
    // 页签头：workflow_ref + P·R 语境
    expect(screen.getByTestId("nodes-wf-pill").textContent).toContain("task-fix")
    expect(screen.getByTestId("nodes-wf-pill").textContent).not.toContain("built-in/")
    expect(screen.getByTestId("nodes-scope").textContent).toContain("P1·R2")
  })

  it("状态随执行推进刷新：5s 轮询拉到 fix=completed/fail-fast=running 后，● 从 fix 行移到 fail-fast 行", async () => {
    vi.useFakeTimers()
    mockFetchExecutionDetail.mockResolvedValueOnce(detail())
    mockFetchExecutionDetail.mockResolvedValue(detail({
      steps: [
        { stepId: "precheck", stepName: "precheck", status: "completed", duration: 22 },
        { stepId: "fix", stepName: "fix", status: "completed", duration: 120 },
        { stepId: "fail-fast", stepName: "fail-fast", status: "running", startedAt: "2026-10-08T09:02:22Z" },
      ] as StepExecution[],
    }))
    renderTab(badge("running"))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId("node-row-fix").getAttribute("data-node-state")).toBe("live")

    await act(async () => { vi.advanceTimersByTime(5100); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId("node-row-fix").getAttribute("data-node-state")).toBe("done")
    expect(screen.getByTestId("node-row-fail-fast").getAttribute("data-node-state")).toBe("live")
    expect(mockFetchExecutionDetail).toHaveBeenCalledTimes(2)
  })

  it("run=null（ready 未触发）：空态话术，不发请求", async () => {
    renderTab(null)
    expect(await screen.findByTestId("nodes-empty")).toBeTruthy()
    expect(screen.getByText(/尚无绑定执行/)).toBeTruthy()
    expect(mockFetchExecutionDetail).not.toHaveBeenCalled()
  })
})

describe("NodesTab — AC2 展开事件流 + ⚑ 行", () => {
  it("点行展开：懒加载该执行的事件流并渲染；harness 干预数据出 ⚑ 行；再点收起", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail())
    mockFetchAgentEvents.mockResolvedValue({
      executionId: "exec-1", source: "sqlite", _degraded: false, _message: null,
      events: [
        { nodeId: "fix", event: "tool_call", toolName: "Read", input: { file_path: "fix-feedback-r1.md" } },
        { nodeId: "fix", event: "harness_directive", data: { directive: "禁止夹带范围外改动" } },
        { nodeId: "precheck", event: "bash_output", content: "PRECHECK OK" },
      ] as AgentEvent[],
    })
    renderTab(badge("running"))
    await screen.findByTestId("node-row-fix")
    expect(mockFetchAgentEvents).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("node-row-fix"))
    await waitFor(() => expect(mockFetchAgentEvents).toHaveBeenCalledWith("ws-1", "exec-1"))
    const panel = await screen.findByTestId("node-events-fix")
    // 只有 fix 本体的事件进面板（precheck 的不串门）
    const lines = panel.querySelectorAll("[data-node-event]")
    expect(lines).toHaveLength(2)
    expect(lines[0].textContent).toContain("Read")
    // ⚑ 干预行（06 注入干预的验证面；无 06 时以既有 harness 干预数据验证渲染）
    const iv = panel.querySelectorAll("[data-node-intervention]")
    expect(iv).toHaveLength(1)
    expect(iv[0].textContent).toContain("⚑")
    expect(iv[0].textContent).toContain("禁止夹带范围外改动")

    fireEvent.click(screen.getByTestId("node-row-fix"))
    expect(screen.queryByTestId("node-events-fix")).toBeNull()
  })

  it("未执行节点展开：如实「— 未执行 —」，不编造事件", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail())
    renderTab(badge("running"))
    await screen.findByTestId("node-row-fail-fast")
    fireEvent.click(screen.getByTestId("node-row-fail-fast"))
    const panel = await screen.findByTestId("node-events-fail-fast")
    expect(panel.textContent).toContain("未执行")
  })
})

describe("NodesTab — AC3 深链 + AC4 只读", () => {
  it("深链按钮携带执行上下文：新 tab 打开既有执行详情视图（workspace + execId）", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail())
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    renderTab(badge("running"))
    const link = await screen.findByTestId("nodes-deeplink")
    fireEvent.click(link)
    expect(openSpy).toHaveBeenCalledWith("/workspaces/ws-1?tab=detail&execId=exec-1", "_blank", expect.any(String))
    openSpy.mockRestore()
  })

  it("只读页签：清单内不出现任何变更类按钮（重试/重置/跳过/中止/暂停/恢复/审批…）", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail())
    renderTab(badge("running"))
    await screen.findByTestId("node-row-precheck")
    const host = document.querySelector("[data-nodes-tab]")!
    const words = ["重试", "重置", "跳过", "中止", "暂停", "恢复", "干预", "审批", "通过", "打回", "终止执行", "注入"]
    for (const b of Array.from(host.querySelectorAll("button"))) {
      for (const w of words) expect(b.textContent ?? "").not.toContain(w)
    }
  })
})

describe("NodesTab — AC5 终止态 + 接管/修复轮形态", () => {
  it("abort（cancelled 执行行）后：现场节点 ⏹ 带「已终止」标，未执行节点 ⏹ 灰，全场无 ●", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail({ status: "cancelled", completed_at: "2026-10-08T09:10:00Z" }))
    renderTab(badge("cancelled"))
    await screen.findByTestId("node-row-fail-fast")
    expect(screen.getByTestId("node-row-precheck").textContent).toContain("✓")
    expect(screen.getByTestId("node-row-fix").textContent).toContain("⏹")
    expect(screen.getByTestId("node-row-fix").textContent).toContain("已终止")
    expect(screen.getByTestId("node-row-fail-fast").textContent).toContain("⏹")
    const host = document.querySelector("[data-nodes-tab]")!
    expect(host.textContent).not.toContain("●")
    expect(screen.getByTestId("nodes-state-line").textContent).toContain("绑定执行已终止")
  })

  it("takeover（08 将点亮 shellMode=takeover）：⏹ 语义 + 「工作流已停 · 人工接管中」", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail({ status: "cancelled" }))
    renderTab(badge("cancelled"), "takeover")
    await screen.findByTestId("node-row-fail-fast")
    expect(screen.getByTestId("nodes-state-line").textContent).toContain("人工接管中")
    expect(screen.getByTestId("node-row-fix").textContent).toContain("⏹")
  })

  it("paused 执行：现场节点 ⏸ + 头部「已暂停，等待干预」", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail({ status: "paused" }))
    renderTab(badge("paused"))
    await screen.findByTestId("node-row-fix")
    expect(screen.getByTestId("node-row-fix").textContent).toContain("⏸")
    expect(screen.getByTestId("nodes-state-line").textContent).toContain("已暂停，等待干预")
  })

  it("修复轮（built-in/task-fix）在同一组件自动推进直播：头部青「task-fix 推进中」", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail())
    renderTab(badge("running"))
    await screen.findByTestId("nodes-state-line")
    expect(screen.getByTestId("nodes-state-line").textContent).toContain("task-fix 推进中")
  })
})

describe("NodesTab — 降级", () => {
  it("workflow_content 缺失：steps 兜底出行（执行过的节点不至于空白）", async () => {
    mockFetchExecutionDetail.mockResolvedValue(detail({ workflow_content: null }))
    renderTab(badge("running"))
    await screen.findByTestId("node-row-precheck")
    expect(screen.getByTestId("node-row-fix")).toBeTruthy()
    expect(screen.getByTestId("node-row-fix")).toBeTruthy()
  })

  it("详情读取失败：如实报错行，不崩", async () => {
    mockFetchExecutionDetail.mockRejectedValue(new Error("workspace not found"))
    renderTab(badge("running"))
    expect(await screen.findByTestId("nodes-error")).toBeTruthy()
  })
})
