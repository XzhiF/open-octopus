// packages/server/src/services/agent/autonomous-loop.ts
import type { SuggestionEngine } from "../suggestion-engine"
import type { ArchiveDAO } from "../../db/dao/archive-dao"
import type { ExperienceDAO } from "../../db/dao/experience-dao"

export class AutonomousLoop {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private suggestionEngine: SuggestionEngine,
    private archiveDAO: ArchiveDAO,
    private experienceDAO: ExperienceDAO,
    private config: {
      cronIntervalMs?: number  // default 6 hours
      enabled?: boolean        // feature flag
    } = {},
  ) {}

  start(): void {
    if (!this.config.enabled) {
      console.log("[autonomous-loop] Disabled by feature flag")
      return
    }
    const interval = this.config.cronIntervalMs ?? 6 * 60 * 60 * 1000
    this.running = true
    this.observe() // Run once at startup
    this.timer = setInterval(() => this.observe(), interval)
    console.log(`[autonomous-loop] Started (interval: ${interval / 3600000}h)`)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async observe(): Promise<void> {
    if (!this.running) return
    try {
      // Phase 1: Observe
      const patterns = this.suggestionEngine.analyzeRepeatingPatterns(7)
      const costs = this.suggestionEngine.analyzeCostOptimization(7)

      // Phase 2: Decide — prioritize
      const actions: Array<{ priority: number; type: string; detail: string }> = []

      for (const p of patterns) {
        actions.push({ priority: p.severity === 'critical' ? 1 : 2, type: 'pattern', detail: p.recommendation })
      }
      for (const c of costs) {
        actions.push({ priority: 3, type: 'cost', detail: c.detail })
      }

      actions.sort((a, b) => a.priority - b.priority)

      // Phase 3: Execute
      for (const action of actions.slice(0, 3)) { // Max 3 actions per cycle
        console.log(`[autonomous-loop] Action: [${action.type}] ${action.detail}`)
        // For now, log only. Future: auto-register schedules, inject fixes
      }

      // Phase 4: Learn — record the cycle itself as an archive entry
      if (actions.length > 0) {
        console.log(`[autonomous-loop] Cycle complete: ${actions.length} actions identified`)
      }
    } catch (err) {
      console.warn("[autonomous-loop] Cycle failed:", err)
    }
  }
}
