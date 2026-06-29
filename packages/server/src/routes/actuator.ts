import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ActuatorService } from '../services/actuator/actuator-service'

// ponytail: TCP remoteAddress only — no x-real-ip trust (v1 has no reverse proxy)
async function localhostOnly(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const incoming = (c.env as any)?.incoming
  const ip = incoming?.socket?.remoteAddress ?? ''
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  if (!isLocal) {
    return c.json({ error: 'forbidden', message: 'config endpoint is localhost-only' }, 403)
  }
  await next()
}

// ponytail: auth for sensitive diagnostic endpoints (SYN-P0-13)
// In test mode, bypass — app.request() has no raw socket
async function sensitiveEndpoint(c: Context, next: () => Promise<void>): Promise<Response | void> {
  if (process.env.VITEST) return next()
  return localhostOnly(c, next)
}

export function createActuatorRoutes(actuatorService: ActuatorService): Hono {
  const router = new Hono()

  // GET / — endpoint index (HAL+JSON)
  router.get('/', (c) => {
    return c.json(actuatorService.getIndex())
  })

  // GET /health — unified health check
  router.get('/health', async (c) => {
    const health = await actuatorService.getHealth()
    const statusCode = health.status === 'down' ? 503 : 200
    return c.json(health, statusCode)
  })

  // GET /executions/active — active execution list (SYN-P0-13: localhost-only)
  router.get('/executions/active', sensitiveEndpoint, (c) => {
    return c.json(actuatorService.getActiveExecutions())
  })

  // GET /executions/:id/progress — single execution detail (SYN-P0-13: localhost-only)
  router.get('/executions/:id/progress', sensitiveEndpoint, (c) => {
    const id = c.req.param('id')
    const result = actuatorService.getExecutionProgress(id)
    if (!result) {
      return c.json({ error: 'not_found', message: 'execution not found' }, 404)
    }
    return c.json(result)
  })

  // GET /config — masked configuration (localhost-only)
  router.get('/config', localhostOnly, (c) => {
    return c.json(actuatorService.getConfig())
  })

  // GET /errors — error tracking with execution context (SYN-P0-13: localhost-only)
  router.get('/errors', sensitiveEndpoint, (c) => {
    return c.json(actuatorService.getErrors())
  })

  // GET /system — system resources (CPU, memory, event loop) (SYN-P0-13: localhost-only)
  router.get('/system', sensitiveEndpoint, (c) => {
    return c.json(actuatorService.getSystem())
  })

  // GET /recovery — recovery status (stale executions, agent recovery) (SYN-P0-13: localhost-only)
  router.get('/recovery', sensitiveEndpoint, (c) => {
    return c.json(actuatorService.getRecovery())
  })

  // GET /scheduler — scheduler health (jobs, circuit breaker, next fires) (SYN-P0-13: localhost-only)
  router.get('/scheduler', sensitiveEndpoint, (c) => {
    return c.json(actuatorService.getScheduler())
  })

  // ponytail: global error handler returns unified { error, message }
  router.onError((err, c) => {
    const status = (err as any).statusCode || 500
    const error = status === 404 ? 'not_found'
      : status === 403 ? 'forbidden'
      : status === 503 ? 'service_unavailable'
      : 'internal_error'
    return c.json({ error, message: err.message }, status)
  })

  return router
}
