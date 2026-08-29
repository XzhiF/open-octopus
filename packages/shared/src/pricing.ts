import { loadModelAliasConfig } from './config/model-alias'

/**
 * 全站唯一计价模块（C2 · ADR-0015）。
 *
 * 单位：**USD / MTok**（每百万 token 美元价）——与 models.yaml `cost`、pi SDK
 * 注册表、厂商官网一致。token→美元的换算只发生在 `estimateCost()` 内部。
 *
 * 诚实原则（D2）：**没有 default 兜底档**。查不到价 = `null` = 未定价 →
 * 上层把 cost 写成 NULL/undefined。宁可 NULL，不静默假计费
 * （旧 MODEL_PRICING.default=sonnet 价曾让 qwen 系每笔都被按 $3/$15 假记账）。
 *
 * 价来源两层（overlay 优先，用于覆盖/补价）：
 * 1. models.yaml `custom_providers.*.models[].cost`（懒加载一次）——补价通道，
 *    改数据不改代码；
 * 2. `BUILTIN_PRICING`——仅收录可验证的 Claude 系官方价（SDK 缺 costUSD 时兜底）。
 */

/** 一档单价，四字段全部为 USD/MTok。字段名与 TokenUsage 的四个计数一一对应。 */
export interface PricingTier {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/** 可验证的官方价（USD/MTok）。qwen 等分档计价模型不收录——写单档即错价，NULL 更诚实。 */
export const BUILTIN_PRICING: Readonly<Record<string, PricingTier>> = {
  'claude-sonnet-4-20250514':    { input: 3,    output: 15, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-sonnet-4-5-20250827':  { input: 3,    output: 15, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-haiku-3-5':            { input: 0.80, output: 4,  cacheRead: 0.08, cacheCreation: 1 },
  'claude-opus-4-20250514':      { input: 15,   output: 75, cacheRead: 1.50, cacheCreation: 18.75 },
}

interface PricingUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

// —— overlay：models.yaml 补价（懒加载；测试可钉住） ——

let overlay: Record<string, PricingTier> | null = null

function pricingKey(model: string): string {
  return model.trim().toLowerCase()
}

function buildOverlay(): Record<string, PricingTier> {
  const map: Record<string, PricingTier> = {}
  try {
    const cfg = loadModelAliasConfig()
    for (const provider of Object.values(cfg.custom_providers)) {
      for (const m of provider.models) {
        const t = m.cost
        // 全 0 = models.yaml 里没填价 = 未定价，不入 overlay（区别于误把 0 当免费）
        if (!t || (t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite === 0)) continue
        map[pricingKey(m.id)] = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheWrite }
      }
    }
  } catch {
    // 配置读取失败不致命：退化为只有内置表
  }
  return map
}

/**
 * 两阶段匹配（共识 ①）：
 * 1. 精确命中（key 统一 trim+lowercase，解决 `[1M]`/`[1m]` 大小写漂移）；
 * 2. miss → 剥掉尾部 `[...]` 变体段再精确一次——代理上报的
 *    `qwen3.8-flash[1m]` 接住用户配置的 `qwen3.8-flash` 价；
 *    想给变体单独定价就配精确键 `qwen3.8-flash[1m]`，阶段 1 自动优先。
 * 无 default、无前缀猜测。
 */
export function priceFor(model: string | null | undefined): PricingTier | null {
  if (!model) return null
  if (overlay === null) overlay = buildOverlay()
  const builtin = BUILTIN_PRICING as Record<string, PricingTier>
  let key = pricingKey(model)
  if (overlay[key]) return overlay[key]
  if (builtin[key]) return builtin[key]
  key = key.replace(/(\[[^\]]*\])+$/, '').trim()
  if (key && overlay[key]) return overlay[key]
  if (key && builtin[key]) return builtin[key]
  return null
}

/**
 * 按档位估算一次用量的美元成本。tier 为 null（未定价）→ null。
 * 返回值是**估算**，非账单实测——系统内不存在 measured cost（D3：类型层语义，不落库）。
 */
export function estimateCost(usage: PricingUsage, tier: PricingTier | null | undefined): number | null {
  if (!tier) return null
  return (
    usage.inputTokens * tier.input +
    usage.outputTokens * tier.output +
    usage.cacheReadTokens * tier.cacheRead +
    usage.cacheCreationTokens * tier.cacheCreation
  ) / 1e6
}

// —— 测试钩子 ——

/** 钉住 overlay（传入即用；null 清空）。只应在测试中调用。 */
export function __setPricingOverlayForTest(entries: Record<string, PricingTier> | null): void {
  overlay = entries ?? {}
}

/** 恢复懒加载。只应在测试 teardown 中调用。 */
export function __resetPricingOverlayForTest(): void {
  overlay = null
}
