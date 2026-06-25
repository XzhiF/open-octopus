import type { BudgetStatus } from "./swarm-types"
import type { TokenUsage, ModelUsageEntry } from "@octopus/providers"

export class BudgetTracker {
  private consumed = 0
  private usages: ModelUsageEntry[] = []

  constructor(
    private tokenLimit?: number,
    private timeoutSeconds?: number,
  ) {}

  /** Record a single LLM call's token usage (legacy — total tokens only) */
  addTokens(count: number): void {
    this.consumed += count
  }

  /** Record a detailed LLM call with per-model breakdown */
  addUsage(model: string, input: number, output: number, cacheRead?: number, cacheCreation?: number, costUsd?: number): void {
    this.consumed += input + output
    const existing = this.usages.find(u => u.model === model)
    if (existing) {
      existing.inputTokens += input
      existing.outputTokens += output
      existing.cacheReadInputTokens = (existing.cacheReadInputTokens ?? 0) + (cacheRead ?? 0)
      existing.cacheCreationInputTokens = (existing.cacheCreationInputTokens ?? 0) + (cacheCreation ?? 0)
      existing.costUsd = (existing.costUsd ?? 0) + (costUsd ?? 0)
    } else {
      this.usages.push({
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: cacheRead,
        cacheCreationInputTokens: cacheCreation,
        costUsd,
      })
    }
  }

  getConsumed(): number {
    return this.consumed
  }

  /** Aggregate token totals (input + output across all models) */
  getTokenUsage(): TokenUsage {
    const input = this.usages.reduce((s, u) => s + u.inputTokens, 0)
    const output = this.usages.reduce((s, u) => s + u.outputTokens, 0)
    return { input, output, total: input + output }
  }

  /** Per-model usage breakdown for persistence and UI display */
  getModelUsages(): ModelUsageEntry[] {
    return this.usages.filter(u => u.inputTokens > 0 || u.outputTokens > 0)
  }

  checkBudget(): BudgetStatus {
    if (!this.tokenLimit) {
      return { status: "ok", consumed: this.consumed, limit: null, percentage: 0 }
    }

    const percentage = this.consumed / this.tokenLimit
    if (this.consumed >= this.tokenLimit) {
      return { status: "exhausted", consumed: this.consumed, limit: this.tokenLimit, percentage }
    }
    if (percentage >= 0.9) {
      return { status: "warning", consumed: this.consumed, limit: this.tokenLimit, percentage }
    }
    return { status: "ok", consumed: this.consumed, limit: this.tokenLimit, percentage }
  }

  isTimedOut(startTime: number): boolean {
    if (!this.timeoutSeconds) return false
    const elapsed = (Date.now() - startTime) / 1000
    return elapsed >= this.timeoutSeconds
  }
}
