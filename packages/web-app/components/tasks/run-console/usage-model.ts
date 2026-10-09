// packages/web-app/components/tasks/run-console/usage-model.ts
//
// 票 11 ⑩回补 — ▤ 消耗页签「按会话/节点」明细的纯聚合层。
//
// 两账不混（ADR-0025 口径，原型 usageHtml 顶注原话「UI 一面 · 账务两会话不混记」）：
//   · 节点账 = server /executions/:id/llm-calls 的 aggregates.byNode（去重口径与
//     全局一致），逐轮逐节点各成一行；旧服务/缺数 = 该行不造（分轮账本段仍由
//     TaskAiUsageCard 如实标灰）。
//   · task-doer 对话账 = /sessions/:id/llm-calls 会话口径，单独一行，按
//     Task.doer_session_id 归属；无会话或零调用（任务没说过话）→ 整行不出现。

import type { LLMCallAggregates, LlmNodeAggregatesWire } from "@/lib/types"

export interface UsageNodeRow {
  key: string
  label: string
  agg: LLMCallAggregates | null
}

export interface UsageDetailInput {
  /** 分轮行（与 TaskAiUsageCard.rounds 同一份 —— 单源喂两处，不各拉各的）。 */
  rounds: Array<{ key: string; label: string; agg: LLMCallAggregates | null }>
  doerSessionId?: string | null
  doerAgg?: LLMCallAggregates | null
}

export interface UsageDetail {
  nodeRows: UsageNodeRow[]
  doerRow: UsageNodeRow | null
}

export function buildUsageDetail(input: UsageDetailInput): UsageDetail {
  const nodeRows: UsageNodeRow[] = []
  for (const round of input.rounds) {
    const byNode = round.agg?.byNode
    if (!byNode) continue // 缺数轮 / 旧服务无该维度 —— 如实无行
    for (const node of byNode) {
      nodeRows.push({
        key: `${round.key}:${node.nodeId}`,
        label: `${round.label} · ◆ ${node.nodeId}`,
        agg: nodeAggToAggregates(node),
      })
    }
  }
  const doerRow =
    input.doerSessionId && input.doerAgg && input.doerAgg.totalCalls > 0
      ? { key: `doer:${input.doerSessionId}`, label: "💬 task-doer 对话", agg: input.doerAgg }
      : null
  return { nodeRows, doerRow }
}

/** byNode 行 → AggInline/AggMetrics 吃的完整口径形（toolCalls 无节点级数据源，
 *  如实 0 —— 七量纲行不显示工具数，与卡片既有约定一致）。 */
function nodeAggToAggregates(node: LlmNodeAggregatesWire): LLMCallAggregates {
  return {
    totalCalls: node.totalCalls,
    toolCalls: 0,
    usage: node.usage,
    totals: node.totals,
    modelBreakdown: node.modelBreakdown ?? {},
  }
}
