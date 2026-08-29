import { TokenUsageSchema, emptyTokenUsage, type TokenUsage } from '@octopus/shared'

/**
 * 行 → 规范 TokenUsage 的唯一转换点（C1 · D4）。
 * snake_case 列名只允许出现在 DAO 出口；DAO 之外的 server 代码一律说 TokenUsage。
 */
export interface UsageColumns {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_tokens?: number | null
  cache_creation_tokens?: number | null
}

export function usageFromRow(row: UsageColumns): TokenUsage {
  return TokenUsageSchema.parse({
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
  })
}

/**
 * 历史 JSON blob（messages.metadata.tokens / schedule_executions.token_usage /
 * harness_events.token_usage_json）的读侧归一。存量行无法拆分 cache，
 * 按原值映射（口径解释属 C3）；新行（C1 后写入）已是规范形状直接过 schema。
 */
export function usageFromLegacyJson(parsed: unknown): TokenUsage {
  if (!parsed || typeof parsed !== 'object') return emptyTokenUsage()
  const o = parsed as Record<string, unknown>
  if (typeof o.inputTokens === 'number' || typeof o.outputTokens === 'number') {
    return TokenUsageSchema.parse({ ...emptyTokenUsage(), ...o })
  }
  // legacy merged shape: { input, output, cacheRead?, cacheCreation?, total? }
  return {
    inputTokens: typeof o.input === 'number' ? o.input : 0,
    outputTokens: typeof o.output === 'number' ? o.output : 0,
    cacheReadTokens: typeof o.cacheRead === 'number' ? o.cacheRead : 0,
    cacheCreationTokens: typeof o.cacheCreation === 'number' ? o.cacheCreation : 0,
  }
}

/** harness_events.token_usage_json 出口归一（旧行 legacy / 新行规范 → 统一规范 JSON）。 */
export function normalizeUsageJson(text: string | null | undefined): string | null {
  if (!text) return text ?? null
  try {
    return JSON.stringify(usageFromLegacyJson(JSON.parse(text)))
  } catch {
    return text
  }
}
