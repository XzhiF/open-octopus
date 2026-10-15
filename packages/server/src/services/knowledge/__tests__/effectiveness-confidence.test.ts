import { describe, it, expect } from "vitest"
import {
  CONFIDENCE_MIN_SAMPLES,
  LOW_CONFIDENCE_MAX,
  LOW_CONFIDENCE_MIN_CITED,
  rollupEffectiveness,
  rollupConfidence,
  helpfulRateOf,
  isLowConfidence,
  avgMeasuredConfidence,
  type EffectivenessRoll,
} from "../effectiveness-confidence"

/**
 * 票07 · S1 confidence 滚动计算（纯函数面）。
 * Expected 独立真相源 = spec 故事 3 公式 helpful/(helpful+not_helpful) + 票面「样本不足
 * （总记账 <3）保持编译期初值不抖动」+ 故事 5 低置信闸（confidence≤0.2 且引用≥3）。
 * 所有算例手算钉字面量，不从实现反推（禁 tautological）。
 */

function roll(cited: number, helpful: number, notHelpful: number): EffectivenessRoll {
  return rollupEffectiveness([{ cited_count: cited, helpful_count: helpful, not_helpful_count: notHelpful }])
}

describe("rollupEffectiveness — 页账目聚合", () => {
  it("多行求和：cited/helpful/not_helpful 各自相加，samples=helpful+not_helpful", () => {
    const r = rollupEffectiveness([
      { cited_count: 2, helpful_count: 1, not_helpful_count: 0 },
      { cited_count: 3, helpful_count: 0, not_helpful_count: 2 },
    ])
    expect(r.cited).toBe(5)
    expect(r.helpful).toBe(1)
    expect(r.notHelpful).toBe(2)
    expect(r.samples).toBe(3)
    expect(r.measured).toBe(true)
  })

  it("空行集（从未被记账的页）⇒ 全零、未测", () => {
    const r = rollupEffectiveness([])
    expect(r).toEqual({ cited: 0, helpful: 0, notHelpful: 0, samples: 0, measured: false })
  })

  it("样本不足闸：总记账 2 < 3 ⇒ measured=false；恰 3 ⇒ true", () => {
    expect(roll(5, 1, 1).measured).toBe(false)
    expect(roll(5, 1, 2).measured).toBe(true)
    expect(CONFIDENCE_MIN_SAMPLES).toBe(3) // 阈值对表票面（进 SCHEMA.md 建议口径=此单源）
  })
})

describe("rollupConfidence — 滚动值与不抖动纪律", () => {
  it("measured：helpful/(helpful+not_helpful) 手算字面（4/5=0.8 · 1/3=0.333 三位定标防抖动）", () => {
    expect(rollupConfidence(roll(9, 4, 1), 0.5)).toBe(0.8)
    expect(rollupConfidence(roll(9, 1, 2), 0.5)).toBe(0.333)
  })

  it("全坑账 0/(0+5)=0；全好账 5/5=1（两端点可触达，低置信闸才有语义）", () => {
    expect(rollupConfidence(roll(9, 0, 5), 0.9)).toBe(0)
    expect(rollupConfidence(roll(9, 5, 0), 0.1)).toBe(1)
  })

  it("样本不足保持编译期初值不抖动：初值 0.9 的页在 2 样本（即便全 helpful）仍报 0.9", () => {
    // 这正是「不抖动」的判别面：naive helpful/samples 会给 1.0——必须被闸回初值
    expect(rollupConfidence(roll(5, 2, 0), 0.9)).toBe(0.9)
    expect(rollupConfidence(roll(5, 0, 2), 0.5)).toBe(0.5)
  })
})

describe("helpfulRateOf — 原始 helpful 率（无闸，与 confidence 的闸值区分展示）", () => {
  it("有账即率（2/2=1 不受样本闸影响）；零账诚实 null", () => {
    expect(helpfulRateOf(roll(5, 2, 0))).toBe(1)
    expect(helpfulRateOf(roll(9, 3, 1))).toBe(0.75)
    expect(helpfulRateOf(roll(4, 0, 0))).toBeNull()
  })
})

describe("isLowConfidence — 故事 5 低置信闸", () => {
  it("confidence≤0.2 且 cited≥3 同时满足才低置信（spec 字样两条件 AND）", () => {
    expect(isLowConfidence(roll(3, 0, 3), 0)).toBe(true)
    expect(LOW_CONFIDENCE_MAX).toBe(0.2)
    expect(isLowConfidence(roll(3, 1, 4), 0.2)).toBe(true) // 边界等号含
    expect(LOW_CONFIDENCE_MIN_CITED).toBe(3)
    expect(isLowConfidence(roll(2, 0, 2), 0)).toBe(false) // 引用不足：差规则还没被验证，不催
    expect(isLowConfidence(roll(10, 6, 4), 0.6)).toBe(false) // 置信达标不扰
  })
})

describe("avgMeasuredConfidence — 健康条「全库平均 confidence」口径", () => {
  it("只均已测行（样本不足行的初值是编译期猜测，进均值会稀释实测信号）", () => {
    // 手算：measured 行 (4,1)→0.8 与 (0,4)→0，均值 0.4；未测行 (1,1) 不计
    const rows = [
      { cited_count: 9, helpful_count: 4, not_helpful_count: 1 },
      { cited_count: 9, helpful_count: 0, not_helpful_count: 4 },
      { cited_count: 9, helpful_count: 1, not_helpful_count: 1 },
    ]
    expect(avgMeasuredConfidence(rows)).toBe(0.4)
  })

  it("全库未测 ⇒ null（诚实无数据，不伪造 0.5）", () => {
    expect(avgMeasuredConfidence([{ cited_count: 1, helpful_count: 1, not_helpful_count: 0 }])).toBeNull()
    expect(avgMeasuredConfidence([])).toBeNull()
  })
})
