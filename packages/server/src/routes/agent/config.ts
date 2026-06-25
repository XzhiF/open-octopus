import { Hono } from 'hono'
import { getConfigManager } from '../../services/agent/config-manager'
import { createAgentError, mapErrorToStatus } from './middleware'

export function createConfigRoutes(): Hono {
  const config = new Hono()

  /**
   * GET /config — Read agent config
   */
  config.get('/config', (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const manager = getConfigManager()
      const result = manager.loadConfig(org)
      return c.json({
        config: result.config,
        degraded: result.degraded,
        warnings: result.warnings,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  /**
   * PUT /config — Update agent config
   */
  config.put('/config', async (c) => {
    try {
      const org = c.req.header('X-Octopus-Org') || (c.get('org') as string)
      if (!org) {
        return c.json(createAgentError('ORG_NOT_FOUND', 'Organization not resolved'), 403)
      }

      const body = await c.req.json<Record<string, unknown>>()
      if (!body || typeof body !== 'object') {
        return c.json(
          createAgentError('INVALID_PARAM', 'Request body must be a JSON object'),
          400,
        )
      }

      const manager = getConfigManager()
      const result = manager.updateConfig(org, body as Record<string, unknown>)
      return c.json({
        ok: true,
        config: result.config,
        degraded: result.degraded,
        warnings: result.warnings,
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      const message = error.message
      if (message.startsWith('Invalid config update')) {
        return c.json(createAgentError('INVALID_PARAM', message), 400)
      }
      const code = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
      return c.json(createAgentError(code, error.message), mapErrorToStatus(code))
    }
  })

  return config
}
