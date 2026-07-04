import type { TokenUsage, ModelUsageEntry } from '../types'

interface PiUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total: number }
}

export class TokenAggregator {
  private entries: ModelUsageEntry[] = []
  private totalInput = 0
  private totalOutput = 0
  private costSum = 0

  add(model: string, usage: PiUsage): void {
    const input = usage.input ?? 0
    const output = usage.output ?? 0
    const cost = usage.cost?.total ?? 0

    this.totalInput += input
    this.totalOutput += output
    this.costSum += cost

    const existing = this.entries.find(e => e.model === model)
    if (existing) {
      existing.inputTokens += input
      existing.outputTokens += output
      existing.cacheReadInputTokens = (existing.cacheReadInputTokens ?? 0) + (usage.cacheRead ?? 0)
      existing.cacheCreationInputTokens = (existing.cacheCreationInputTokens ?? 0) + (usage.cacheWrite ?? 0)
      existing.costUsd = (existing.costUsd ?? 0) + cost
    } else {
      this.entries.push({
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: usage.cacheRead ?? 0,
        cacheCreationInputTokens: usage.cacheWrite ?? 0,
        costUsd: cost,
      })
    }
  }

  toTokenUsage(): TokenUsage {
    return {
      input: this.totalInput,
      output: this.totalOutput,
      total: this.totalInput + this.totalOutput,
    }
  }

  toModelUsages(): ModelUsageEntry[] {
    return [...this.entries]
  }

  totalCost(): number {
    return Math.round(this.costSum * 1e8) / 1e8
  }
}
