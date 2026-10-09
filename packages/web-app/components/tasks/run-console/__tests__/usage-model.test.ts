// 票 11 ⑩回补 — ▤ 消耗页签「按会话/节点」明细的纯聚合层。
//
// 两账不混（ADR-0025）：工作流节点账（llm_calls 按 node_id 分组，server
// aggregates.byNode 单源）与 task-doer 对话账（GET /api/sessions/:id/llm-calls
// 会话口径）各归各行，绝不合并进同一行/同一段；无 doer 会话或该会话零调用
// （任务从没说过话）→ doer 行整行不出现（如实，不放假 0 行）。

import { describe, it, expect } from "vitest"
import type { LLMCallAggregates } from "@/lib/types"
import { buildUsageDetail } from "../usage-model"

const wire = (over: Partial<LLMCallAggregates> = {}): LLMCallAggregates => ({
  totalCalls: 1,
  toolCalls: 0,
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
  totals: { tokens: 110, cost: { usd: 0.01, complete: true }, cacheHitRate: null },
  modelBreakdown: {},
  ...over,
})

describe("buildUsageDetail — 逐节点行 + task-doer 单独行（票11）", () => {
  it("逐节点行：每轮 byNode 各成一行，标签 = 轮次 · 节点", () => {
    const r1 = wire({
      totalCalls: 3,
      byNode: [
        { nodeId: "dev", totalCalls: 2, usage: wire().usage, totals: wire().totals, modelBreakdown: {} },
        { nodeId: "verify", totalCalls: 1, usage: wire().usage, totals: wire().totals, modelBreakdown: {} },
      ],
    })
    const { nodeRows, doerRow } = buildUsageDetail({
      rounds: [
        { key: "e1", label: "Phase 1 · Round 1", agg: r1 },
        { key: "e2", label: "Phase 1 · Round 2", agg: null }, // 缺数轮如实无行（灰态仍由分轮账本担）
        { key: "e3", label: "Phase 2 · Round 1", agg: wire() }, // 旧服务无 byNode 维度 → 不出节点行
      ],
      doerSessionId: null,
      doerAgg: null,
    })
    expect(nodeRows.map((r) => r.key)).toEqual(["e1:dev", "e1:verify"])
    expect(nodeRows[0]!.label).toBe("Phase 1 · Round 1 · ◆ dev")
    expect(nodeRows[1]!.label).toBe("Phase 1 · Round 1 · ◆ verify")
    expect(doerRow).toBeNull()
  })

  it("doer 行归属看 doer_session_id：有会话且有调用 → 单独一行；两账不并进节点行", () => {
    const doer = wire({ totalCalls: 4 })
    const { nodeRows, doerRow } = buildUsageDetail({
      rounds: [{ key: "e1", label: "Phase 1 · Round 1", agg: wire({ byNode: [{ nodeId: "dev", totalCalls: 2, usage: wire().usage, totals: wire().totals, modelBreakdown: {} }] }) }],
      doerSessionId: "chat-9",
      doerAgg: doer,
    })
    expect(doerRow).not.toBeNull()
    expect(doerRow!.label).toContain("task-doer")
    expect(doerRow!.agg?.totalCalls).toBe(4)
    expect(nodeRows.map((r) => r.key)).toEqual(["e1:dev"]) // 对话账没混进节点账
  })

  it("无对话历史不显 doer 行：无会话 / 会话零调用 都不出行（AC3 反向半）", () => {
    const rounds = [{ key: "e1", label: "P1·R1", agg: wire() }]
    expect(buildUsageDetail({ rounds, doerSessionId: null, doerAgg: wire({ totalCalls: 5 }) }).doerRow).toBeNull()
    expect(buildUsageDetail({ rounds, doerSessionId: "chat-9", doerAgg: null }).doerRow).toBeNull()
    expect(buildUsageDetail({ rounds, doerSessionId: "chat-9", doerAgg: wire({ totalCalls: 0 }) }).doerRow).toBeNull()
  })

  it("byNode 空数组（执行有账但无节点归属行）→ 节点行零条，不造假", () => {
    const { nodeRows } = buildUsageDetail({
      rounds: [{ key: "e1", label: "P1·R1", agg: wire({ byNode: [] }) }],
      doerSessionId: null,
      doerAgg: null,
    })
    expect(nodeRows).toEqual([])
  })
})
