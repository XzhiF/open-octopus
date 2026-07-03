import type { TokenUsage, ModelUsageEntry } from '../types'

interface Usage {
  input: number
  output: number
  cost?: number
}

export class TokenAggregator {
  private entries: Array<{ model: string; usage: Usage }> = []

  add(model: string, usage: Usage): void {
    this.entries.push({ model, usage })
  }

  toTokenUsage(): TokenUsage {
    let input = 0
    let output = 0
    for (const e of this.entries) {
      input += e.usage.input
      output += e.usage.output
    }
    return { input, output, total: input + output }
  }

  toModelUsages(): ModelUsageEntry[] {
    const grouped = new Map<string, { input: number; output: number; cost: number }>()
    for (const e of this.entries) {
      const existing = grouped.get(e.model) ?? { input: 0, output: 0, cost: 0 }
      existing.input += e.usage.input
      existing.output += e.usage.output
      existing.cost += e.usage.cost ?? 0
      grouped.set(e.model, existing)
    }
    return [...grouped.entries()].map(([model, data]) => ({
      model,
      inputTokens: data.input,
      outputTokens: data.output,
      costUsd: data.cost,
    }))
  }

  totalCost(): number {
    return this.entries.reduce((sum, e) => sum + (e.usage.cost ?? 0), 0)
  }
}
