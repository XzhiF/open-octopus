// token-capture-1 票02 —— chat 轮次末捕获：明细批写 + 账本行（唯一入口 recordNodeUsage，
// ADR-0016 单写纪律不破）。由 CloneRuntime.chat() 终局处调用（KD3：批写，崩溃丢当前轮）。
//
// ponytail: KD3 轮次末批写 —— 崩溃/中断丢当前轮已获用户裁决接受；若实测丢失明显，
// 升级路径 = tracker onMessageStop 钩子逐条 INSERT 明细 + result 时 UPDATE 校准。

import type { LLMCallRecord } from '@octopus/providers'
import { TokenUsageDAO } from '../../db/dao/token-usage-dao'
import { ledgerCostUsd } from '../../db/dao/usage-ledger'
import type { LlmCallRow } from '../../db/types'

export interface ChatRoundCapture {
  sessionId: string
  org: string
  /** KD5: trace_id = 一轮聊天的运行标识（session 内唯一）—— 调用方每轮 randomUUID() */
  traceId: string
  /** provider tracker 已 calibrate 的 per-call 权威值 */
  records: LLMCallRecord[]
}

/**
 * 一捕获 = 一事务：明细批写（每 call 一行，source='chat'，host 列 NULL——成本不编数
 * 原则同样适用 cost，tracker 给不出的字段落 NULL）+ 账本按 (轮次, model) 聚合行。
 *
 * 幂等（票02 验证 3）：确定式 id（明细 `chat:{trace}:{messageId}`，账本
 * `chat:{trace}:{model}`）+ 明细 INSERT OR IGNORE + 账本存在性跳过 —— 同 trace
 * 重放零双计。recordNodeUsage 的 ON CONFLICT 累加语义原样保留给 engine/harness
 * 重跑路径，不在此动刀。
 *
 * 任何失败只 log stderr、不抛（捕获永不阻断聊天；丢轮 = KD3 接受面）。
 */
export function captureChatRound(dao: TokenUsageDAO, ctx: ChatRoundCapture): void {
  const { sessionId, org, traceId, records } = ctx
  if (records.length === 0) return
  try {
    const db = dao.getDb()
    dao.transaction(() => {
      // workspace_id 按会话上下文填（分身聊天在 chat_sessions；main-agent 会话无行 → NULL）
      const ws = db
        .prepare('SELECT workspace_id FROM chat_sessions WHERE id = ?')
        .get(sessionId) as { workspace_id: string | null } | undefined
      const workspaceId = ws?.workspace_id ?? null

      const details: LlmCallRow[] = records.map((r, i) => ({
        id: `chat:${traceId}:${r.messageId ?? i}`,
        node_execution_id: null,
        execution_id: null,
        turn_index: r.turnIndex,
        call_index: i,
        message_id: r.messageId ?? null,
        model: r.model ?? null,
        stop_reason: r.stopReason ?? null,
        timestamp: r.timestamp,
        duration_ms: r.durationMs,
        ttft_ms: r.ttftMs ?? null,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_read_tokens: r.cacheReadTokens,
        cache_creation_tokens: r.cacheCreationTokens,
        // 与 observability.persistLLMCalls 同一 cost 三态单源（ledgerCostUsd）
        cost_usd: ledgerCostUsd(r, r.model, r.costUsd),
        org,
        workspace_id: workspaceId,
        workflow_ref: null,
        node_id: null,
        session_id: sessionId,
        instance_id: null,
        source: 'chat',
        trace_id: traceId,
        span_id: r.messageId ?? null,
      }))
      dao.insertLlmCallBatch(details)

      // 账本（KD2）：本轮 call 按 model 分组，每 (轮次, model) 一行
      interface Group { usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }; costs: Array<number | null> }
      const byModel = new Map<string, Group>()
      for (const r of records) {
        const model = r.model ?? 'unknown'
        let g = byModel.get(model)
        if (!g) {
          g = { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, costs: [] }
          byModel.set(model, g)
        }
        g.usage.inputTokens += r.inputTokens
        g.usage.outputTokens += r.outputTokens
        g.usage.cacheReadTokens += r.cacheReadTokens
        g.usage.cacheCreationTokens += r.cacheCreationTokens
        g.costs.push(ledgerCostUsd(r, r.model, r.costUsd))
      }
      for (const [model, g] of byModel) {
        const id = `chat:${traceId}:${model}`
        if (db.prepare('SELECT 1 FROM node_token_usages WHERE id = ?').get(id)) continue // 重放
        // 同 model 定价一致：全有值 → Σ明细（US3 账本=明细逐一对上）；有未定价 → 交
        // recordNodeUsage 的 C2 补价/未定价路径（估出 null 则落 NULL，绝不焊 0）。
        const allPriced = g.costs.every((c) => c !== null)
        dao.recordNodeUsage({
          id,
          nodeExecutionId: null,
          model,
          usage: g.usage,
          costUsd: allPriced ? g.costs.reduce((a, c) => a + (c ?? 0), 0) : undefined,
          source: 'chat',
          createdAt: new Date().toISOString(),
          sessionId,
          traceId,
        })
      }
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[chat-usage-capture] trace=${traceId} session=${sessionId} 捕获失败（非致命，丢当前轮 KD3）:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
