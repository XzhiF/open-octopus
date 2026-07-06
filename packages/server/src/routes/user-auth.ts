import { Hono } from 'hono'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { getDb } from '../db/connection'
import { rateLimit } from '../middleware/rate-limit'

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  const hashBuffer = Buffer.from(hash, 'hex')
  const derivedBuffer = scryptSync(password, salt, 64)
  try {
    return timingSafeEqual(hashBuffer, derivedBuffer)
  } catch {
    return false
  }
}

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  const match = cookieHeader.split(';').find(s => s.trim().startsWith(`${name}=`))
  return match?.split('=')[1]
}

/** Build a JSON response with multiple Set-Cookie headers */
function jsonWithCookies(
  data: unknown,
  status: number,
  cookies: string[],
): Response {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  for (const cookie of cookies) {
    headers.append('Set-Cookie', cookie)
  }
  return new Response(JSON.stringify(data), { status, headers })
}

function sessionCookie(token: string, isProd: boolean): string {
  const parts = [`user_session=${token}`, 'Path=/', 'Max-Age=86400', 'HttpOnly', 'SameSite=Lax']
  if (isProd) parts.push('Secure')
  return parts.join('; ')
}

function userCookie(username: string): string {
  return `octopus_user=${username}; Path=/; Max-Age=86400`
}

function clearCookie(name: string, httpOnly = false): string {
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0']
  if (httpOnly) parts.push('HttpOnly', 'SameSite=Lax')
  return parts.join('; ')
}

export function createUserAuthRoutes(): Hono {
  const app = new Hono()
  const authLimit = rateLimit({ windowMs: 60_000, maxRequests: 5 })
  const isProd = process.env.NODE_ENV === 'production'

  app.post('/register', authLimit, async (c) => {
    try {
      const { username, password, email } = await c.req.json()

      if (!username || !password) {
        return c.json({ error: '用户名和密码为必填项' }, 400)
      }
      if (username.length < 3) {
        return c.json({ error: '用户名至少3个字符' }, 400)
      }
      if (password.length < 6) {
        return c.json({ error: '密码至少6个字符' }, 400)
      }

      const db = getDb()
      const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any

      let id: string
      if (existing) {
        // Idempotent: if user exists and password matches, just login
        if (!verifyPassword(password, existing.password_hash)) {
          return c.json({ error: '用户名已存在' }, 409)
        }
        id = existing.id
      } else {
        id = randomBytes(16).toString('hex')
        const passwordHash = hashPassword(password)
        db.prepare('INSERT INTO users (id, username, password_hash, email) VALUES (?, ?, ?, ?)')
          .run(id, username, passwordHash, email ?? null)
      }

      const token = generateToken()
      const sessionId = randomBytes(16).toString('hex')
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      db.prepare('INSERT INTO user_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, id, token, expiresAt)

      return jsonWithCookies(
        { user: { id, username, email: email ?? null } },
        201,
        [sessionCookie(token, isProd), userCookie(username)],
      )
    } catch (err) {
      console.error('Register error:', err)
      return c.json({ error: '注册失败' }, 500)
    }
  })

  app.post('/login', authLimit, async (c) => {
    try {
      const { username, password } = await c.req.json()

      if (!username || !password) {
        return c.json({ error: '用户名或密码错误' }, 401)
      }

      const db = getDb()
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any
      if (!user || !verifyPassword(password, user.password_hash)) {
        return c.json({ error: '用户名或密码错误' }, 401)
      }

      const token = generateToken()
      const sessionId = randomBytes(16).toString('hex')
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      db.prepare('INSERT INTO user_sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
        .run(sessionId, user.id, token, expiresAt)

      return jsonWithCookies(
        { user: { id: user.id, username: user.username, email: user.email } },
        200,
        [sessionCookie(token, isProd), userCookie(user.username)],
      )
    } catch (err) {
      console.error('Login error:', err)
      return c.json({ error: '登录失败' }, 500)
    }
  })

  app.post('/logout', (c) => {
    const cookieHeader = c.req.header('cookie')
    const token = parseCookie(cookieHeader, 'user_session')
    if (token) {
      try {
        const db = getDb()
        db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token)
      } catch { /* ignore */ }
    }
    return jsonWithCookies(
      { success: true },
      200,
      [clearCookie('user_session', true), clearCookie('octopus_user')],
    )
  })

  app.get('/me', (c) => {
    const cookieHeader = c.req.header('cookie')
    const token = parseCookie(cookieHeader, 'user_session')
    if (!token) {
      return c.json({ authenticated: false }, 401)
    }

    try {
      const db = getDb()
      const session = db.prepare(
        "SELECT us.user_id, u.username, u.email FROM user_sessions us JOIN users u ON us.user_id = u.id WHERE us.token = ? AND us.expires_at > datetime('now')"
      ).get(token) as any

      if (!session) {
        return c.json({ authenticated: false }, 401)
      }

      return c.json({ authenticated: true, user: { id: session.user_id, username: session.username, email: session.email } })
    } catch {
      return c.json({ authenticated: false }, 401)
    }
  })

  return app
}
