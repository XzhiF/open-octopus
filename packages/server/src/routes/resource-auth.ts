import { Hono } from 'hono'
import { randomBytes, timingSafeEqual } from 'crypto'

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

export function createAuthRoutes(storedToken: string): Hono {
  const app = new Hono()

  // POST /token — Exchange token for httpOnly cookie
  app.post('/token', async (c) => {
    const body = await c.req.json<{ token: string }>()
    if (!body.token || !verifyToken(body.token, storedToken)) {
      return c.json({ error: 'Invalid token' }, 401)
    }
    c.header('Set-Cookie', `octopus_session=${body.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`)
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
