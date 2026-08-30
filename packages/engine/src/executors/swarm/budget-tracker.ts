import type { BudgetStatus } from "./swarm-types"
import type { TokenUsage, ModelUsage } from "@octopus/shared"
import { mergeModelUsages } from "@octopus/shared"

export class BudgetTracker {
  private consumed = 0
  private usages: ModelUsage[] = []

  constructor(
    private tokenLimit?: number,
    private timeoutSeconds?: number,
    private tokenCountingMode: "all" | "no_cache" = "no_cache",
  ) {}

  /** Record a single LLM call's token usage (legacy — total tokens only) */
  addTokens(count: number): void {
    this.consumed += count
  }

  /** Record a detailed LLM call with per-model breakdown — usage 为规范形状（纯值口径） */
  addUsage(model: string, usage: TokenUsage, costUsd?: number): void {
    const cache = this.tokenCountingMode === "all" ? usage.cacheReadTokens + usage.cacheCreationTokens : 0
    this.consumed += usage.inputTokens + usage.outputTokens + cache
    const existing = this.usages.find(u => u.model === model)
    if (existing) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.cacheReadTokens += usage.cacheReadTokens
      existing.cacheCreationTokens += usage.cacheCreationTokens
      existing.costUsd = (existing.costUsd ?? 0) + (costUsd ?? 0)
    } else {
      this.usages.push({
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd,
      })
    }
  }

  getConsumed(): number {
    return this.consumed
  }

  /** 全模型聚合的规范用量（纯值四字段；总量由调用方经 totalTokens() 显式选口径） */
  getTokenUsage(): TokenUsage {
    return mergeModelUsages(this.usages)
  }

  /** Per-model usage breakdown for persistence and UI display */
  getModelUsages(): ModelUsage[] {
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
