import { Hono } from 'hono'
import { randomBytes, timingSafeEqual } from 'crypto'
import type { Context, Next } from 'hono'
import { rateLimit } from '../middleware/rate-limit'

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

export function verifyToken(provided: string, stored: string): boolean {
  if (provided.length !== stored.length) return false
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(stored))
  } catch {
    return false
  }
}

/**
 * B-02 fix: Auth middleware — validates session cookie on resource routes.
 * Applied via `app.use('*', requireAuth(storedToken))` in resource routes.
 */
export function requireAuth(storedToken: string) {
  return async (c: Context, next: Next) => {
    const cookie = c.req.header('cookie') ?? ''
    const session = cookie.split(';').find(s => s.trim().startsWith('octopus_session='))
    const token = session?.split('=')[1]
    if (!token || !verifyToken(token, storedToken)) {
      return c.json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401)
    }
    await next()
  }
}

export function createAuthRoutes(storedToken: string): Hono {
  const app = new Hono()

  // B-05 fix: Strict rate limit on auth endpoints (5 attempts per minute)
  const authLimit = rateLimit({ windowMs: 60_000, maxRequests: 5 })

  // B-04 fix: Add Secure flag to cookie (only sent over HTTPS)
  const isProd = process.env.NODE_ENV === 'production'
  const secureFlag = isProd ? ' Secure;' : ''

  // POST /token — Exchange token for httpOnly cookie
  app.post('/token', authLimit, async (c) => {
    const body = await c.req.json<{ token: string }>()
    if (!body.token || !verifyToken(body.token, storedToken)) {
      return c.json({ error: 'Invalid token' }, 401)
    }
    c.header('Set-Cookie', `octopus_session=${body.token};${secureFlag} HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`)
    return c.json({ authenticated: true })
  })

  // GET /status — Check auth state
  app.get('/status', (c) => {
    const cookie = c.req.header('cookie') ?? ''
    const session = cookie.split(';').find(s => s.trim().startsWith('octopus_session='))
    const token = session?.split('=')[1]
    const authenticated = token ? verifyToken(token, storedToken) : false
    return c.json({ authenticated })
  })

  return app
}
