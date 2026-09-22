import { z } from 'zod'

/**
 * TokenUsage — 全站唯一的用量记录形状（C1 口径统一）。
 *
 * 口径原则（承袭 1da62709「必须准」）：
 * - inputTokens / outputTokens 恒为**纯值**：input 不含 cacheRead/cacheCreation。
 * - 「总量」不是字段。需要总量必须走具名函数显式选口径（如 totalTokens），
 *   禁止再造 { input: in+cache } 这类把口径焊进字段的做法。
 * - message_start.usage.input_tokens 含 cache-reused、实测膨胀数千倍 —— 弃用，
 *   运行期唯一可靠来源是 message_delta.usage，权威终值是 result.modelUsage。
 *
 * 转换规则：snake_case ↔ camelCase 只允许发生在三个 seam 的 adapter 里——
 * SDK 入口（claude/pi provider）、DB 行（DAO usageFromRow）、wire 出口（REST/SSE）。
 */
export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
})
export type TokenUsage = z.infer<typeof TokenUsageSchema>

/**
 * per-turn 实测 delta（message_delta 携带）。直连 Anthropic 时 input/cache 字段
 * 可能缺失，故四个字段全部 optional —— 消费方按「缺失=本轮未测得」处理。
 */
export const TokenUsageDeltaSchema = TokenUsageSchema.partial()
export type TokenUsageDelta = z.infer<typeof TokenUsageDeltaSchema>

/**
 * 按模型粒度的权威用量（result.modelUsage 的规范投影）。
 * costUsd 为 SDK/价表给出的美元费用；undefined = 未定价（不得伪造为 0）。
 */
export const ModelUsageSchema = TokenUsageSchema.extend({
  model: z.string(),
  costUsd: z.number().optional(),
})
export type ModelUsage = z.infer<typeof ModelUsageSchema>

export function emptyTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

/**
 * llm_calls.source_path —— 记账来源维度（billing-coverage-2 KD20）：六个真实来源 +
 * `unknown` 兜底（回填推断不出者，KD21）。独立枚举，**不复用** node_token_usages.source
 * （后者是 harness 标记，跨表语义已混）。phase 2 新增聊天三源 = clone_chat /
 * global_chat / session_compress。
 */
export const LLM_CALL_SOURCE_PATHS = [
  'workflow', 'interaction', 'harness',
  'clone_chat', 'global_chat', 'session_compress',
  'unknown',
] as const
export type LlmCallSourcePath = (typeof LLM_CALL_SOURCE_PATHS)[number]

export function isLlmCallSourcePath(v: unknown): v is LlmCallSourcePath {
  return typeof v === 'string' && (LLM_CALL_SOURCE_PATHS as readonly string[]).includes(v)
}

/**
 * 模型名归一化（billing NEW-r2：账本与价表在「规范名」空间相遇）。
 *
 * SDK/代理上报的模型名常带上下文窗口后缀（`qwen3.8-flash[1M]`），代理异常时甚至
 * 叠出残脏（`x[1M]][1M]`）——价格按 model_id 精确匹配，不归一化就永远配不上。
 * 规则：**尾部括号残渣循环剥离至不动点**（成对 `[...]` 组与孤立 `]` 都算残渣）；
 * 只作用于末尾，中段的 `[...]` 不碰。落账前与配价保存时双端调用，同一实现。
 * 例：`a[1M]`→`a`；`a[1M]][1M]`→`a`；`a[beta]-v2`→原样。
 */
export function normalizeModelId(model: string | null | undefined): string | null {
  if (model == null) return null
  let s = model.trim()
  let prev: string
  do {
    prev = s
    s = s.replace(/(?:\s*\[[^\]]*\]|\s*\])+$/, '')
  } while (s !== prev)
  return s
}

/** 全口径总 token 数（含 cache）。聚合端点的「总 tokens」口径以此为准。 */
export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens
}

/** 把 per-turn delta 累加进累计值（缺失字段视为未测得，不累加）。返回新对象。 */
export function addTokenUsage(base: TokenUsage, delta: TokenUsageDelta): TokenUsage {
  return {
    inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
    cacheReadTokens: base.cacheReadTokens + (delta.cacheReadTokens ?? 0),
    cacheCreationTokens: base.cacheCreationTokens + (delta.cacheCreationTokens ?? 0),
  }
}

/** 跨模型合并为一份总量（修复「只取 modelUsages[0]」丢数类问题）。 */
export function mergeModelUsages(list: readonly ModelUsage[]): TokenUsage {
  return list.reduce<TokenUsage>(add, emptyTokenUsage())
}

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  }
}
