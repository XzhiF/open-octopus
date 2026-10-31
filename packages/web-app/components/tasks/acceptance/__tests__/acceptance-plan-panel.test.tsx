// 验收方案面板（2026-10-31 两层化）组件测试：
//   · 左栏两段：你要验的（cases）/ 本轮验证了什么（checks）；
//   · gate 只统计场景，机器证据不进入人工判定；
//   · 证据详情只读（无通过/不通过），复核命令只在点名时执行。

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { PlaybookPayload } from "@/lib/tasks-api"
import { AcceptancePlanPanel } from "../acceptance-plan-panel"

const { mockReadChecks, mockRecordCheck, mockRunProbe } = vi.hoisted(() => ({
  mockReadChecks: vi.fn(),
  mockRecordCheck: vi.fn(),
  mockRunProbe: vi.fn(),
}))

vi.mock("@/lib/tasks-api", () => ({
  readChecks: mockReadChecks,
  recordAcceptanceCheck: mockRecordCheck,
  regenerateAcceptancePlan: vi.fn(),
  runProbe: mockRunProbe,
}))

vi.mock("@/lib/sse-manager", () => ({
  subscribeSSE: vi.fn(() => () => {}),
}))

vi.mock("@/lib/server-config", () => ({
  getServerUrl: () => "http://127.0.0.1:3001",
}))

function plan(): PlaybookPayload {
  return {
    available: true,
    goal: "短语匹配查询可用",
    specRevised: false,
    budget: { steps: 1, estMin: 2, over: false, degraded: false },
    sections: [
      {
        kind: "walk",
        title: "你要验的",
        source: "acceptance-plan-r1.json",
        items: [{
          id: "case:1",
          op: "输入短语能查到记录",
          expect: "主路径能查到、边界不崩",
          title: "输入短语能查到记录",
          tier: "case",
          story: "作为使用者，我想按短语查记录",
          tickets: ["01-phrase-matcher"],
          steps: [
            { kind: "open", text: "打开搜索页", target: "http://localhost:3000/search" },
            { kind: "do", text: "输入短语", value: "quick brown" },
            { kind: "observe", text: "看到 3 条，完整短语高亮", expect: "命中项包含原始短语" },
          ],
          evidenceRefs: [],
        }],
      },
      {
        kind: "claim",
        title: "本轮验证了什么",
        source: "acceptance-plan-r1.json",
        items: [{
          id: "check:unit",
          op: "短语匹配单测",
          expect: "覆盖 AC1",
          title: "短语匹配单测",
          tier: "check",
          tickets: ["01-phrase-matcher"],
          criteria: ["短语整体命中", "大小写不敏感"],
          recheck: "cd projects/api && mvn -B test",
          evidenceRefs: [{ kind: "test", label: "PhraseMatcherTest", path: ".scratch/b/round-report.md" }],
        }],
      },
    ],
    finePrint: [],
    carryover: [],
    coverage: { found: [], missing: [] },
    plan: { status: "ready" },
  }
}

beforeEach(() => {
  mockReadChecks.mockReset().mockResolvedValue({ version: "1", checks: {} })
  mockRecordCheck.mockReset().mockResolvedValue({
    checks: { version: "1", checks: { "case:1": { decision: "pass", note: "", at: "t" } } },
    itemId: "case:1",
    decision: "pass",
  })
  mockRunProbe.mockReset().mockResolvedValue({
    state: "passed", exit_code: 0, duration_ms: 1200, tail: ["Tests run: 6, Failures: 0"],
  })
})

describe("AcceptancePlanPanel (two tiers)", () => {
  it("renders both groups and counts only human cases in the gate", async () => {
    const onGate = vi.fn()
    render(
      <AcceptancePlanPanel
        taskId="t-1"
        batchRelDir=".scratch/b"
        roundIndex={1}
        playbook={plan()}
        onGate={onGate}
      />,
    )
    expect(screen.getByTestId("plan-group-cases").textContent).toContain("你要验的")
    expect(screen.getByTestId("plan-group-evidence").textContent).toContain("本轮验证了什么")
    // 人层 1 条；机器证据 1 项不进 gate
    await waitFor(() => expect(onGate).toHaveBeenCalled())
    expect(onGate.mock.calls.at(-1)![0]).toMatchObject({ total: 1, undecided: 1 })

    // 场景详情：有结论条与场景步骤
    expect(screen.getByTestId("plan-decide")).toBeTruthy()
    expect(screen.getByText("打开搜索页")).toBeTruthy()
    expect(screen.getByText("看到 3 条，完整短语高亮")).toBeTruthy()
  })

  it("shows machine evidence as read-only: no verdict bar, run only on demand", async () => {
    render(
      <AcceptancePlanPanel
        taskId="t-1"
        batchRelDir=".scratch/b"
        roundIndex={1}
        playbook={plan()}
        onGate={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("plan-item-check:unit"))

    expect(screen.getByText(/机器证据 1 \/ 1/)).toBeTruthy()
    expect(screen.getByText(/不需要你逐项确认/)).toBeTruthy()
    expect(screen.queryByTestId("plan-decide")).toBeNull()
    expect(screen.queryByTestId("plan-pass")).toBeNull()

    // 复核命令不自动跑：只有点「跑一下」才发请求
    expect(mockRunProbe).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("plan-run-probe"))
    await waitFor(() => expect(mockRunProbe).toHaveBeenCalledWith("t-1", "cd projects/api && mvn -B test", 300))
    await waitFor(() => expect(screen.getByTestId("plan-probe-result")).toBeTruthy())
  })

  it("records a decision only for a scenario", async () => {
    render(
      <AcceptancePlanPanel
        taskId="t-1"
        batchRelDir=".scratch/b"
        roundIndex={1}
        playbook={plan()}
        onGate={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId("plan-pass"))
    await waitFor(() => expect(mockRecordCheck).toHaveBeenCalledWith("t-1", { item_id: "case:1", decision: "pass", note: undefined }))
  })
})
