import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ResourceError } from '@octopus/shared'
import type { ResourceManifest } from '@octopus/shared'
import { ResourceService } from '../services/resource-service'
import { InstallEventBus } from '../services/install-event-bus'
import { rateLimit } from '../middleware/rate-limit'

/**
 * Map ResourceError to HTTP response; unknown errors become 500.
 */
function handleError(c: any, err: unknown) {
  if (err instanceof ResourceError) {
    return c.json(
      { error: err.message, code: err.code, suggestion: err.suggestion },
      err.status,
    )
  }
  const message = err instanceof Error ? err.message : 'Internal Server Error'
  return c.json({ error: message }, 500)
}

// Stricter rate limit for write operations (10 req/min)
const writeLimit = rateLimit({ windowMs: 60_000, maxRequests: 10 })

export function createResourceRoutes(
  service: ResourceService,
  eventBus: InstallEventBus,
): Hono {
  const app = new Hono()
  const kernel = service.getKernel()
  const auditLogger = service.getAuditLogger()
  const trustStore = service.getTrustStore()

  // ── GET /api/resources — List all resources (with ?type= filter) ────────
  app.get('/', async (c) => {
    try {
      const type = c.req.query('type')
      const source = c.req.query('source')
      const filter: { type?: string; source?: string } = {}
      if (type) filter.type = type
      if (source) filter.source = source
      const resources = await kernel.list(filter)
      return c.json({ resources })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/init — Initialize resource directory ────────────
  app.post('/init', writeLimit, async (c) => {
    try {
      const body = await c.req.json<{ force?: boolean }>().catch(() => ({}))
      await kernel.init({ force: body.force })
      return c.json({ ok: true, message: 'Resource directory initialized' })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/register — Register a resource ──────────────────
  app.post('/register', writeLimit, async (c) => {
    try {
      const manifest = await c.req.json<ResourceManifest>()
      await kernel.register(manifest)
      return c.json({ ok: true, name: manifest.name }, 201)
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/install — Install with SSE progress ─────────────
  app.post('/install', writeLimit, async (c) => {
    try {
      const body = await c.req.json<{
        additions: { name: string; type: string; version: string; source: string }[]
        removals?: string[]
        stream?: boolean
      }>()

      // Create install plan first
      const plan = await kernel.plan({
        additions: body.additions ?? [],
        removals: body.removals ?? [],
      })

      // If client wants SSE streaming, return SSE
      if (body.stream) {
        return streamSSE(c, async (stream) => {
          eventBus.emit({
            type: 'start',
            resource: plan.additions.map(a => a.name).join(', '),
            message: `Installing ${plan.additions.length} resource(s)`,
            progress: 0,
          })

          // Install each addition sequentially
          for (let i = 0; i < plan.additions.length; i++) {
            const addition = plan.additions[i]
            const progress = Math.round(((i + 1) / plan.additions.length) * 100)

            eventBus.emit({
              type: 'progress',
              resource: addition.name,
              message: `Installing ${addition.name}@${addition.version}`,
              progress,
            })

            // Register each resource from the plan
            try {
              const manifest: ResourceManifest = {
                name: addition.name,
                type: addition.type,
                version: addition.version,
                source: {
                  protocol: 'local',
                  location: addition.source,
                  version: addition.version,
                },
                hash: '0'.repeat(64), // placeholder — real install would compute hash
                dependencies: [],
                references: [],
              }
              await kernel.register(manifest)
            } catch (err) {
              eventBus.emit({
                type: 'error',
                resource: addition.name,
                message: err instanceof Error ? err.message : 'Install failed',
              })
            }
          }

          eventBus.emit({
            type: 'complete',
            resource: plan.additions.map(a => a.name).join(', '),
            message: `Installed ${plan.additions.length} resource(s)`,
            progress: 100,
          })

          // Write final SSE event and close
          await stream.writeSSE({
            event: 'complete',
            data: JSON.stringify({ plan, installed: plan.additions.length }),
          })
        })
      }

      // Non-streaming: install all and return result
      const installed: string[] = []
      const errors: { name: string; error: string }[] = []

      for (const addition of plan.additions) {
        try {
          const manifest: ResourceManifest = {
            name: addition.name,
            type: addition.type,
            version: addition.version,
            source: {
              protocol: 'local',
              location: addition.source,
              version: addition.version,
            },
            hash: '0'.repeat(64),
            dependencies: [],
            references: [],
          }
          await kernel.register(manifest)
          installed.push(addition.name)
        } catch (err) {
          errors.push({
            name: addition.name,
            error: err instanceof Error ? err.message : 'Install failed',
          })
        }
      }

      return c.json({ plan, installed, errors })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/events — SSE event stream for install progress ───
  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const since = c.req.query('since')
      // Replay buffered events
      const past = eventBus.replay(since)
      for (const event of past) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }

      // Subscribe to live events
      const unsub = eventBus.subscribe((event) => {
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      })

      // Heartbeat every 30s
      const interval = setInterval(() => {
        stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ ts: new Date().toISOString() }),
        })
      }, 30000)

      stream.onAbort(() => {
        unsub()
        clearInterval(interval)
      })

      // Keep connection alive
      while (true) {
        await stream.sleep(1000)
      }
    })
  })

  // ── DELETE /api/resources/:name — Uninstall a resource ──────────────────
  app.delete('/:name', writeLimit, async (c) => {
    try {
      const name = c.req.param('name')
      await kernel.unregister(name)
      return c.json({ ok: true, name })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/:name — Get resource details ─────────────────────
  app.get('/:name', async (c) => {
    try {
      const name = c.req.param('name')
      const manifest = await kernel.find(name)
      if (!manifest) {
        return c.json({ error: `Resource not found: ${name}`, code: 'RESOURCE_NOT_FOUND' }, 404)
      }
      return c.json({ resource: manifest })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/:name/deps — Get dependency tree ─────────────────
  app.get('/:name/deps', async (c) => {
    try {
      const name = c.req.param('name')
      const manifest = await kernel.find(name)
      if (!manifest) {
        return c.json({ error: `Resource not found: ${name}`, code: 'RESOURCE_NOT_FOUND' }, 404)
      }

      // Build dependency tree by recursively resolving deps
      const registry = await kernel.getRegistry()
      const depTree = buildDepTree(manifest, registry.entries, new Set())
      return c.json({ name, dependencies: depTree })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/update — Update resources ──────────────────────
  app.post('/update', writeLimit, async (c) => {
    try {
      const body = await c.req.json<{
        additions: { name: string; type: string; version: string; source: string }[]
        removals?: string[]
      }>()

      const plan = await kernel.plan({
        additions: body.additions ?? [],
        removals: body.removals ?? [],
      })

      // Apply plan: removals first, then additions
      for (const name of plan.removals) {
        try { await kernel.unregister(name) } catch { /* may already be removed */ }
      }

      const updated: string[] = []
      for (const addition of plan.additions) {
        try {
          const manifest: ResourceManifest = {
            name: addition.name,
            type: addition.type,
            version: addition.version,
            source: {
              protocol: 'local',
              location: addition.source,
              version: addition.version,
            },
            hash: '0'.repeat(64),
            dependencies: [],
            references: [],
          }
          await kernel.register(manifest)
          updated.push(addition.name)
        } catch { /* skip failed updates */ }
      }

      return c.json({ plan, updated })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/outdated — Check for outdated resources ──────────
  app.get('/outdated', async (c) => {
    try {
      const resources = await kernel.list()
      // In a real implementation, this would check remote sources for newer versions.
      // For now, return all installed resources with their current versions.
      const outdated = resources.map(r => ({
        name: r.name,
        type: r.type,
        currentVersion: r.version,
        latestVersion: r.version, // placeholder — would query source provider
        upToDate: true,
      }))
      return c.json({ outdated })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/sync — Sync workspace config ───────────────────
  app.post('/sync', writeLimit, async (c) => {
    try {
      const registry = await kernel.getRegistry()
      const resources = Object.values(registry.entries).map(e => ({
        name: e.manifest.name,
        type: e.manifest.type,
        version: e.manifest.version,
        installedAt: e.installedAt,
      }))
      return c.json({ synced: resources.length, resources })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/gc — Garbage collect ───────────────────────────
  app.post('/gc', writeLimit, async (c) => {
    try {
      const registry = await kernel.getRegistry()
      const activeCount = Object.keys(registry.entries).length

      // GC would clean orphaned cache entries; for now report status
      auditLogger.append({
        action: 'cache.gc',
        resource: '*',
        caller: 'human',
        detail: { activeResources: activeCount },
      })

      return c.json({
        ok: true,
        activeResources: activeCount,
        cleaned: 0, // placeholder
      })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/audit — Query audit log ─────────────────────────
  app.get('/audit', async (c) => {
    try {
      const action = c.req.query('action')
      const resource = c.req.query('resource')
      const caller = c.req.query('caller')
      const since = c.req.query('since')
      const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined

      const entries = auditLogger.query({
        action,
        resource,
        caller: caller as 'human' | 'agent' | undefined,
        since,
        limit,
      })

      return c.json({ entries })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/trust — Get trust store ─────────────────────────
  app.get('/trust', async (c) => {
    try {
      return c.json(trustStore.getData())
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/trust — Add trust entry ────────────────────────
  app.post('/trust', writeLimit, async (c) => {
    try {
      const body = await c.req.json<{ protocol: string; location: string; action?: 'trust' | 'block'; reason?: string }>()
      if (!body.protocol || !body.location) {
        return c.json({ error: 'protocol and location are required' }, 400)
      }

      if (body.action === 'block') {
        trustStore.block({ protocol: body.protocol, location: body.location }, body.reason)
      } else {
        trustStore.trust({ protocol: body.protocol, location: body.location })
      }

      return c.json({ ok: true, data: trustStore.getData() })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── DELETE /api/resources/trust — Remove trust entry ────────────────────
  app.delete('/trust', writeLimit, async (c) => {
    try {
      const body = await c.req.json<{ protocol: string; location: string; action?: 'untrust' | 'unblock' }>()
      if (!body.protocol || !body.location) {
        return c.json({ error: 'protocol and location are required' }, 400)
      }

      if (body.action === 'unblock') {
        trustStore.unblock({ protocol: body.protocol, location: body.location })
      } else {
        trustStore.untrust({ protocol: body.protocol, location: body.location })
      }

      return c.json({ ok: true, data: trustStore.getData() })
    } catch (err) {
      return handleError(c, err)
    }
  })

  return app
}

/**
 * Build a recursive dependency tree from a manifest.
 */
function buildDepTree(
  manifest: ResourceManifest,
  entries: Record<string, { manifest: ResourceManifest; installedAt: string }>,
  visited: Set<string>,
): object[] {
  if (visited.has(manifest.name)) {
    return [{ name: manifest.name, circular: true }]
  }
  visited.add(manifest.name)

  return manifest.dependencies.map(depName => {
    const depEntry = Object.values(entries).find(e => e.manifest.name === depName)
    if (!depEntry) {
      return { name: depName, missing: true }
    }
    return {
      name: depEntry.manifest.name,
      type: depEntry.manifest.type,
      version: depEntry.manifest.version,
      dependencies: buildDepTree(depEntry.manifest, entries, new Set(visited)),
    }
  })
}

export default createResourceRoutes
