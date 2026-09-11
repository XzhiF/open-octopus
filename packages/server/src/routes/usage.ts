// token-capture-1 票03 —— 回读 seam（唯一）：GET /api/usage/llm-calls。
// 按 session_id | trace_id 查 chat 明细 + 按 trace_id 轮次聚合；snake→camel 只在
// 本 wire 出口做（ADR-0014 口径）。rounds 的 total/cost 折叠走 shared/ledger.ts 具名
// 函数（「total 不是字段」，不手搓求和；未定价保持 null 不焊 0）。

import { Hono, type Context } from "hono"
import { costSummary, totalTokens, type TokenUsage } from "@octopus/shared"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { LlmCallRow } from "../db/types"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

export interface LlmCallView {
  id: string
  nodeExecutionId: string | null
  executionId: string | null
  turnIndex: number
  callIndex: number
  messageId: string | null
  model: string | null
  stopReason: string | null
  timestamp: number
  durationMs: number
  ttftMs: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number | null
  org: string | null
  workspaceId: string | null
  workflowRef: string | null
  nodeId: string | null
  sessionId: string | null
  instanceId: string | null
  source: string | null
  traceId: string | null
  spanId: string | null
}

export type ChatRoundView = {
  traceId: string
  models: string[]
  totalTokens: number
  costUsd: number | null
} & TokenUsage

function toCallView(r: LlmCallRow): LlmCallView {
  return {
    id: r.id,
    nodeExecutionId: r.node_execution_id,
    executionId: r.execution_id,
    turnIndex: r.turn_index,
    callIndex: r.call_index,
    messageId: r.message_id,
    model: r.model,
    stopReason: r.stop_reason,
    timestamp: r.timestamp,
    durationMs: r.duration_ms,
    ttftMs: r.ttft_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    costUsd: r.cost_usd,
    org: r.org,
    workspaceId: r.workspace_id,
    workflowRef: r.workflow_ref,
    nodeId: r.node_id,
    sessionId: r.session_id,
    instanceId: r.instance_id,
    source: r.source ?? null,
    traceId: r.trace_id ?? null,
    spanId: r.span_id ?? null,
  }
}

/** 按 trace_id 折叠（对已截断的返回行聚合 → rounds 与 calls 永远自洽）。 */
function aggregateRounds(rows: LlmCallRow[]): ChatRoundView[] {
  const byTrace = new Map<string, { usage: TokenUsage; models: string[]; costs: Array<number | null> }>()
  for (const r of rows) {
    if (!r.trace_id) continue // 无追踪标识的行不参与轮次聚合（既有 engine 行）
    let g = byTrace.get(r.trace_id)
    if (!g) {
      g = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, models: [], costs: [] }
      byTrace.set(r.trace_id, g)
    }
    g.usage.inputTokens += r.input_tokens
    g.usage.outputTokens += r.output_tokens
    g.usage.cacheReadTokens += r.cache_read_tokens
    g.usage.cacheCreationTokens += r.cache_creation_tokens
    if (r.model && !g.models.includes(r.model)) g.models.push(r.model)
    g.costs.push(r.cost_usd)
  }
  return [...byTrace.entries()].map(([traceId, g]) => ({
    traceId,
    models: g.models,
    ...g.usage,
    totalTokens: totalTokens(g.usage), // 具名口径函数（四字段全口径含 cache）
    costUsd: costSummary(g.costs).usd, // 三态：全未定价 → null（绝不把未知焊成 0）
  }))
}

const INVALID = Symbol("invalid")

/** from/to = epoch ms，非负整数；缺省 undefined，非法 → INVALID。 */
function parseEpoch(c: Context, key: string): number | typeof INVALID | undefined {
  const raw = c.req.query(key)
  if (raw === undefined || raw === "") return undefined
  return /^\d+$/.test(raw) ? Number(raw) : INVALID
}

export function createUsageRoutes(tokenDao: TokenUsageDAO): Hono {
  const router = new Hono()

  router.get("/llm-calls", (c: Context) => {
    const sessionId = c.req.query("session_id") || undefined
    const traceId = c.req.query("trace_id") || undefined
    // 必含其一（票03）：全空参 / 只有 source / 只有窗口 → 400，不给无界全表扫描留门
    if (!sessionId && !traceId) {
      return c.json({ error: "session_id or trace_id is required" }, 400)
    }
    const from = parseEpoch(c, "from")
    const to = parseEpoch(c, "to")
    if (from === INVALID || to === INVALID) {
      return c.json({ error: "from/to must be epoch-ms integers" }, 400)
    }

    let limit = DEFAULT_LIMIT
    const rawLimit = c.req.query("limit")
    if (rawLimit !== undefined && rawLimit !== "") {
      const n = Number(rawLimit)
      if (Number.isInteger(n) && n > 0) limit = Math.min(n, MAX_LIMIT) // >500 截断；非法回落默认
    }
    // 缺省口径 = 'chat'（本 API 为 chat 回读而生，KD6）；其他词表值须显式传 source=
    const source = c.req.query("source") || "chat"

    const rows = tokenDao.queryLlmCalls({
      sessionId,
      traceId,
      source,
      from: from as number | undefined,
      to: to as number | undefined,
      limit,
    })
    return c.json({ calls: rows.map(toCallView), rounds: aggregateRounds(rows) })
  })

  return router
}
