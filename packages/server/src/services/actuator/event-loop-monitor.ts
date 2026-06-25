// ponytail: Node.js stdlib perf_hooks — zero deps, < 1KB memory, official recommendation

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'

export class EventLoopMonitor {
  private histogram: IntervalHistogram | null = null
  private resetTimer: ReturnType<typeof setInterval> | null = null
  private resolution: number

  constructor(resolution: number = 20) {
    this.resolution = resolution
  }

  enable(): void {
    if (this.histogram) return
    this.histogram = monitorEventLoopDelay({ resolution: this.resolution })
    this.histogram.enable()
    // Reset every 60 seconds so readings reflect recent activity
    this.resetTimer = setInterval(() => this.reset(), 60_000)
  }

  disable(): void {
    if (this.resetTimer) {
      clearInterval(this.resetTimer)
      this.resetTimer = null
    }
    if (this.histogram) {
      this.histogram.disable()
      this.histogram = null
    }
  }

  getLagMs(): number {
    if (!this.histogram) return 0
    return this.histogram.percentile(99) / 1e6
  }

  getUtilization(): number {
    // lag as percentage of ideal 60fps frame budget (16.67ms)
    return this.getLagMs() / (1000 / 60) * 100
  }

  reset(): void {
    this.histogram?.reset()
  }
}
