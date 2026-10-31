// packages/server/src/services/agent/context-usage.ts
//
// 冷启动的 ctx 角标兜底。
//
// provider 只在轮次里上报 context_usage；`sessions.context_usage` 只保存真实
// 上报值。对「修复上线前跑过、之后再没跑过」的会话，这一列永远是 NULL，换浏览器
// / 无痕打开就只能显示 `ctx --%`。这里用该会话**最后一轮的 token 账本**做一个
// 只读估算：prompt + completion ≈ 轮末上下文占用。
//
// 纪律：
//   - 估算值**绝不回写** sessions.context_usage —— 列里只允许真实上报值；
//   - 打 estimated:true，UI 以 `ctx ~N%` 呈现并说明「下一轮校准」；
//   - 分母只能取默认窗口（composer 文档口径「200k = 默认窗口」，1M 变体
//     才是 1M）—— 历史轮次没记录档位，所以估算精度有限，只作占位。

import type Database from 'better-sqlite3'
import type { AgentContextUsage } from '@octopus/shared'

/** composer 的默认上下文窗口（"200k — 默认窗口"）。 */
const DEFAULT_CONTEXT_WINDOW = 200_000
/** 模型名带 `[1m]` 变体后缀时的窗口。 */
const LARGE_CONTEXT_WINDOW = 1_000_000

interface LedgerRow {
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
}

export function estimateContextUsageFromLedger(
  db: Database.Database,
  sessionId: string,
): AgentContextUsage | null {
  let row: LedgerRow | undefined
  try {
    row = db.prepare(`
      SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
      FROM llm_calls
      WHERE session_id = ?
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `).get(sessionId) as LedgerRow | undefined
  } catch {
    return null // llm_calls missing (older DB) — no estimate, stay at --%
  }
  if (!row) return null

  const total =
    (row.input_tokens ?? 0) +
    (row.output_tokens ?? 0) +
    (row.cache_read_tokens ?? 0) +
    (row.cache_creation_tokens ?? 0)
  if (total <= 0) return null

  const model = row.model ?? 'unknown'
  const maxTokens = /\[1m\]/i.test(model) ? LARGE_CONTEXT_WINDOW : DEFAULT_CONTEXT_WINDOW
  return {
    categories: [],
    totalTokens: total,
    maxTokens,
    rawMaxTokens: maxTokens,
    // 0–100 量纲，与 SDK context_usage 一致（保留一位小数）。
    percentage: Math.round((total / maxTokens) * 1000) / 10,
    model,
    estimated: true,
  }
}
