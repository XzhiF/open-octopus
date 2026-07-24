/**
 * E2E Agent Journey Tests
 * Tests critical user flows end-to-end through the agent API.
 * Maps to PRD P5.11: E2E agent-specific tests.
 *
 * These tests verify the full API flow:
 * 1. Domain event bus (emit → receive → history)
 * 2. Tracer (spans → traces → stats)
 * 3. Metrics (counters → gauges → histograms)
 * 4. Combined observability flow
 */
import { describe, it, expect } from 'vitest'
import { getDomainEventBus } from '../services/agent/domain-event-bus'
import { getTracer } from '../services/agent/tracer'
import { getMetrics } from '../services/agent/metrics'

// ── Journey 1: Domain Event Bus ──────────────────────────────────────

describe('Agent Journey: Domain Event Bus', () => {
  it('emits and receives events', async () => {
    const bus = getDomainEventBus()
    const received: Array<{ type: string; data: unknown }> = []

    const unsubscribe = bus.on('session.created', (event) => {
      received.push({ type: event.type, data: event.data })
    })

    await bus.emit('session.created', { session_id: 'test-123' }, { source: 'test' })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('session.created')
    expect((received[0].data as { session_id: string }).session_id).toBe('test-123')

    unsubscribe()
  })

  it('supports multiple handlers for same event', async () => {
    const bus = getDomainEventBus()
    let count = 0

    const unsub1 = bus.on('task.started', () => { count++ })
    const unsub2 = bus.on('task.started', () => { count++ })

    await bus.emit('task.started', { task_id: 'test' }, { source: 'test' })

    expect(count).toBe(2)

    unsub1()
    unsub2()
  })

  it('isolates handler errors from other handlers', async () => {
    const bus = getDomainEventBus()
    let successHandlerCalled = false

    const unsub1 = bus.on('task.completed', () => {
      throw new Error('handler error')
    })
    const unsub2 = bus.on('task.completed', () => {
      successHandlerCalled = true
    })

    await bus.emit('task.completed', { task_id: 'test' }, { source: 'test' })

    expect(successHandlerCalled).toBe(true)

    unsub1()
    unsub2()
  })

  it('maintains event history ring buffer', async () => {
    const bus = getDomainEventBus()

    await bus.emit('memory.archived', { date: '2024-01-01' }, { source: 'test' })
    await bus.emit('memory.archived', { date: '2024-01-02' }, { source: 'test' })

    const history = bus.getHistory({ type: 'memory.archived', limit: 10 })
    expect(history.length).toBeGreaterThanOrEqual(2)

    // Filter by type
    const filtered = bus.getHistory({ type: 'memory.archived' })
    expect(filtered.every(e => e.type === 'memory.archived')).toBe(true)
  })

  it('tracks handler counts', () => {
    const bus = getDomainEventBus()
    const unsub = bus.on('clone.created', () => {})

    const counts = bus.handlerCounts()
    expect(counts['clone.created']).toBeGreaterThanOrEqual(1)

    unsub()
  })
})

// ── Journey 2: Tracer ───────────────────────────────────────────────

describe('Agent Journey: Tracer', () => {
  it('creates and finishes spans', () => {
    const tracer = getTracer()
    const span = tracer.startSpan('test-operation', 'agent')

    span.setTag('key', 'value')
    span.addEvent('checkpoint', { detail: 'test' })
    span.finish()

    expect(span.end_time).toBeDefined()
    expect(span.duration_ms).toBeGreaterThanOrEqual(0)
    expect(span.status).toBe('ok')
  })

  it('creates child spans', () => {
    const tracer = getTracer()
    const parent = tracer.startSpan('parent-op', 'agent')
    const child = parent.startChild('child-op', 'agent')

    child.finish()
    parent.finish()

    expect(child.parent_id).toBe(parent.id)
    expect(child.trace_id).toBe(parent.trace_id)
  })

  it('records errors on spans', () => {
    const tracer = getTracer()
    const span = tracer.startSpan('failing-op', 'agent')

    span.setError(new Error('test error'))
    span.finish()

    expect(span.status).toBe('error')
    expect(span.tags['error.message']).toBe('test error')
  })

  it('executes async operations within spans', async () => {
    const tracer = getTracer()

    const result = await tracer.withSpan('async-op', async (span) => {
      span.setTag('operation', 'test')
      return 42
    })

    expect(result).toBe(42)
  })

  it('returns trace summaries', () => {
    const tracer = getTracer()
    const summaries = tracer.getTraceSummaries(5)

    expect(Array.isArray(summaries)).toBe(true)
    expect(summaries.length).toBeGreaterThan(0)
  })

  it('returns tracer stats', () => {
    const tracer = getTracer()
    const stats = tracer.getStats()

    expect(stats.total_spans).toBeGreaterThan(0)
    expect(stats.total_traces).toBeGreaterThan(0)
    expect(typeof stats.active_spans).toBe('number')
  })
})

// ── Journey 3: Metrics ──────────────────────────────────────────────

describe('Agent Journey: Metrics', () => {
  it('increments counters', () => {
    const metrics = getMetrics()
    metrics.increment('test_requests_total', 1, { method: 'GET' })
    metrics.increment('test_requests_total', 1, { method: 'GET' })

    expect(metrics.getCounter('test_requests_total', { method: 'GET' })).toBe(2)
  })

  it('sets gauge values', () => {
    const metrics = getMetrics()
    metrics.setGauge('test_active_sessions', 5)

    expect(metrics.getGauge('test_active_sessions')).toBe(5)

    metrics.setGauge('test_active_sessions', 3)
    expect(metrics.getGauge('test_active_sessions')).toBe(3)
  })

  it('records histogram observations', () => {
    const metrics = getMetrics()
    metrics.observe('test_response_time', 50)
    metrics.observe('test_response_time', 100)
    metrics.observe('test_response_time', 200)
    metrics.observe('test_response_time', 500)

    const hist = metrics.getHistogram('test_response_time')
    expect(hist).not.toBeNull()
    expect(hist!.count).toBeGreaterThanOrEqual(4)
    expect(hist!.min).toBeLessThanOrEqual(50)
    expect(hist!.max).toBeGreaterThanOrEqual(500)
    expect(hist!.p50).toBeGreaterThan(0)
    expect(hist!.p95).toBeGreaterThan(0)
  })

  it('times async operations', async () => {
    const metrics = getMetrics()

    const result = await metrics.time('test_async_op', async () => {
      return 'done'
    })

    expect(result).toBe('done')
    expect(metrics.getCounter('test_async_op_total', { status: 'success' })).toBeGreaterThan(0)
  })

  it('exports all metrics', () => {
    const metrics = getMetrics()
    const exported = metrics.export()

    expect(Array.isArray(exported)).toBe(true)
    expect(exported.length).toBeGreaterThan(0)
  })

  it('returns metric summary', () => {
    const metrics = getMetrics()
    const summary = metrics.summary()

    expect(summary.counters).toBeGreaterThan(0)
    expect(typeof summary.gauges).toBe('number')
    expect(typeof summary.histograms).toBe('number')
    expect(typeof summary.total_observations).toBe('number')
  })
})

// ── Journey 4: Combined Observability Flow ───────────────────────────

describe('Agent Journey: Combined Observability', () => {
  it('event + span + metric integration', async () => {
    const bus = getDomainEventBus()
    const tracer = getTracer()
    const metrics = getMetrics()

    const received: string[] = []
    const unsub = bus.on('agent.action_completed', () => {
      received.push('action_completed')
    })

    // Simulate an agent action with observability
    await tracer.withSpan('agent-action', async (span) => {
      span.setTag('action', 'test')
      metrics.increment('agent_actions_total')

      await bus.emit('agent.action_completed', {
        action: 'test',
        result: 'success',
      }, { source: 'agent' })

      span.addEvent('action_completed')
      metrics.observe('agent_action_duration', 100)
    })

    expect(received).toContain('action_completed')
    expect(metrics.getCounter('agent_actions_total')).toBeGreaterThan(0)

    unsub()
  })
})
