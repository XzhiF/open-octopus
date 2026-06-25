import { Hono } from 'hono'
import { SafetyDAO } from '../../db/dao'
import { createAgentError, mapErrorToStatus } from './middleware'

export function createSafetyRoutes(safetyDAO: SafetyDAO): Hono {
  const safety = new Hono()

  /**
   * GET /safety/events — List safety events
   */
  safety.get('/safety/events', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200)

      const events = safetyDAO.findSafetyEventsWithFilters(org, { limit })

      return c.json({
        items: events.map((e) => ({
          ...e,
          context: e.context ? JSON.parse(e.context) : null,
        })),
        total: events.length,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return safety
}
