import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createAuthRoutes, verifyToken, generateSessionToken } from '../resource-auth'

describe('Resource Auth', () => {
  it('generates 32-byte hex token', () => {
    const token = generateSessionToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('verifies token with timingSafeEqual', () => {
    const token = 'a'.repeat(64)
    expect(verifyToken(token, token)).toBe(true)
    expect(verifyToken(token, 'b'.repeat(64))).toBe(false)
    expect(verifyToken(token, 'short')).toBe(false)
  })

  it('POST /auth/token sets httpOnly cookie on success', async () => {
    const storedToken = 'c'.repeat(64)
    const app = new Hono()
    const routes = createAuthRoutes(storedToken)
    app.route('/api/auth', routes)

    const res = await app.request('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: storedToken }),
    })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
  })

  it('POST /auth/token rejects invalid token', async () => {
    const storedToken = 'd'.repeat(64)
    const app = new Hono()
    const routes = createAuthRoutes(storedToken)
    app.route('/api/auth', routes)

    const res = await app.request('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('GET /auth/status returns auth state', async () => {
    const app = new Hono()
    const routes = createAuthRoutes('e'.repeat(64))
    app.route('/api/auth', routes)

    const res = await app.request('/api/auth/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('authenticated')
  })
})
