import { loadModelAliasConfig, type ModelAliasConfig } from './config/model-alias'

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
 * 1. models.yaml —— `model_presets`（预设层：继承供给 + 定价终审）与
 *    `custom_providers.*.models[].cost`（懒加载一次）；改数据不改代码；
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

function sameTier(a: PricingTier, b: PricingTier): boolean {
  return a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheCreation === b.cacheCreation
}

/** cost 块 → PricingTier。不完整块（preset 少字段）/ 全 0 = 不可定价 → null。 */
function toTier(cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): PricingTier | null {
  if (!cost) return null
  const { input, output, cacheRead, cacheWrite } = cost
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null
  return { input, output, cacheRead, cacheCreation: cacheWrite }
}

/**
 * overlay 装配（2026-08-30 预设层扩展，ADR-0015 §model_presets）。键空间两族：
 * - **前缀键 `provider/id`**：custom 条目价（含 model_presets 继承后的生效值）；
 *   带 `/` 的预设条目精确覆盖同名前缀键（厂商级终审）。
 * - **裸键 `id`**：SDK 报裸名的命中面（claude 代理场景）。取值优先级：
 *   裸名预设（终审）> custom 各商一致的唯一值；多商不同价且无预设终审 →
 *   裸键丢弃 + warn（宁可未定价，不静默选边——D2 无 default 精神的延伸）。
 * 键统一 trim+lowercase；全 0 块 = 没填价，不入表。
 */
function buildOverlay(cfg: ModelAliasConfig): Record<string, PricingTier> {
  const map: Record<string, PricingTier> = {}
  try {
    const bareCands = new Map<string, Array<{ tier: PricingTier; source: string }>>()
    for (const [pname, provider] of Object.entries(cfg.custom_providers)) {
      for (const m of provider.models) {
        const tier = toTier(m.cost)
        if (!tier) continue
        const idKey = pricingKey(m.id)
        map[`${pricingKey(pname)}/${idKey}`] = tier
        const cands = bareCands.get(idKey) ?? []
        cands.push({ tier, source: pname })
        bareCands.set(idKey, cands)
      }
    }
    const preBare = new Map<string, PricingTier>()
    for (const p of cfg.model_presets) {
      const key = pricingKey(p.id)
      const tier = toTier(p.cost)
      if (!tier) {
        if (p.cost) console.warn(`[pricing] model_presets "${p.id}" 的 cost 块不完整（需 input/output/cacheRead/cacheWrite 四字段），该价不生效`)
        continue
      }
      if (key.includes('/')) map[key] = tier
      else preBare.set(key, tier)
    }
    for (const [key, tier] of preBare) map[key] = tier
    for (const [key, cands] of bareCands) {
      if (preBare.has(key)) continue
      const uniq: Array<{ tier: PricingTier; source: string }> = []
      for (const c of cands) if (!uniq.some((u) => sameTier(u.tier, c.tier))) uniq.push(c)
      if (uniq.length === 1) map[key] = cands[0].tier
      else console.warn(`[pricing] 裸模型名 "${key}" 在 ${uniq.map((u) => u.source).join(" / ")} 间价格不一致，裸名查询按未定价处理——在 model_presets 配 "${key}" 可终审定价`)
    }
  } catch {
    // 配置读取失败不致命：退化为只有内置表
  }
  return map
}

/**
 * 两阶段匹配（共识 ①）：
 * 1. 精确命中（key 统一 trim+lowercase，解决 `[1M]`/`[1m]` 大小写漂移）——
 *    pi 报 `dashscope/qwen3.7-plus` 带前缀名命中 overlay 前缀键（厂商级价）；
 * 2. miss → 剥掉尾部 `[...]` 变体段再精确一次——代理上报的
 *    `qwen3.8-flash[1m]` 接住用户配置的 `qwen3.8-flash` 价；
 *    想给变体单独定价就配精确键 `qwen3.8-flash[1m]`，阶段 1 自动优先。
 * 无 default、无 provider 猜测（报裸名时不跨商选价，见 buildOverlay 裸键裁决）。
 */
export function priceFor(model: string | null | undefined): PricingTier | null {
  if (!model) return null
  if (overlay === null) overlay = buildOverlay(loadModelAliasConfig())
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

/** 用给定 config 装配 overlay（纯装配器，测试直打；不读文件）。 */
export function __buildOverlayForTest(cfg: ModelAliasConfig): Record<string, PricingTier> {
  return buildOverlay(cfg)
}

/** 钉住 overlay（传入即用；null 清空）。只应在测试中调用。 */
export function __setPricingOverlayForTest(entries: Record<string, PricingTier> | null): void {
  overlay = entries ?? {}
}

/** 恢复懒加载。只应在测试 teardown 中调用。 */
export function __resetPricingOverlayForTest(): void {
  overlay = null
}
