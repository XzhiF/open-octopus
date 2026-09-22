/**
 * billing NEW-r2 —— llm_calls 唯一共用落账 helper。
 *
 * 所有记账路径（workflow / interaction 既有写入点 + clone_chat / global_chat /
 * session_compress 聊天路径）都调这里：
 *   入 = 四类 token + model(归一化) + sourcePath + 归属维度（可得性如实，缺则 null）
 *   → 写出一条**纯事实** llm_calls。
 *
 * NEW-r2 翻转：这里**不再算钱** —— 钱不落账本，费用一律查询时按
 * billing_price_config 窗口现算（见 db/price-sql.ts 与 billing-dao 报表族）。
 * BillingService 写入时算价链路整体退役。
 *
 * 模型名归一化在这里做（shared normalizeModelId，Q9 双端之「落账端」）：
 * SDK/代理上报名常带 `[1M]` 等尾部残渣，不归一则价表精确匹配永远命不中。
 *
 * source_path 枚举校验保留在这里（shared 定义，KD20）：非法值直接抛，不落库。
 */
import type Database from "better-sqlite3"
import type { LlmCallRow } from "../db/types"
import type { TokenUsage } from "@octopus/shared"
import { isLlmCallSourcePath, normalizeModelId, type LlmCallSourcePath } from "@octopus/shared"
import type { TokenUsageDAO } from "../db/dao/token-usage-dao"

export interface LlmCallLedgerInput {
  /** 行主键 —— 调用方给（幂等写按 call 标识防同 chunk 双行，KD23）。 */
  id: string
  sourcePath: LlmCallSourcePath
  /** 票04/KD17: 聊天/压缩类行无执行链路 → 如实传 null（v47 起列可空）。 */
  nodeExecutionId: string | null
  executionId: string | null
  turnIndex: number
  callIndex: number
  /** 原始模型名 —— 落库前经 normalizeModelId 归一。 */
  model: string | null
  usage: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens">
  timestamp: number
  durationMs: number
  messageId?: string | null
  stopReason?: string | null
  ttftMs?: number | null
  org?: string | null
  workspaceId?: string | null
  workflowRef?: string | null
  nodeId?: string | null
  sessionId?: string | null
  instanceId?: string | null
}

/** 纯函数部分：组行（批量落库路径用，如 observability 的 flush）。NEW-r2 起无副作用、无算价。 */
export function composeLlmCallRow(input: LlmCallLedgerInput): LlmCallRow {
  if (!isLlmCallSourcePath(input.sourcePath)) {
    throw new Error(`[llm-call-ledger] 非法 source_path: ${String(input.sourcePath)}（必须是 shared LLM_CALL_SOURCE_PATHS 枚举值，KD20）`)
  }
  return {
    id: input.id,
    node_execution_id: input.nodeExecutionId,
    execution_id: input.executionId,
    turn_index: input.turnIndex,
    call_index: input.callIndex,
    message_id: input.messageId ?? null,
    model: normalizeModelId(input.model),
    stop_reason: input.stopReason ?? null,
    timestamp: input.timestamp,
    duration_ms: input.durationMs,
    ttft_ms: input.ttftMs ?? null,
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    cache_read_tokens: input.usage.cacheReadTokens,
    cache_creation_tokens: input.usage.cacheCreationTokens,
    org: input.org ?? null,
    workspace_id: input.workspaceId ?? null,
    workflow_ref: input.workflowRef ?? null,
    node_id: input.nodeId ?? null,
    session_id: input.sessionId ?? null,
    instance_id: input.instanceId ?? null,
    source_path: input.sourcePath,
  }
}

/** 单条落库入口：compose + insertLlmCall（DAO 内 INSERT OR IGNORE 幂等）。 */
export function recordLlmCall(input: LlmCallLedgerInput, tokenDao: TokenUsageDAO): Database.RunResult {
  return tokenDao.insertLlmCall(composeLlmCallRow(input))
}

// ── 聊天/压缩路径 result-chunk 入账入口 ─────────────────────────────────

import { randomUUID } from "crypto"

export interface ProviderResultUsageInput {
  sourcePath: LlmCallSourcePath
  /** 归属如实（KD17）：聊天/压缩行传 null。 */
  nodeExecutionId: string | null
  executionId: string | null
  sessionId: string | null
  org?: string | null
  workspaceId?: string | null
  messageId?: string | null
  /** 分身名等来源细分（可选，如实可得才填）。 */
  nodeId?: string | null
  instanceId?: string | null
  /** 本轮流开始时刻（ms），用于 duration_ms。 */
  startedAtMs: number
  turnIndex?: number
  /** provider result chunk 的 per-model 用量（优先）。 */
  modelUsages?: readonly { model?: string | null; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number }[] | null
  /** chunk 总量（modelUsages 缺失时兜底单行）。 */
  usage?: Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens"> | null
  /** 兜底行的 model 归属（调用方已知模型时给）。 */
  fallbackModel?: string | null
}

const sumTokens = (u?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number } | null): number =>
  (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheCreationTokens ?? 0)

/**
 * 聊天路径（clone_chat / global_chat / session_compress）result chunk 的统一入账：
 * 每 modelUsage 一行（模型粒度，算价在查询时按行匹配）；缺 modelUsages 则按
 * usage+fallbackModel 记一行；无真值（全零 / 两者都缺）不记、不造数。
 * **纯旁路** —— 任何异常只 log（NEW-r2 起带完整堆栈：编程错误此前被一行 message
 * 吞掉，排查时被误导成落账逻辑 bug），绝不断聊天主流水。
 * 一行 = 一次实际到达的 result chunk（KD23 防双计：chunk 到达即写，
 * 重试是新的真实调用 → 新的真实行）。
 */
export function recordProviderResultUsage(input: ProviderResultUsageInput, tokenDao: TokenUsageDAO): void {
  try {
    const perModel = (input.modelUsages ?? []).filter(mu => sumTokens(mu) > 0)
    const entries = perModel.length > 0
      ? perModel.map(mu => ({ model: mu.model ?? null, usage: mu }))
      : input.usage && sumTokens(input.usage) > 0
        ? [{ model: input.fallbackModel ?? null, usage: input.usage }]
        : []
    const nowMs = Date.now()
    entries.forEach((e, i) => {
      recordLlmCall({
        id: randomUUID(),
        sourcePath: input.sourcePath,
        nodeExecutionId: input.nodeExecutionId,
        executionId: input.executionId,
        turnIndex: input.turnIndex ?? 1,
        callIndex: i,
        messageId: input.messageId ?? null,
        model: e.model,
        stopReason: 'end_turn',
        timestamp: nowMs,
        durationMs: nowMs - input.startedAtMs,
        usage: {
          inputTokens: e.usage.inputTokens ?? 0,
          outputTokens: e.usage.outputTokens ?? 0,
          cacheReadTokens: e.usage.cacheReadTokens ?? 0,
          cacheCreationTokens: e.usage.cacheCreationTokens ?? 0,
        },
        org: input.org ?? null,
        workspaceId: input.workspaceId ?? null,
        nodeId: input.nodeId ?? null,
        sessionId: input.sessionId ?? null,
        instanceId: input.instanceId ?? null,
      }, tokenDao)
    })
  } catch (err) {
    console.error(
      `[llm-call-ledger] ${input.sourcePath} 入账失败 (non-fatal):`,
      err instanceof Error ? err : new Error(String(err)),
    )
  }
}
