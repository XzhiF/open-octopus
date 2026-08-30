import { describe, it, expect, afterEach } from 'vitest'
import {
  priceFor,
  estimateCost,
  BUILTIN_PRICING,
  __setPricingOverlayForTest,
  __resetPricingOverlayForTest,
  type PricingTier,
} from '../pricing'

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0) => ({
  inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
})

afterEach(() => __resetPricingOverlayForTest())

describe('priceFor — 两阶段匹配（精确 → 剥尾部 [..] → null，无 default）', () => {
  it('内置 Claude 档精确命中（USD/MTok 数值钉死）', () => {
    __setPricingOverlayForTest(null)
    expect(priceFor('claude-sonnet-4-20250514')).toEqual({ input: 3, output: 15, cacheRead: 0.30, cacheCreation: 3.75 })
    expect(priceFor('claude-haiku-3-5')).toEqual({ input: 0.80, output: 4, cacheRead: 0.08, cacheCreation: 1 })
    expect(priceFor('claude-opus-4-20250514')).toEqual({ input: 15, output: 75, cacheRead: 1.50, cacheCreation: 18.75 })
    expect(BUILTIN_PRICING['claude-sonnet-4-5-20250827']!.output).toBe(15)
  })

  it('大小写 / 首尾空白不敏感（[1M] vs [1m] 漂移）', () => {
    __setPricingOverlayForTest({ 'qwen3.8-flash': { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 0.5 } })
    expect(priceFor(' Qwen3.8-Flash ')).not.toBeNull()
    expect(priceFor('CLAUDE-HAIKU-3-5')).toEqual(priceFor('claude-haiku-3-5'))
  })

  it('qwen 回归钉：未配置价 → null（任何代码不得复活 default 兜底）', () => {
    __setPricingOverlayForTest(null)
    expect(priceFor('qwen3.8-flash')).toBeNull()
    expect(priceFor('qwen3.7-max')).toBeNull()
    expect(priceFor('gpt-4o')).toBeNull()
    expect(priceFor('totally-unknown-model')).toBeNull()
  })

  it('剥尾部括号段：qwen3.8-flash[1m] / [1M] 接住基础价配置', () => {
    const tier: PricingTier = { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 0.5 }
    __setPricingOverlayForTest({ 'qwen3.8-flash': tier })
    expect(priceFor('qwen3.8-flash[1m]')).toEqual(tier)
    expect(priceFor('qwen3.8-flash[1M]')).toEqual(tier)
    expect(priceFor('qwen3.8-flash[1m]')).toBe(priceFor('qwen3.8-flash[1M]'))
  })

  it('变体精确键优先于剥括号命中（允许给 1M 档单独定价）', () => {
    const base: PricingTier = { input: 1, output: 2, cacheRead: 0.1, cacheCreation: 0.5 }
    const variant: PricingTier = { input: 4, output: 12, cacheRead: 0.4, cacheCreation: 2 }
    __setPricingOverlayForTest({ 'qwen3.8-flash': base, 'qwen3.8-flash[1m]': variant })
    expect(priceFor('qwen3.8-flash[1m]')).toEqual(variant)
    expect(priceFor('qwen3.8-flash[2m]')).toEqual(base) // 未单配的变体回落基础价
  })

  it('overlay 覆盖内置表（models.yaml 可对 Claude 改价）', () => {
    const custom: PricingTier = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    __setPricingOverlayForTest({ 'claude-haiku-3-5': custom })
    expect(priceFor('claude-haiku-3-5')).toBe(custom)
  })

  it('空/缺 model → null', () => {
    __setPricingOverlayForTest(null)
    expect(priceFor(undefined)).toBeNull()
    expect(priceFor(null)).toBeNull()
    expect(priceFor('')).toBeNull()
    expect(priceFor('  []  ')).toBeNull() // 剥完为空不查表
  })
})

describe('estimateCost — USD/MTok 换算 + 未定价 null', () => {
  it('四字段独立计价，/1e6 换算钉死', () => {
    const tier: PricingTier = { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }
    // 1M input → $3；1M output → $15；1M cacheRead → $0.30；1M cacheCreation → $3.75
    expect(estimateCost(usage(1_000_000, 0, 0, 0), tier)).toBeCloseTo(3, 10)
    expect(estimateCost(usage(0, 1_000_000, 0, 0), tier)).toBeCloseTo(15, 10)
    expect(estimateCost(usage(0, 0, 1_000_000, 0), tier)).toBeCloseTo(0.30, 10)
    expect(estimateCost(usage(0, 0, 0, 1_000_000), tier)).toBeCloseTo(3.75, 10)
    expect(estimateCost(usage(1000, 500, 2000, 100), tier)).toBeCloseTo(
      (1000 * 3 + 500 * 15 + 2000 * 0.3 + 100 * 3.75) / 1e6, 12,
    )
  })

  it('tier 为 null/undefined（未定价）→ null，绝不返回 0 假数', () => {
    expect(estimateCost(usage(100, 100), null)).toBeNull()
    expect(estimateCost(usage(100, 100), undefined)).toBeNull()
  })

  it('与 priceFor 组合：Claude 价 × 规范 TokenUsage 的端到端估算', () => {
    __setPricingOverlayForTest(null)
    const tier = priceFor('claude-sonnet-4-20250514')!
    // 纯值口径：input 不含 cache（对齐 ADR-0014）
    expect(estimateCost(usage(1_000_000, 100_000, 5_000_000, 200_000), tier)).toBeCloseTo(
      3 + 1.5 + 1.5 + 0.75, 10,
    )
  })
})
