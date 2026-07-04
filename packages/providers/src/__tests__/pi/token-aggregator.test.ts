import { describe, it, expect } from 'vitest'
import { TokenAggregator } from '../../pi/token-aggregator'

describe('TokenAggregator', () => {
  it('aggregates two different models (TC-010)', () => {
    const agg = new TokenAggregator()
    agg.add('model-a', { input: 100, output: 50, cost: { total: 0.01 } })
    agg.add('model-b', { input: 200, output: 80, cost: { total: 0.02 } })

    const usage = agg.toTokenUsage()
    expect(usage).toEqual({ input: 300, output: 130, total: 430 })
    expect(agg.totalCost()).toBe(0.03)
    expect(agg.toModelUsages()).toHaveLength(2)
  })

  it('handles zero usage safely (TC-011)', () => {
    const agg = new TokenAggregator()
    agg.add('model', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: undefined })

    expect(agg.toTokenUsage()).toEqual({ input: 0, output: 0, total: 0 })
    expect(agg.totalCost()).toBe(0)
    expect(Number.isNaN(agg.totalCost())).toBe(false)
  })

  it('handles IEEE-754 float precision (TC-011b)', () => {
    const agg = new TokenAggregator()
    agg.add('model', { input: 1, output: 1, cost: { total: 0.1 } })
    agg.add('model', { input: 1, output: 1, cost: { total: 0.2 } })

    expect(Math.abs(agg.totalCost() - 0.3)).toBeLessThan(1e-9)
  })

  it('aggregates same model across multiple calls', () => {
    const agg = new TokenAggregator()
    agg.add('gpt-4o', { input: 50, output: 20, cost: { total: 0.005 } })
    agg.add('gpt-4o', { input: 30, output: 10, cost: { total: 0.003 } })

    expect(agg.toTokenUsage()).toEqual({ input: 80, output: 30, total: 110 })
    expect(agg.toModelUsages()).toHaveLength(1)
    expect(agg.toModelUsages()[0].inputTokens).toBe(80)
  })
})
