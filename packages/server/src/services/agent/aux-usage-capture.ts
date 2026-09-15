// all-sources-2 票04 —— scheduler / aux_* 内部调用的统一捕获 seam。
// 与 phase1 chat-usage-capture 同型：provider 流终局消耗 usage → 明细一行 +
// 账本一行（recordNodeUsage 唯一入口，ADR-0016 单写纪律）。词表单源 LLM_CALL_SOURCE。
//
// ponytail: 单发调用（一次 sendQuery = 一次 usage），不做多轮 tracker —— aux 调用
// 全部是 one-shot；若将来出现流式多 call，升级路径 = 复用 captureChatRound 形状。

import type Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { totalTokens, type LlmCallSource, type ModelUsage, type TokenUsage } from "@octopus/shared"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { ledgerCostUsd } from "../../db/dao/usage-ledger"
import type { LlmCallRow } from "../../db/types"

/** 流终局 usage 收集器：在 for-await 消费处喂 result chunk（各挂点共用）。 */
export interface ResultUsageSink {
  usage?: TokenUsage
  modelUsages?: ModelUsage[]
  costUsd?: number | null
}

/** provider result chunk → sink。调用点写 `collectResultUsage(chunk, sink)`。 */
export function collectResultUsage(
  chunk: { type: string; usage?: TokenUsage; modelUsages?: ModelUsage[]; costUsd?: number | null },
  sink: ResultUsageSink,
): void {
  if (chunk.type !== "result") return
  if (chunk.usage) sink.usage = chunk.usage
  if (chunk.modelUsages?.length) sink.modelUsages = chunk.modelUsages
  if (chunk.costUsd != null) sink.costUsd = chunk.costUsd
}

export interface AuxCaptureContext {
  source: LlmCallSource
  /** KD6: trace_id = 该源运行根（schedule run id / 归档运行 / 每次调用 UUID） */
  traceId: string
  /**
   * 一 trace 内的每次调用判别符（span）。缺省 "main"（单发路径）；
   * 同一运行根下并发/多次调用必须各给一个（如归档分析的三个 prompt 名、
   * scheduler 重试 attempt-N），否则同 model 的调用明细互撞被 IGNORE 吞 token。
   */
  spanId?: string
  model?: string | null
  /** result.usage 纯值口径（C1）；modelUsages 存在时优先（按 model 分行） */
  usage?: TokenUsage | null
  modelUsages?: ModelUsage[] | null
  costUsd?: number | null
  org?: string | null
  workspaceId?: string | null
  sessionId?: string | null
  timestamp?: number
  durationMs?: number | null
}

/**
 * 明细 + 账本各一行（按 model 分组时各 N 行，账本 = Σ明细 同 cost 决策单源）。
 * 无 usage / 全零 → 不落行（不编数）。捕获永不阻断宿主流程：失败只 log stderr。
 */
export function captureAuxCall(
  dbOrGetter: Database.Database | (() => Database.Database),
  ctx: AuxCaptureContext,
): void {
  try {
    const groups = (ctx.modelUsages && ctx.modelUsages.length > 0
      ? ctx.modelUsages.map((mu) => ({ model: mu.model, usage: mu as TokenUsage, costUsd: mu.costUsd ?? null }))
      : ctx.usage
        ? [{ model: ctx.model ?? "unknown", usage: ctx.usage, costUsd: ctx.costUsd ?? null }]
        : []
    ).filter((g) => totalTokens(g.usage) > 0)
    if (groups.length === 0) return

    const dao = new TokenUsageDAO(typeof dbOrGetter === "function" ? dbOrGetter() : dbOrGetter)
    const now = Date.now()
    const timestamp = ctx.timestamp ?? now

    for (const g of groups) {
      const span = ctx.spanId ?? "main"
      const detailId = `${ctx.source}:${ctx.traceId}:${span}:${g.model}`
      const ledgerId = `${ctx.source}:${ctx.traceId}:${g.model}` // KD3 粒度：运行根×model
      const cost = ledgerCostUsd(g.usage, g.model, g.costUsd)
      const row: LlmCallRow = {
        id: detailId,
        node_execution_id: null,
        execution_id: null, // 各源宿主非 executions 行（schedule_runs/workspace）——FK 不编数
        turn_index: 1,
        call_index: 0,
        message_id: null,
        model: g.model,
        stop_reason: null,
        timestamp,
        duration_ms: ctx.durationMs ?? 0,
        ttft_ms: null,
        input_tokens: g.usage.inputTokens,
        output_tokens: g.usage.outputTokens,
        cache_read_tokens: g.usage.cacheReadTokens,
        cache_creation_tokens: g.usage.cacheCreationTokens,
        cost_usd: cost,
        org: ctx.org ?? null,
        workspace_id: ctx.workspaceId ?? null,
        workflow_ref: null,
        node_id: null,
        session_id: ctx.sessionId ?? null,
        instance_id: null,
        source: ctx.source,
        trace_id: ctx.traceId,
        span_id: span,
      }
      const fresh = dao.insertLlmCall(row).changes > 0 // INSERT OR IGNORE —— 同 (trace,span,model) 重放零双计

      // 账本只为本笔新增的明细记账：同 trace 同 model 多次调用（不同 span）
      // 各自入账 → recordNodeUsage 的 ON CONFLICT 累加聚成运行根×model 一行（US3 Σ）；
      // 重放（changes=0）跳过，与 chat 捕获"存在即不双计"同语义。
      if (!fresh) continue
      dao.recordNodeUsage({
        id: ledgerId,
        nodeExecutionId: null,
        model: g.model,
        usage: g.usage,
        costUsd: cost,
        source: ctx.source,
        createdAt: new Date().toISOString(),
        sessionId: ctx.sessionId ?? null,
        traceId: ctx.traceId,
      })
    }
  } catch (err) {
    console.error(
      `[aux-usage-capture] source=${ctx.source} trace=${ctx.traceId} 捕获失败（非致命）:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
