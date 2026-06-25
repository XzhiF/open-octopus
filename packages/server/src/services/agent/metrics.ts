// ── Metrics ─────────────────────────────────────────────────────────
// Lightweight metrics collection for the agent system.
// Maps to PRD P3.5: Tracer + Metrics observability.

export type MetricType = 'counter' | 'gauge' | 'histogram'

export interface MetricValue {
  name: string
  type: MetricType
  value: number
  labels: Record<string, string>
  timestamp: number
}

export interface HistogramBucket {
  le: number
  count: number
}

export interface HistogramValue {
  name: string
  count: number
  sum: number
  min: number
  max: number
  avg: number
  p50: number
  p95: number
  p99: number
  buckets: HistogramBucket[]
}

// ── MetricsCollector ────────────────────────────────────────────────

/**
 * Simple in-memory metrics collector with counter, gauge, and histogram support.
 * Provides Prometheus-compatible naming conventions.
 */
export class MetricsCollector {
  private counters: Map<string, { value: number; labels: Record<string, string> }> = new Map()
  private gauges: Map<string, { value: number; labels: Record<string, string> }> = new Map()
  private histograms: Map<string, number[]> = new Map()
  private maxHistogramValues = 10000

  // ── Counters ──────────────────────────────────────────────────────

  /**
   * Increment a counter metric.
   */
  increment(name: string, value = 1, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels)
    const existing = this.counters.get(key)
    if (existing) {
      existing.value += value
    } else {
      this.counters.set(key, { value, labels })
    }
  }

  /**
   * Get current counter value.
   */
  getCounter(name: string, labels: Record<string, string> = {}): number {
    const key = this.makeKey(name, labels)
    return this.counters.get(key)?.value ?? 0
  }

  // ── Gauges ────────────────────────────────────────────────────────

  /**
   * Set a gauge metric value (absolute).
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels)
    this.gauges.set(key, { value, labels })
  }

  /**
   * Get current gauge value.
   */
  getGauge(name: string, labels: Record<string, string> = {}): number {
    const key = this.makeKey(name, labels)
    return this.gauges.get(key)?.value ?? 0
  }

  // ── Histograms ────────────────────────────────────────────────────

  /**
   * Record a histogram observation.
   */
  observe(name: string, value: number): void {
    const values = this.histograms.get(name) ?? []
    if (values.length >= this.maxHistogramValues) {
      // Ring buffer: drop oldest 10%
      values.splice(0, Math.floor(this.maxHistogramValues * 0.1))
    }
    values.push(value)
    this.histograms.set(name, values)
  }

  /**
   * Get histogram statistics.
   */
  getHistogram(name: string): HistogramValue | null {
    const values = this.histograms.get(name)
    if (!values || values.length === 0) return null

    const sorted = [...values].sort((a, b) => a - b)
    const sum = sorted.reduce((acc, v) => acc + v, 0)
    const buckets = this.computeBuckets(sorted)

    return {
      name,
      count: sorted.length,
      sum,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / sorted.length,
      p50: this.percentile(sorted, 50),
      p95: this.percentile(sorted, 95),
      p99: this.percentile(sorted, 99),
      buckets,
    }
  }

  // ── Convenience ───────────────────────────────────────────────────

  /**
   * Time an async operation and record as histogram.
   */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now()
    try {
      const result = await fn()
      this.observe(name, Date.now() - start)
      this.increment(`${name}_total`, 1, { status: 'success' })
      return result
    } catch (err) {
      this.observe(name, Date.now() - start)
      this.increment(`${name}_total`, 1, { status: 'error' })
      throw err
    }
  }

  // ── Export ────────────────────────────────────────────────────────

  /**
   * Export all metrics as a flat array.
   */
  export(): MetricValue[] {
    const result: MetricValue[] = []
    const now = Date.now()

    for (const [key, counter] of this.counters) {
      result.push({
        name: key,
        type: 'counter',
        value: counter.value,
        labels: counter.labels,
        timestamp: now,
      })
    }

    for (const [key, gauge] of this.gauges) {
      result.push({
        name: key,
        type: 'gauge',
        value: gauge.value,
        labels: gauge.labels,
        timestamp: now,
      })
    }

    for (const [name, values] of this.histograms) {
      const hist = this.getHistogram(name)
      if (hist) {
        result.push({
          name: `${name}_summary`,
          type: 'histogram',
          value: hist.avg,
          labels: { count: String(hist.count), p95: String(hist.p95) },
          timestamp: now,
        })
      }
    }

    return result
  }

  /**
   * Get a summary of all registered metrics.
   */
  summary(): { counters: number; gauges: number; histograms: number; total_observations: number } {
    let totalObs = 0
    for (const values of this.histograms.values()) {
      totalObs += values.length
    }
    return {
      counters: this.counters.size,
      gauges: this.gauges.size,
      histograms: this.histograms.size,
      total_observations: totalObs,
    }
  }

  /**
   * Reset all metrics.
   */
  reset(): void {
    this.counters.clear()
    this.gauges.clear()
    this.histograms.clear()
  }

  // ── Internal ──────────────────────────────────────────────────────

  private makeKey(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length === 0) return name
    const labelStr = entries.map(([k, v]) => `${k}="${v}"`).join(',')
    return `${name}{${labelStr}}`
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)]
  }

  private computeBuckets(sorted: number[]): HistogramBucket[] {
    if (sorted.length === 0) return []
    const max = sorted[sorted.length - 1]
    const bucketBounds = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000].filter(b => b <= max * 1.5)
    return bucketBounds.map(le => ({
      le,
      count: sorted.filter(v => v <= le).length,
    }))
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: MetricsCollector | null = null

export function getMetrics(): MetricsCollector {
  if (!instance) {
    instance = new MetricsCollector()
  }
  return instance
}
