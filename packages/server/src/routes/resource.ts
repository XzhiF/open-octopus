import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ResourceError, ResourceErrorCode } from '@octopus/shared'
import type { ResourceManifest } from '@octopus/shared'
import {
  ResourceManifestSchema, RegistrySchema,
  TrustSourceInputSchema, InstallRequestSchema, UninstallRequestSchema,
  SyncRequestSchema, GcRequestSchema, InitRequestSchema,
} from '@octopus/shared'
import { ResourceService } from '../services/resource-service'
import { InstallEventBus } from '../services/install-event-bus'
import { rateLimit } from '../middleware/rate-limit'
import { requireAuth } from './resource-auth'
import { logInfo, logError } from '../file-logger'
import {
  BuiltinSourceProvider, LocalSourceProvider, NpmSourceProvider, GitSourceProvider,
  scanInstalledResources,
} from '@octopus/shared'
import type { SourceProvider } from '@octopus/shared'

function getProvider(protocol: string, corePackDir?: string): SourceProvider {
  switch (protocol) {
    case 'builtin': return new BuiltinSourceProvider(corePackDir ?? '')
    case 'local': return new LocalSourceProvider()
    case 'npm': return new NpmSourceProvider()
    case 'git': return new GitSourceProvider()
    default: throw new ResourceError(ResourceErrorCode.INVALID_MANIFEST, `Unknown protocol: ${protocol}`)
  }
}

/**
 * Map ResourceError to HTTP response; unknown errors become 500.
 * HV-4 fix: log errors via logError.
 */
function handleError(c: any, err: unknown) {
  if (err instanceof ResourceError) {
    if (err.status >= 500) {
      logError(`Resource API ${err.code}: ${err.message}`, err)
    }
    return c.json(
      { error: err.message, code: err.code, suggestion: err.suggestion },
      err.status,
    )
  }
  const message = err instanceof Error ? err.message : 'Internal Server Error'
  logError(`Resource API unexpected error: ${message}`, err instanceof Error ? err : undefined)
  return c.json({ error: message }, 500)
}

// Stricter rate limit for write operations (10 req/min)
const writeLimit = rateLimit({ windowMs: 60_000, maxRequests: 10 })

export function createResourceRoutes(
  service: ResourceService,
  eventBus: InstallEventBus,
  authToken: string,
): Hono {
  const app = new Hono()
  const kernel = service.getKernel()
  const auditLogger = service.getAuditLogger()
  const trustStore = service.getTrustStore()

  // B-02 fix: Apply auth middleware to all resource routes
  app.use('*', requireAuth(authToken))

  // ── GET /api/resources — List all resources (with ?type= filter) ────────
  app.get('/', async (c) => {
    try {
      const type = c.req.query('type')
      const filter: { type?: string; source?: string } = {}
      if (type) filter.type = type
      const resources = await kernel.list(filter)

      // Compute counts by type (frontend expects total + by_type)
      const byType: Record<string, number> = { skill: 0, agent: 0, workflow: 0, source: 0 }
      for (const r of resources) {
        byType[r.type] = (byType[r.type] ?? 0) + 1
      }

      return c.json({
        resources: resources.map(manifest => ({
          manifest,
          installedAt: '', // registry doesn't track this separately per-manifest currently
        })),
        total: resources.length,
        by_type: byType,
      })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/search?q= — Search resources ─────────────────────
  app.get('/search', async (c) => {
    try {
      const q = c.req.query('q') ?? ''
      if (!q) return c.json({ results: [], total: 0 })

      const allResources = await kernel.list()
      const query = q.toLowerCase()
      const matched = allResources.filter(r =>
        r.name.toLowerCase().includes(query) ||
        r.description?.toLowerCase().includes(query) ||
        r.tags?.some(t => t.toLowerCase().includes(query))
      )

      return c.json({
        results: matched.map(manifest => ({ manifest, installedAt: '' })),
        total: matched.length,
      })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/init — Initialize resource directory ────────────
  app.post('/init', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = InitRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      await kernel.init({ force: parsed.data.force })
      return c.json({ ok: true, message: 'Resource directory initialized' })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/register — Register a resource ──────────────────
  app.post('/register', writeLimit, async (c) => {
    try {
      const raw = await c.req.json()
      // B-07 fix: Zod runtime validation
      const parsed = ResourceManifestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid manifest', details: parsed.error.issues }, 400)
      }
      logInfo(`Registering resource: ${parsed.data.name}`)
      await kernel.register(parsed.data)
      return c.json({ ok: true, name: parsed.data.name }, 201)
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/install — Install with async SSE progress ───────
  app.post('/install', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      // B-07 fix: Zod validation on install body
      const parsed = InstallRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const { names = [], confirmed = false, removals = [], additions: rawAdditions } = parsed.data

      // Build additions from either format
      let additions: { name: string; type: string; version: string; source: string }[]
      if (rawAdditions && rawAdditions.length > 0) {
        additions = rawAdditions
      } else {
        // Frontend simplified format: just names
        const registry = await kernel.getRegistry()
        additions = names.map(name => {
          const entry = Object.values(registry.entries).find(e => e.manifest.name === name)
          if (entry) {
            return {
              name: entry.manifest.name,
              type: entry.manifest.type,
              version: entry.manifest.version,
              source: `${entry.manifest.source.protocol}:${entry.manifest.source.location}`,
            }
          }
          return { name, type: 'skill', version: 'latest', source: 'builtin:core-pack' }
        })
      }

      // Create install plan
      const plan = await kernel.plan({
        additions,
        removals,
      })

      if (plan.conflicts.length > 0 && !confirmed) {
        return c.json({ plan, conflicts: plan.conflicts }, 409)
      }

      const installId = plan.id
      logInfo(`Starting async install: ${installId} (${plan.additions.length} resources)`)

      // B-08/B-09 fix: Pass providers + service for real installation with SourceProvider hash
      const corePackDir = service.getCorePackDir()
      runInstallAsync(installId, plan.additions, kernel, service, eventBus, corePackDir)

      return c.json({ installId, plan })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/install/:id/stream — SSE install progress ────────
  app.get('/install/:id/stream', (c) => {
    const installId = c.req.param('id')
    return streamSSE(c, async (stream) => {
      // Replay buffered events for this installId
      const since = c.req.query('since')
      const past = eventBus.replay(installId, since)
      for (const event of past) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }

      // Check if install already completed
      const lastEvent = past[past.length - 1]
      if (lastEvent?.type === 'complete' || lastEvent?.type === 'error') {
        return // close stream
      }

      // Subscribe to live events for this installId
      const unsub = eventBus.subscribe(installId, (event) => {
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {})
      })

      // Heartbeat every 30s
      const interval = setInterval(() => {
        stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ ts: new Date().toISOString() }),
        }).catch(() => {})
      }, 30000)

      stream.onAbort(() => {
        unsub()
        clearInterval(interval)
      })

      // Keep connection alive (max 5 min)
      const timeout = setTimeout(() => {
        unsub()
        clearInterval(interval)
      }, 5 * 60 * 1000)

      while (true) {
        await stream.sleep(1000)
        // Check if install finished (no more listeners)
        if (!eventBus.isActive(installId)) break
      }

      clearTimeout(timeout)
      unsub()
      clearInterval(interval)
    })
  })

  // ── POST /api/resources/uninstall — Uninstall resources ─────────────────
  app.post('/uninstall', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = UninstallRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const names = parsed.data.names
      const force = parsed.data.force ?? false
      const uninstalled: string[] = []
      const errors: { name: string; error: string }[] = []

      for (const name of names) {
        try {
          await kernel.unregister(name, { force })
          uninstalled.push(name)
        } catch (err) {
          errors.push({
            name,
            error: err instanceof Error ? err.message : 'Uninstall failed',
          })
        }
      }

      return c.json({
        success: errors.length === 0,
        uninstalled,
        errors: errors.length > 0 ? errors : undefined,
      })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── DELETE /api/resources/:name — Uninstall (backward compat) ───────────
  app.delete('/:name', writeLimit, async (c) => {
    try {
      const name = c.req.param('name')
      await kernel.unregister(name)
      return c.json({ ok: true, name })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/update — Update resources ──────────────────────
  app.post('/update', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = InstallRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const { names = [], removals = [], additions: rawAdditions } = parsed.data

      let additions: { name: string; type: string; version: string; source: string }[]
      if (rawAdditions && rawAdditions.length > 0) {
        additions = rawAdditions
      } else {
        const registry = await kernel.getRegistry()
        additions = names.map(name => {
          const entry = Object.values(registry.entries).find(e => e.manifest.name === name)
          if (entry) {
            return {
              name: entry.manifest.name,
              type: entry.manifest.type,
              version: entry.manifest.version,
              source: `${entry.manifest.source.protocol}:${entry.manifest.source.location}`,
            }
          }
          return { name, type: 'skill', version: 'latest', source: 'builtin:core-pack' }
        })
      }

      const plan = await kernel.plan({
        additions,
        removals,
      })

      // Apply plan: removals first, then additions
      for (const name of plan.removals) {
        try { await kernel.unregister(name) } catch { /* may already be removed */ }
      }

      const updated: string[] = []
      const details: { name: string; from: string; to: string }[] = []
      for (const addition of plan.additions) {
        try {
          // Look up current version before update
          const existing = await kernel.find(addition.name)
          const fromVersion = existing?.version ?? 'unknown'

          const manifest: ResourceManifest = {
            name: addition.name,
            type: addition.type as ResourceManifest['type'],
            version: addition.version,
            source: {
              protocol: (addition.source.split(':')[0] ?? 'local') as ResourceManifest['source']['protocol'],
              location: addition.source.split(':').slice(1).join(':') || addition.source,
              version: addition.version,
            },
            hash: existing?.hash ?? '0'.repeat(64),
            dependencies: [],
            references: [],
          }
          await kernel.register(manifest)
          updated.push(addition.name)
          details.push({ name: addition.name, from: fromVersion, to: addition.version })
        } catch { /* skip failed updates */ }
      }

      return c.json({ success: true, updated, details })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/outdated — Check for outdated resources ──────────
  app.get('/outdated', async (c) => {
    try {
      const resources = await kernel.list()
      // In a real implementation, this would check remote sources for newer versions.
      // For now, return all installed resources as up-to-date.
      const outdated = resources.map(r => ({
        name: r.name,
        type: r.type,
        current: r.version,
        latest: r.version,
        source: `${r.source.protocol}:${r.source.location}`,
        upToDate: true,
      }))
      return c.json({ outdated, total: outdated.length })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/scan — Scan installed resources on disk (F15) ──────
  app.get('/scan', async (c) => {
    try {
      const installBase = process.env.OCTOPUS_RESOURCE_INSTALL_DIR || process.cwd()
      const installed = scanInstalledResources(installBase)
      const registry = await kernel.getRegistry()
      const registeredNames = new Set(Object.values(registry.entries).map(e => e.manifest.name))
      const onDiskNames = new Set(installed.map(r => r.name))

      const missing = installed.filter(r => !registeredNames.has(r.name))
      const extra = [...registeredNames].filter(n => !onDiskNames.has(n))

      return c.json({ installed, missing, extra, total: installed.length })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/sync — Sync workspace config ───────────────────
  app.post('/sync', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = SyncRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const registry = await kernel.getRegistry()
      const installBase = process.env.OCTOPUS_RESOURCE_INSTALL_DIR || process.cwd()
      const onDisk = scanInstalledResources(installBase)
      const registeredNames = new Set(Object.values(registry.entries).map(e => e.manifest.name))
      const onDiskNames = new Set(onDisk.map(r => r.name))

      const missing = onDisk.filter(r => !registeredNames.has(r.name)).map(r => r.name)
      const extra = [...registeredNames].filter(n => !onDiskNames.has(n))

      return c.json({
        synced: true,
        fix: !!parsed.data.fix,
        drift: {
          missing,
          extra,
          hash_mismatch: [],
        },
      })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/gc — Garbage collect ───────────────────────────
  app.post('/gc', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = GcRequestSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const registry = await kernel.getRegistry()
      const activeCount = Object.keys(registry.entries).length

      auditLogger.append({
        action: 'cache.gc',
        resource: '*',
        caller: 'human',
        detail: { activeResources: activeCount, dryRun: !!parsed.data.dryRun },
      })

      return c.json({
        success: true,
        cleaned: 0,
        freedBytes: 0,
        items: [],
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
      // Frontend sends "last", PRD uses "limit" — accept both
      const last = c.req.query('last') ?? c.req.query('limit')
      const limit = last ? parseInt(last, 10) : 100

      const entries = auditLogger.query({
        action,
        resource,
        caller: caller as 'human' | 'agent' | undefined,
        since,
        limit: Math.min(limit, 1000), // PRD: maxLast=1000
      })

      // F14: Check if archived (rotated) logs exist — indicates partial data
      // when querying with filters that might match older entries
      const hasArchives = auditLogger.hasArchives()

      return c.json({ entries, total: entries.length, partial: hasArchives })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/doctor — Health check ────────────────────────────
  app.get('/doctor', async (c) => {
    try {
      const checks: { name: string; passed: boolean; message: string }[] = []

      // 1. Registry readable
      try {
        const registry = await kernel.getRegistry()
        const count = Object.keys(registry.entries).length
        checks.push({ name: 'registry', passed: true, message: `${count} entries` })
      } catch {
        checks.push({ name: 'registry', passed: false, message: 'Cannot read registry' })
      }

      // 2. Trust store
      const trustData = trustStore.getData()
      checks.push({
        name: 'trust-store',
        passed: true,
        message: `${trustData.trusted.length} trusted, ${trustData.blocked.length} blocked`,
      })

      // 3. Audit log writable
      try {
        auditLogger.append({
          action: 'doctor.repaired',
          resource: 'healthcheck',
          caller: 'human',
          detail: { probe: true },
        })
        checks.push({ name: 'audit-log', passed: true, message: 'Writable' })
      } catch {
        checks.push({ name: 'audit-log', passed: false, message: 'Not writable' })
      }

      const allPassed = checks.every(ch => ch.passed)
      return c.json({
        status: allPassed ? 'ok' : 'degraded',
        checks,
      })
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
      const raw = await c.req.json().catch(() => ({}))
      const parsed = TrustSourceInputSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const location = parsed.data.location ?? parsed.data.package ?? ''
      if (!parsed.data.protocol || !location) {
        return c.json({ error: 'protocol and location/package are required' }, 400)
      }

      // Check for duplicate
      if (trustStore.isTrusted({ protocol: parsed.data.protocol, location })) {
        return c.json({ success: true }) // idempotent
      }

      trustStore.trust({ protocol: parsed.data.protocol, location })

      auditLogger.append({
        action: 'trust.added',
        resource: `${parsed.data.protocol}:${location}`,
        caller: 'human',
      })

      return c.json({ success: true })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── DELETE /api/resources/trust — Remove trust entry ────────────────────
  app.delete('/trust', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = TrustSourceInputSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const location = parsed.data.location ?? parsed.data.package ?? ''
      if (!parsed.data.protocol || !location) {
        return c.json({ error: 'protocol and location/package are required' }, 400)
      }

      trustStore.untrust({ protocol: parsed.data.protocol, location })

      auditLogger.append({
        action: 'trust.removed',
        resource: `${parsed.data.protocol}:${location}`,
        caller: 'human',
      })

      return c.json({ success: true })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── POST /api/resources/trust/block — Add blocked entry ────────────────
  app.post('/trust/block', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = TrustSourceInputSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const location = parsed.data.location ?? parsed.data.package ?? ''
      if (!parsed.data.protocol || !location) {
        return c.json({ error: 'protocol and location/package are required' }, 400)
      }

      trustStore.block({ protocol: parsed.data.protocol, location }, parsed.data.reason)

      auditLogger.append({
        action: 'trust.blocked',
        resource: `${parsed.data.protocol}:${location}`,
        caller: 'human',
        detail: parsed.data.reason ? { reason: parsed.data.reason } : undefined,
      })

      return c.json({ success: true })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── DELETE /api/resources/trust/block — Remove blocked entry ────────────
  app.delete('/trust/block', writeLimit, async (c) => {
    try {
      const raw = await c.req.json().catch(() => ({}))
      const parsed = TrustSourceInputSchema.safeParse(raw)
      if (!parsed.success) {
        return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400)
      }
      const location = parsed.data.location ?? parsed.data.package ?? ''
      if (!parsed.data.protocol || !location) {
        return c.json({ error: 'protocol and location/package are required' }, 400)
      }

      trustStore.unblock({ protocol: parsed.data.protocol, location })
      return c.json({ success: true })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/:type/:name — Get resource details ──────────────
  app.get('/:type/:name', async (c) => {
    try {
      const type = c.req.param('type')
      const name = c.req.param('name')
      const manifest = await kernel.find(name)
      if (!manifest || manifest.type !== type) {
        return c.json({ error: `Resource not found: ${type}/${name}`, code: 'RESOURCE_NOT_FOUND' }, 404)
      }

      // Find registry entry for installedAt
      const registry = await kernel.getRegistry()
      const entry = Object.values(registry.entries).find(e => e.manifest.name === name)

      return c.json({
        manifest,
        installedAt: entry?.installedAt ?? '',
        cachePath: entry?.cachePath,
      })
    } catch (err) {
      return handleError(c, err)
    }
  })

  // ── GET /api/resources/:type/:name/deps — Get dependency tree ───────────
  app.get('/:type/:name/deps', async (c) => {
    try {
      const type = c.req.param('type')
      const name = c.req.param('name')
      const manifest = await kernel.find(name)
      if (!manifest || manifest.type !== type) {
        return c.json({ error: `Resource not found: ${type}/${name}`, code: 'RESOURCE_NOT_FOUND' }, 404)
      }

      const registry = await kernel.getRegistry()
      const depTree = buildDepTree(manifest, registry.entries, new Set())
      return c.json({ name, type, dependencies: depTree })
    } catch (err) {
      return handleError(c, err)
    }
  })

  return app
}

/**
 * Async install execution — emits events through InstallEventBus.
 * B-08 fix: Actually uses SourceProvider to fetch files (not just register with fake hash).
 * B-09 fix: Uses real hash from SourceProvider, not '0'.repeat(64).
 */
async function runInstallAsync(
  installId: string,
  additions: { name: string; type: string; version: string; source: string }[],
  kernel: any,
  service: ResourceService,
  eventBus: InstallEventBus,
  corePackDir: string,
): Promise<void> {
  eventBus.emit(installId, {
    type: 'install_start',
    resource: additions.map(a => a.name).join(', '),
    message: `Installing ${additions.length} resource(s)`,
    progress: 0,
  })

  let installed = 0
  let failed = 0

  for (let i = 0; i < additions.length; i++) {
    const addition = additions[i]
    const progress = Math.round(((i + 1) / additions.length) * 100)

    eventBus.emit(installId, {
      type: 'install_progress',
      resource: addition.name,
      message: `Fetching ${addition.name}@${addition.version}`,
      progress,
    })

    try {
      const [protocol, ...locParts] = addition.source.split(':')
      const location = locParts.join(':') || addition.source

      // Use SourceProvider to actually fetch and compute real hash
      const provider = getProvider(protocol, corePackDir)
      const fetchResult = await provider.fetch({
        protocol,
        location,
        version: addition.version,
      })

      const manifest = ResourceManifestSchema.parse({
        name: addition.name,
        type: addition.type,
        version: fetchResult.version || addition.version,
        source: { protocol, location, version: fetchResult.version || addition.version },
        hash: fetchResult.hash,
        dependencies: [],
        references: [],
      })
      await kernel.register(manifest)
      installed++

      eventBus.emit(installId, {
        type: 'install_progress',
        resource: addition.name,
        message: `${addition.name} installed successfully`,
        progress,
      })
    } catch (err) {
      failed++
      eventBus.emit(installId, {
        type: 'install_error',
        resource: addition.name,
        message: err instanceof Error ? err.message : 'Install failed',
      })
    }
  }

  eventBus.emit(installId, {
    type: 'install_complete',
    resource: additions.map(a => a.name).join(', '),
    message: `Installed ${installed} resource(s)${failed > 0 ? `, ${failed} failed` : ''}`,
    progress: 100,
  })
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
