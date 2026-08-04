// packages/server/src/routes/agent/version-routes.ts
//
// Agent version management API routes.
// Mounts version sub-routes under clone and main agent paths.
//
// Clone versions:
//   GET    /api/clones/:name/versions           — list versions
//   GET    /api/clones/:name/versions/diff       — compare two versions
//   GET    /api/clones/:name/versions/:version   — get version detail
//   POST   /api/clones/:name/versions           — publish new version
//   PATCH  /api/clones/:name/versions/:version  — update status (archive)
//   POST   /api/clones/:name/versions/:version/rollback — rollback to version
//
// Main Agent versions:
//   Same routes at /api/agents/main/versions (agent_name='__main__')
//
import { Hono } from 'hono'
import { getAgentVersionService } from '../../services/agent/agent-version-service'

// ── Route factory ──────────────────────────────────────────────────

export function createVersionRoutes(): Hono {
  const app = new Hono()

  // ── List versions ────────────────────────────────────────────────
  app.get('/:name/versions', (c) => {
    const name = c.req.param('name')
    const status = c.req.query('status')
    const stage = c.req.query('stage')
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined

    try {
      const service = getAgentVersionService()
      const result = service.list(name, { status, stage, limit })
      return c.json(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, 500)
    }
  })

  // ── Diff versions ────────────────────────────────────────────────
  app.get('/:name/versions/diff', (c) => {
    const name = c.req.param('name')
    const from = c.req.query('from')
    const to = c.req.query('to')

    if (!from || !to) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'from and to query params are required' } }, 400)
    }

    try {
      const service = getAgentVersionService()
      const diff = service.diff(name, from, to)
      return c.json(diff)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404 : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  // ── Get version detail ───────────────────────────────────────────
  app.get('/:name/versions/:version', (c) => {
    const name = c.req.param('name')
    const version = c.req.param('version')

    try {
      const service = getAgentVersionService()
      const row = service.get(name, version)
      if (!row) {
        return c.json({ error: { code: 'NOT_FOUND', message: `Version "${version}" not found` } }, 404)
      }
      return c.json({ version: row })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, 500)
    }
  })

  // ── Publish new version ──────────────────────────────────────────
  app.post('/:name/versions', async (c) => {
    const name = c.req.param('name')

    try {
      const body = await c.req.json<{
        version: string
        stage?: 'alpha' | 'beta' | 'rc' | 'stable'
        changelog?: string
      }>()

      if (!body.version) {
        return c.json({ error: { code: 'INVALID_PARAM', message: 'version is required' } }, 400)
      }

      const service = getAgentVersionService()
      const row = service.publish(name, {
        version: body.version,
        stage: body.stage,
        changelog: body.changelog,
      })
      return c.json({ version: row }, 201)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('already exists') ? 409
        : msg.includes('not found') ? 404
        : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  // ── Update version status (archive) ──────────────────────────────
  app.patch('/:name/versions/:version', async (c) => {
    const name = c.req.param('name')
    const version = c.req.param('version')

    try {
      const body = await c.req.json<{ status?: string }>()

      if (body.status === 'archived') {
        const service = getAgentVersionService()
        const row = service.archive(name, version)
        return c.json({ version: row })
      }

      return c.json({ error: { code: 'INVALID_PARAM', message: 'Only status="archived" is supported' } }, 400)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404
        : msg.includes('already') ? 409
        : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  // ── Rollback to version ──────────────────────────────────────────
  app.post('/:name/versions/:version/rollback', (c) => {
    const name = c.req.param('name')
    const version = c.req.param('version')

    try {
      const service = getAgentVersionService()
      const result = service.rollback(name, version)
      return c.json(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404
        : msg.includes('Cannot rollback') ? 400
        : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  return app
}

/**
 * Create Main Agent version routes.
 * Maps to agent_name='__main__'.
 */
export function createMainAgentVersionRoutes(): Hono {
  const app = new Hono()
  const MAIN_AGENT = '__main__'

  // ── List versions ────────────────────────────────────────────────
  app.get('/versions', (c) => {
    const status = c.req.query('status')
    const stage = c.req.query('stage')
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined

    try {
      const service = getAgentVersionService()
      const result = service.list(MAIN_AGENT, { status, stage, limit })
      return c.json(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, 500)
    }
  })

  // ── Diff versions ────────────────────────────────────────────────
  app.get('/versions/diff', (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')

    if (!from || !to) {
      return c.json({ error: { code: 'INVALID_PARAM', message: 'from and to query params are required' } }, 400)
    }

    try {
      const service = getAgentVersionService()
      const diff = service.diff(MAIN_AGENT, from, to)
      return c.json(diff)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404 : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  // ── Get version detail ───────────────────────────────────────────
  app.get('/versions/:version', (c) => {
    const version = c.req.param('version')

    try {
      const service = getAgentVersionService()
      const row = service.get(MAIN_AGENT, version)
      if (!row) {
        return c.json({ error: { code: 'NOT_FOUND', message: `Version "${version}" not found` } }, 404)
      }
      return c.json({ version: row })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, 500)
    }
  })

  // ── Publish new version ──────────────────────────────────────────
  app.post('/versions', async (c) => {
    try {
      const body = await c.req.json<{
        version: string
        stage?: 'alpha' | 'beta' | 'rc' | 'stable'
        changelog?: string
      }>()

      if (!body.version) {
        return c.json({ error: { code: 'INVALID_PARAM', message: 'version is required' } }, 400)
      }

      const service = getAgentVersionService()
      const row = service.publish(MAIN_AGENT, {
        version: body.version,
        stage: body.stage,
        changelog: body.changelog,
      })
      return c.json({ version: row }, 201)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('already exists') ? 409
        : msg.includes('not found') ? 404
        : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  // ── Update version status (archive) ──────────────────────────────
  app.patch('/versions/:version', async (c) => {
    const version = c.req.param('version')

    try {
      const body = await c.req.json<{ status?: string }>()

      if (body.status === 'archived') {
        const service = getAgentVersionService()
        const row = service.archive(MAIN_AGENT, version)
        return c.json({ version: row })
      }

      return c.json({ error: { code: 'INVALID_PARAM', message: 'Only status="archived" is supported' } }, 400)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404
        : msg.includes('already') ? 409
        : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  // ── Rollback to version ──────────────────────────────────────────
  app.post('/versions/:version/rollback', (c) => {
    const version = c.req.param('version')

    try {
      const service = getAgentVersionService()
      const result = service.rollback(MAIN_AGENT, version)
      return c.json(result)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const status = msg.includes('not found') ? 404
        : msg.includes('Cannot rollback') ? 400
        : 500
      return c.json({ error: { code: 'VERSION_ERROR', message: msg } }, status)
    }
  })

  return app
}
