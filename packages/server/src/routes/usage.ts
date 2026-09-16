// token-capture-1 票03 —— 回读 seam（唯一）：GET /api/usage/llm-calls。
// 按 session_id | trace_id 查 chat 明细 + 按 trace_id 轮次聚合；snake→camel 只在
// 本 wire 出口做（ADR-0014 口径）。rounds 的 total/cost 折叠走 shared/ledger.ts 具名
// 函数（「total 不是字段」，不手搓求和；未定价保持 null 不焊 0）。

import { Hono, type Context } from "hono"
import {
  costSummary, totalTokens, LLM_CALL_SOURCE, mergeLedgerParts,
  type TokenUsage, type LedgerPart,
} from "@octopus/shared"
import type { LlmCallAggregateRow, LlmCallAggregateDim, TokenUsageDAO } from "../db/dao/token-usage-dao"
import type { LlmCallRow } from "../db/types"

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

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

// —— /aggregate（usage-admin-3 票01）——

const AGG_DIMS: readonly LlmCallAggregateDim[] = ["day", "source", "model", "clone"]
// ponytail: TopN 固定 20（票 01 默认即全部诉求）；要参数化再开 topn= 旋钮
const TOP_N = 20
// phase 4 形状（KD6）：聚合行带 currency，USD 阶段恒定
const CURRENCY = "USD"

export interface UsageAggregateRowView extends LlmCallAggregateRow {
  currency: string
}

/** 前 TOP_N 保留，其余归并成单行 others（公式走 mergeLedgerParts，不手搓）。 */
function withOthers(rows: LlmCallAggregateRow[]): UsageAggregateRowView[] {
  const view = (r: LlmCallAggregateRow): UsageAggregateRowView => ({ ...r, currency: CURRENCY })
  if (rows.length <= TOP_N) return rows.map(view)
  const head = rows.slice(0, TOP_N)
  const tail = rows.slice(TOP_N)
  const { usage, totals } = mergeLedgerParts(tail.map(r => ({
    usage: {
      inputTokens: r.inputTokens, outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens, cacheCreationTokens: r.cacheCreationTokens,
    },
    cost: { usd: r.costUsd, complete: r.costComplete },
  } satisfies LedgerPart)))
  return [...head.map(view), {
    key: "others",
    keyLabel: `其他 (${tail.length} 组)`,
    calls: tail.reduce((a, r) => a + r.calls, 0),
    ...usage,
    totalTokens: totals.tokens,
    costUsd: totals.cost.usd,
    costComplete: totals.cost.complete,
    cacheHitRate: totals.cacheHitRate,
    currency: CURRENCY,
  }]
}

export function createUsageRoutes(tokenDao: TokenUsageDAO): Hono {
  const router = new Hono()

  router.get("/llm-calls", (c: Context) => {
    const sessionId = c.req.query("session_id") || undefined
    const traceId = c.req.query("trace_id") || undefined
    // session_id/trace_id 必含的旧守卫已下移至票02 的 page 感知守卫（分页模式豁免）
    const from = parseEpoch(c, "from")
    const to = parseEpoch(c, "to")
    if (from === INVALID || to === INVALID) {
      return c.json({ error: "from/to must be epoch-ms integers" }, 400)
    }

    const org = c.req.query("org") || undefined
    const model = c.req.query("model") || undefined
    // 票02 审查修复（US1）：明细列表工作区筛选——此前只有 /aggregate 收 workspace_id，
    // 明细面无（筛选器集合与 spec「source/model/会话/工作区/org/时间窗」不齐）。
    const workspaceId = c.req.query("workspace_id") || undefined
    const sourceRaw = c.req.query("source") || undefined
    // 票04：source=all 哨兵（非词表值）= 放行全源，供 trace 下钻取跨源同组
    const sourceFilter = sourceRaw === "all" ? undefined : sourceRaw

    // usage-admin-3 票02：page=正整数 → 分页浏览模式（放宽 session/trace 必含——
    // LIMIT/OFFSET + timestamp 索引撑住，不再留无界扫描门）。此模式 source 缺省 = 全源、
    // 时间倒序、返回 total；缺 page 时既有语义逐字不变（票03 契约）。
    const pageRaw = c.req.query("page")
    const page = pageRaw !== undefined && /^[1-9]\d*$/.test(pageRaw) ? Number(pageRaw) : 0
    if (!page && !sessionId && !traceId) {
      return c.json({ error: "session_id or trace_id is required" }, 400)
    }

    if (page) {
      let pageSize = DEFAULT_PAGE_SIZE
      const rawSize = c.req.query("page_size")
      if (rawSize !== undefined && rawSize !== "") {
        const n = Number(rawSize)
        if (Number.isInteger(n) && n > 0) pageSize = Math.min(n, MAX_PAGE_SIZE)
      }
      const filters = { sessionId, traceId, source: sourceFilter, model, org, workspaceId, from: from as number | undefined, to: to as number | undefined }
      const total = tokenDao.countLlmCalls(filters)
      const rows = tokenDao.queryLlmCalls({ ...filters, limit: pageSize, offset: (page - 1) * pageSize, desc: true })
      return c.json({ calls: rows.map(toCallView), rounds: aggregateRounds(rows), total, page, pageSize })
    }

    let limit = DEFAULT_LIMIT
    const rawLimit = c.req.query("limit")
    if (rawLimit !== undefined && rawLimit !== "") {
      const n = Number(rawLimit)
      if (Number.isInteger(n) && n > 0) limit = Math.min(n, MAX_LIMIT) // >500 截断；非法回落默认
    }
    // 缺省口径 = 'chat'（本 API 为 chat 回读而生，KD6）；其他词表值须显式传 source=；all = 全源（票04）
    const source = sourceRaw === "all" ? undefined : (sourceRaw ?? LLM_CALL_SOURCE.chat)

    const rows = tokenDao.queryLlmCalls({
      sessionId,
      traceId,
      source,
      model,
      org,
      workspaceId,
      from: from as number | undefined,
      to: to as number | undefined,
      limit,
    })
    return c.json({ calls: rows.map(toCallView), rounds: aggregateRounds(rows) })
  })

  router.get("/aggregate", (c: Context) => {
    const dim = c.req.query("dim") as LlmCallAggregateDim | undefined
    if (!dim || !AGG_DIMS.includes(dim)) {
      return c.json({ error: `dim must be one of ${AGG_DIMS.join("|")}` }, 400)
    }
    const from = parseEpoch(c, "from")
    const to = parseEpoch(c, "to")
    if (from === INVALID || to === INVALID) {
      return c.json({ error: "from/to must be epoch-ms integers" }, 400)
    }
    const rows = tokenDao.aggregateLlmCalls({
      dim,
      from: from as number | undefined,
      to: to as number | undefined,
      org: c.req.query("org") || undefined,
      workspaceId: c.req.query("workspace_id") || undefined,
    })
    return c.json({ dim, rows: withOthers(rows) })
  })

  return router
}
