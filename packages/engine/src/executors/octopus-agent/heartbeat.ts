// packages/engine/src/executors/octopus-agent/heartbeat.ts
//
// HeartbeatHandler for octopus_agent nodes.
// Counts steps, emits heartbeats at intervals, checks budget, detects stalls.
//

import type { AgentEvent } from "../agent-types"
import type { HarnessConfig, BudgetConfig, AgentHeartbeat, HarnessDirective, TokenUsage } from "@octopus/shared"
import { emptyTokenUsage, totalTokens } from "@octopus/shared"

/**
 * HeartbeatHandler tracks agent execution progress and emits heartbeats.
 *
 * Responsibilities:
 * - Count tool_result events as steps
 * - Emit heartbeat every N steps (heartbeat_interval, default 3)
 * - Track token usage and check budget limits
 * - Detect stalls (no events within heartbeat_timeout)
 * - Track artifacts and current activity
 *
 * v1 placeholders:
 * - confidence: -1 (not implemented, future: heartbeat prompt protocol)
 * - issues: [] (not implemented, future: agent self-reporting)
 */
export class HeartbeatHandler {
  private stepCounter = 0
  private lastActivityAt = Date.now()
  private tokensUsed: TokenUsage = emptyTokenUsage()
  private artifacts: string[] = []
  private lastActivity = ""
  private hasAborted = false

  constructor(
    private readonly nodeId: string,
    private readonly config: HarnessConfig,
    private readonly budget?: BudgetConfig,
    private readonly onEvent?: (event: AgentEvent) => void,
  ) {}

  /**
   * Process an agent event and emit heartbeat if needed.
   */
  onAgentEvent(event: AgentEvent): void {
    this.lastActivityAt = Date.now()

    // Count tool_result as steps
    if (event.type === "tool_result") {
      this.stepCounter++

      // Emit heartbeat at interval
      const interval = this.config.heartbeat_interval ?? 3
      if (this.stepCounter % interval === 0) {
        this.emitHeartbeat()
      }

      // Check budget if auto_abort_on_budget enabled
      if (
        !this.hasAborted &&
        this.config.auto_abort_on_budget &&
        this.budget?.max_tokens
      ) {
        if (totalTokens(this.tokensUsed) > this.budget.max_tokens) {
          this.emitBudgetExceededDirective()
        }
      }
    }

    // Track current activity from text_delta
    if (event.type === "text_delta") {
      // Take first 100 chars as activity description
      this.lastActivity = event.content.slice(0, 100).trim()
    }
  }

  /**
   * Get the current step count.
   */
  getStepCount(): number {
    return this.stepCounter
  }

  /**
   * Get the last activity timestamp.
   */
  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  /**
   * Update token usage tracking — 规范 TokenUsage（纯值口径）。
   * tokens_used 心跳标量 = totalTokens(usage)，与旧「合并 total」数值等价。
   */
  updateTokens(usage: TokenUsage): void {
    this.tokensUsed = usage
  }

  /**
   * Add an artifact to the tracking list.
   */
  addArtifact(artifact: string): void {
    if (!this.artifacts.includes(artifact)) {
      this.artifacts.push(artifact)
    }
  }

  /**
   * Check if the agent has stalled (no events within heartbeat_timeout).
   * Returns true if stalled.
   */
  checkStall(): boolean {
    const timeoutSeconds = this.config.heartbeat_timeout ?? 300
    const elapsed = (Date.now() - this.lastActivityAt) / 1000
    return elapsed > timeoutSeconds
  }

  /**
   * Emit a heartbeat event.
   */
  private emitHeartbeat(): void {
    const heartbeat: AgentHeartbeat = {
      step: this.stepCounter,
      tokens_used: totalTokens(this.tokensUsed),
      tokens_budget: this.budget?.max_tokens,
      artifacts: [...this.artifacts],
      issues: [], // v1: placeholder, future: agent self-reporting
      confidence: -1, // v1: placeholder, future: heartbeat prompt protocol
      current_activity: this.lastActivity || undefined,
    }

    this.onEvent?.({
      type: "heartbeat",
      data: heartbeat,
    })
  }

  /**
   * Emit a harness_directive abort event when budget exceeded.
   */
  private emitBudgetExceededDirective(): void {
    this.hasAborted = true

    const directive: HarnessDirective = {
      type: "abort",
      reason: `Token budget exceeded: ${totalTokens(this.tokensUsed)}/${this.budget!.max_tokens}`,
      issued_by: "harness",
      timestamp: Date.now(),
    }

    this.onEvent?.({
      type: "harness_directive",
      data: directive,
    })
  }
}
