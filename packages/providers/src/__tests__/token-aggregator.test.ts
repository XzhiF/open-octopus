import { describe, it, expect } from 'vitest'
import { TokenAggregator } from '../pi/token-aggregator'

describe('TokenAggregator', () => {
  it('aggregates single model calls', () => {
    const agg = new TokenAggregator()
    agg.add('claude-sonnet', { input: 100, output: 50, cost: 0.001 })
    agg.add('claude-sonnet', { input: 200, output: 100, cost: 0.002 })
    expect(agg.toTokenUsage()).toEqual({ input: 300, output: 150, total: 450 })
    expect(agg.toModelUsages()).toHaveLength(1)
    expect(agg.toModelUsages()[0].model).toBe('claude-sonnet')
  })

  it('groups by model', () => {
    const agg = new TokenAggregator()
    agg.add('claude-sonnet', { input: 100, output: 50, cost: 0.001 })
    agg.add('gpt-4o', { input: 200, output: 100, cost: 0.003 })
    expect(agg.toModelUsages()).toHaveLength(2)
    expect(agg.totalCost()).toBeCloseTo(0.004, 6)
  })

  it('maintains cost precision', () => {
    const agg = new TokenAggregator()
    agg.add('model-a', { input: 10, output: 5, cost: 0.000001 })
    expect(agg.totalCost()).toBeCloseTo(0.000001, 6)
  })
})
