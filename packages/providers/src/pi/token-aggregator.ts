import type { TokenUsage, ModelUsage } from '@octopus/shared'

interface PiUsage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  cost?: { total: number }
}

/**
 * Pi SDK per-message usage 聚合器。
 * 产出全站规范形状（C1）：input/output 为纯值（Pi SDK 的 usage.input 本身不含
 * cacheRead/cacheWrite，直接沿用），cache 两列独立累计。
 */
export class TokenAggregator {
  private entries: ModelUsage[] = []
  private total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  private costSum = 0

  add(model: string, usage: PiUsage): void {
    const input = usage.input ?? 0
    const output = usage.output ?? 0
    const cacheRead = usage.cacheRead ?? 0
    const cacheCreation = usage.cacheWrite ?? 0
    const cost = usage.cost?.total ?? 0

    this.total.inputTokens += input
    this.total.outputTokens += output
    this.total.cacheReadTokens += cacheRead
    this.total.cacheCreationTokens += cacheCreation
    this.costSum += cost

    const existing = this.entries.find(e => e.model === model)
    if (existing) {
      existing.inputTokens += input
      existing.outputTokens += output
      existing.cacheReadTokens += cacheRead
      existing.cacheCreationTokens += cacheCreation
      // C2：pi SDK 按注册表算出的 0 价 = 未注册价（假实测），归一为 undefined 未定价
      const sum = (existing.costUsd ?? 0) + cost
      existing.costUsd = sum > 0 ? sum : undefined
    } else {
      this.entries.push({
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        costUsd: cost > 0 ? cost : undefined,
      })
    }
  }

  toTokenUsage(): TokenUsage {
    return { ...this.total }
  }

  toModelUsages(): ModelUsage[] {
    return this.entries.map(e => ({ ...e }))
  }

  totalCost(): number {
    return Math.round(this.costSum * 1e8) / 1e8
  }
}
