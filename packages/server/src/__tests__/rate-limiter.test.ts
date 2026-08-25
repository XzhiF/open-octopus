import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createRateLimiter } from '../routes/scheduler'

// Regression: /tasks kanban polls GET /jobs every 10s. The rate limiter's
// refill was Math.floor(elapsed / interval) * maxTokens — integer-step refill
// that only fires after a FULL interval elapses. A 10s poll never lets 60s
// elapse between requests, so refill was permanently 0, tokens drained 60→0
// over 10 minutes, then every request 429'd forever. Real token buckets
// refill fractionally per elapsed time.

describe('createRateLimiter refill', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('steady sub-interval polling (10s vs 60s refill) does not exhaust → no permanent 429', async () => {
    const limiter = createRateLimiter(60, 60_000)
    const app = new Hono()
    app.get('/jobs', limiter, (c) => c.json({ ok: 1 }))

    let limited = 0
    // 12 minutes of 10s polling = 72 requests
    for (let i = 0; i < 72; i++) {
      vi.setSystemTime(Date.now() + 10_000)
      const res = await app.request('/jobs')
      if (res.status === 429) limited++
    }
    expect(limited).toBe(0)
  })

  it('still blocks a genuine burst (60 rapid hits then one more → 429)', async () => {
    const limiter = createRateLimiter(3, 60_000)
    const app = new Hono()
    app.get('/jobs', limiter, (c) => c.json({ ok: 1 }))

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await app.request('/jobs')
      statuses.push(res.status)
    }
    // 3 tokens → first 3 pass, 4th & 5th limited (no time elapsed to refill)
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses.slice(3)).toEqual([429, 429])
  })

  it('refills fractionally after partial interval (1 token over 20s @ 60/min)', async () => {
    const limiter = createRateLimiter(1, 60_000)
    const app = new Hono()
    app.get('/jobs', limiter, (c) => c.json({ ok: 1 }))

    expect((await app.request('/jobs')).status).toBe(200) // token 1→0
    expect((await app.request('/jobs')).status).toBe(429) // empty
    vi.setSystemTime(Date.now() + 20_000) // 20s = 1/3 interval → 1/3 token (not full)
    // 20s @ 60/min refills 60*20/60 = 20 tokens, capped to 1 → back to 1
    expect((await app.request('/jobs')).status).toBe(200)
  })
})
