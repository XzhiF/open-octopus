// 每个 assistant turn 的计时 / token / 缓存归属（2026-10-29 用户需求）。
//
// 数据源：会话账本 GET /api/sessions/:id/llm-calls 的逐 call 行
// （llm_calls：timestamp / duration_ms / 四类 token / message_id）。
//
// 归属规则：
//   ① 行带 message_id（未来服务端补传后）→ 精确按 message_id 归；
//   ② 聊天路径目前不传 message_id（recordProviderResultUsage 调用处未给）→
//      按「用户消息边界」归属：[本条所属用户消息, 下一条用户消息)。
//      ⚠️ 不能用 assistant.created_at 做窗口终点：流式轮次的 assistant 行是
//      中途 flush 时插入的（created_at ≈ 开流后几秒），账本行的 timestamp 是
//      结果 chunk 到达时刻，常在它之后。用用户消息切窗才不会被截断。
//   ③ session_compress 行是后台压缩，不属于任何对话 turn，两者都排除。
//
// 时长取账本：max(timestamp) - min(timestamp - duration_ms)，重试产生的新行
// 自然把跨度拉长；无账本行（旧轮 / 还没落账）→ 不显示时长，不拿首字延迟冒充。
// 缓存命中率口径见 ADR-0027：cacheRead ÷ (input + cacheRead + cacheCreation)。

import { cacheHitRateOf } from '@octopus/shared'
import type { AgentMessage } from './agent/types'
import type { LLMCallData } from './types'

export interface TurnStats {
  /** 本轮耗时（ms）；无账本行 → null。 */
  durationMs: number | null
  /** 本轮计入的 llm call 行数（重试 = 新行）。 */
  calls: number
  /** 四字段合计（含缓存），与账本 totals.tokens 同口径。 */
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 0–1；无输入类 token → null（不造假 0%）。 */
  cacheHitRate: number | null
  /** 本轮估算费用（USD，账本 cost_usd 按行求和）；整轮都没定价 → null。 */
  costUsd: number | null
  /** 是否每一行都配到了价；false 时金额带「≈」前缀（已知部分和）。 */
  costComplete: boolean
  /** 本轮实际命中的模型（去重、保持首次出现顺序；标题生成等辅助轮可能多一个）。 */
  models: string[]
}

function tsOf(iso: string | undefined | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** 该条消息是否值得挂统计行（与 TuiMeta 的「有无过程条目」判定同源）。 */
function showsProcess(message: AgentMessage): boolean {
  if (message.role !== 'assistant') return false
  if (message.displayType === 'event' || message.roleSwitch) return false
  return !!(
    (Array.isArray(message.timeline) && message.timeline.length > 0) ||
    message.thinking ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
  )
}

function statsFromRows(rows: readonly LLMCallData[]): TurnStats {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let spanStart: number | null = null
  let spanEnd: number | null = null
  let costUsd: number | null = null
  let costComplete = true
  const models: string[] = []
  for (const r of rows) {
    inputTokens += r.input_tokens ?? 0
    outputTokens += r.output_tokens ?? 0
    cacheReadTokens += r.cache_read_tokens ?? 0
    cacheCreationTokens += r.cache_creation_tokens ?? 0
    if (r.model && !models.includes(r.model)) models.push(r.model)
    // 账本视图 llm_calls_costed 的派生列：未配价 = null（不焊 0）。
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) {
      costUsd = (costUsd ?? 0) + r.cost_usd
    } else {
      costComplete = false
    }
    const end = r.timestamp
    const start = end - (r.duration_ms ?? 0)
    if (Number.isFinite(start)) spanStart = spanStart == null ? start : Math.min(spanStart, start)
    if (Number.isFinite(end)) spanEnd = spanEnd == null ? end : Math.max(spanEnd, end)
  }
  const usage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
  return {
    durationMs: spanStart != null && spanEnd != null ? Math.max(0, spanEnd - spanStart) : null,
    calls: rows.length,
    tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    ...usage,
    cacheHitRate: cacheHitRateOf(usage),
    costUsd,
    costComplete,
    models,
  }
}

/**
 * 为消息列表里的每个 assistant turn 计算统计。返回 messageId → stats。
 * 纯函数（无 React / 无 IO），供 ChatTab 的 viewMessages memo 调用。
 */
export function buildTurnStats(
  messages: readonly AgentMessage[],
  calls: readonly LLMCallData[],
): Map<string, TurnStats> {
  const out = new Map<string, TurnStats>()
  if (messages.length === 0) return out

  // 后台压缩不属于任何对话轮。
  const usable = calls.filter((c) => c.source_path !== 'session_compress')
  const byMessage = new Map<string, LLMCallData[]>()
  for (const c of usable) {
    if (!c.message_id) continue
    const list = byMessage.get(c.message_id)
    if (list) list.push(c)
    else byMessage.set(c.message_id, [c])
  }
  const ordered = [...usable].sort((a, b) => a.timestamp - b.timestamp)

  // Turn 边界 = 用户消息时刻。assistant 行是中途 flush 插入的，created_at
  // 不能当终点（见文件头②），只有用户发下一条时才真正切轮。
  const userStarts = messages
    .filter((m) => m.role === 'user')
    .map((m) => tsOf(m.created_at))
    .filter((t): t is number => t != null)
    .sort((a, b) => a - b)
  const turnStartOf = (t: number): number | null => {
    let start: number | null = null
    for (const s of userStarts) {
      if (s <= t) start = s
      else break
    }
    return start
  }
  const turnEndOf = (start: number): number => {
    for (const s of userStarts) if (s > start) return s
    return Number.POSITIVE_INFINITY
  }

  for (const m of messages) {
    if (!showsProcess(m)) continue
    let rows = byMessage.get(m.id) ?? []
    if (rows.length === 0) {
      const t = tsOf(m.created_at)
      const start = t == null ? null : turnStartOf(t)
      if (start == null) continue
      const end = turnEndOf(start)
      rows = ordered.filter((c) => c.timestamp >= start && c.timestamp < end)
    }
    if (rows.length === 0) continue
    out.set(m.id, statsFromRows(rows))
  }

  return out
}
