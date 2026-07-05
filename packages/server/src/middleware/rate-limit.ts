import type { Context, Next } from 'hono'

interface RateLimitConfig {
  windowMs: number
  maxRequests: number
}

const defaultConfig: RateLimitConfig = {
  windowMs: 60_000, // 1 minute
  maxRequests: 60,
}

export function rateLimit(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests } = { ...defaultConfig, ...config }
  const requests = new Map<string, { count: number; resetAt: number }>()

  // Cleanup stale entries periodically
  setInterval(() => {
    const now = Date.now()
    for (const [key, val] of requests) {
      if (now > val.resetAt) requests.delete(key)
    }
  }, windowMs * 2).unref()

  return async (c: Context, next: Next) => {
    // B-03 fix: Use socket remoteAddress (can't be spoofed via headers).
    // Fallback to x-real-ip only if explicitly trusted via TRUST_PROXY env.
    const trustProxy = process.env.TRUST_PROXY === 'true'
    const key = trustProxy
      ? (c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'unknown')
      : ((c.env?.incoming as any)?.remoteAddress ?? c.req.header('x-real-ip') ?? 'unknown')
    const now = Date.now()
    let entry = requests.get(key)
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      requests.set(key, entry)
    }
    entry.count++
    if (entry.count > maxRequests) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      return c.json({ error: 'Rate limit exceeded' }, 429)
    }
    c.header('X-RateLimit-Remaining', String(maxRequests - entry.count))
    await next()
  }
}
