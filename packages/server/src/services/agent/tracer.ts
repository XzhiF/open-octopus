// ── Tracer ──────────────────────────────────────────────────────────
// Lightweight tracing infrastructure for the agent system.
// Maps to PRD P3.5: Tracer + Metrics observability.

export interface Span {
  id: string
  trace_id: string
  parent_id?: string
  name: string
  service: string
  start_time: number
  end_time?: number
  duration_ms?: number
  status: 'ok' | 'error'
  tags: Record<string, string | number | boolean>
  events: SpanEvent[]
}

export interface SpanEvent {
  name: string
  timestamp: number
  attributes: Record<string, string>
}

export interface TraceSummary {
  trace_id: string
  root_span: string
  span_count: number
  total_duration_ms: number
  services: string[]
  started_at: string
}

// ── SpanImpl ────────────────────────────────────────────────────────

let spanIdCounter = 0

function nextSpanId(): string {
  spanIdCounter += 1
  return `span-${Date.now().toString(36)}-${spanIdCounter.toString(36)}`
}

function generateTraceId(): string {
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class SpanImpl implements Span {
  id: string
  trace_id: string
  parent_id?: string
  name: string
  service: string
  start_time: number
  end_time?: number
  duration_ms?: number
  status: 'ok' | 'error' = 'ok'
  tags: Record<string, string | number | boolean> = {}
  events: SpanEvent[] = []
  private children: SpanImpl[] = []
  private tracer: Tracer

  constructor(tracer: Tracer, name: string, service: string, parentId?: string, traceId?: string) {
    this.tracer = tracer
    this.id = nextSpanId()
    this.trace_id = traceId ?? generateTraceId()
    this.parent_id = parentId
    this.name = name
    this.service = service
    this.start_time = Date.now()
  }

  setTag(key: string, value: string | number | boolean): SpanImpl {
    this.tags[key] = value
    return this
  }

  addEvent(name: string, attributes: Record<string, string> = {}): SpanImpl {
    this.events.push({ name, timestamp: Date.now(), attributes })
    return this
  }

  setError(error: Error | string): SpanImpl {
    this.status = 'error'
    const msg = error instanceof Error ? error.message : error
    this.setTag('error.message', msg)
    if (error instanceof Error && error.stack) {
      this.setTag('error.stack', error.stack.slice(0, 500))
    }
    return this
  }

  startChild(name: string, service?: string): SpanImpl {
    const child = new SpanImpl(this.tracer, name, service ?? this.service, this.id, this.trace_id)
    this.children.push(child)
    this.tracer.registerSpan(child)
    return child
  }

  finish(): void {
    this.end_time = Date.now()
    this.duration_ms = this.end_time - this.start_time
    this.tracer.finishSpan(this)
  }
}

// ── Tracer ──────────────────────────────────────────────────────────

/**
 * Lightweight tracer for structured span collection.
 * Not a full OpenTelemetry implementation — provides basic span trees
 * for debugging and performance analysis of agent operations.
 */
export class Tracer {
  private spans: Map<string, SpanImpl> = new Map()
  private traces: Map<string, SpanImpl[]> = new Map()
  private maxSpans: number

  constructor(maxSpans = 5000) {
    this.maxSpans = maxSpans
  }

  /**
   * Start a new root span.
   */
  startSpan(name: string, service = 'agent'): SpanImpl {
    const span = new SpanImpl(this, name, service)
    this.registerSpan(span)
    return span
  }

  /**
   * Execute a function within a span, auto-finishing on completion.
   */
  async withSpan<T>(name: string, fn: (span: SpanImpl) => Promise<T>, service = 'agent'): Promise<T> {
    const span = this.startSpan(name, service)
    try {
      const result = await fn(span)
      span.finish()
      return result
    } catch (err) {
      span.setError(err instanceof Error ? err : new Error(String(err)))
      span.finish()
      throw err
    }
  }

  registerSpan(span: SpanImpl): void {
    if (this.spans.size >= this.maxSpans) {
      // Evict oldest trace
      const oldestTraceId = this.traces.keys().next().value
      if (oldestTraceId) {
        const oldestSpans = this.traces.get(oldestTraceId) ?? []
        for (const s of oldestSpans) {
          this.spans.delete(s.id)
        }
        this.traces.delete(oldestTraceId)
      }
    }

    this.spans.set(span.id, span)
    const traceSpans = this.traces.get(span.trace_id) ?? []
    traceSpans.push(span)
    this.traces.set(span.trace_id, traceSpans)
  }

  finishSpan(_span: SpanImpl): void {
    // Span data is already updated in-place via SpanImpl.finish()
  }

  /**
   * Get a trace by ID.
   */
  getTrace(traceId: string): SpanImpl[] {
    return this.traces.get(traceId) ?? []
  }

  /**
   * Get recent trace summaries.
   */
  getTraceSummaries(limit = 20): TraceSummary[] {
    const summaries: TraceSummary[] = []
    for (const [traceId, spans] of this.traces) {
      if (summaries.length >= limit) break
      const rootSpan = spans.find(s => !s.parent_id)
      const completedSpans = spans.filter(s => s.end_time !== undefined)
      const totalDuration = rootSpan?.duration_ms ?? 0

      summaries.push({
        trace_id: traceId,
        root_span: rootSpan?.name ?? 'unknown',
        span_count: spans.length,
        total_duration_ms: totalDuration,
        services: [...new Set(spans.map(s => s.service))],
        started_at: new Date(rootSpan?.start_time ?? Date.now()).toISOString(),
      })

      // Only include traces where all spans are finished
      if (completedSpans.length < spans.length) continue
    }
    return summaries
  }

  /**
   * Get span count statistics.
   */
  getStats(): { total_spans: number; total_traces: number; active_spans: number } {
    let activeSpans = 0
    for (const span of this.spans.values()) {
      if (span.end_time === undefined) activeSpans++
    }
    return {
      total_spans: this.spans.size,
      total_traces: this.traces.size,
      active_spans: activeSpans,
    }
  }

  /**
   * Clear all span data.
   */
  reset(): void {
    this.spans.clear()
    this.traces.clear()
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let instance: Tracer | null = null

export function getTracer(): Tracer {
  if (!instance) {
    instance = new Tracer()
  }
  return instance
}
