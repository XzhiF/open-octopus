import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { ZodError } from 'zod'
import {
  SchedulerService,
  SchedulerJobNotFoundError,
  SchedulerJobConflictError,
  SchedulerVersionConflictError,
  SchedulerTriggerConflictError,
} from '../services/scheduler/scheduler-service'
import { DashboardService } from '../services/scheduler/dashboard-service'
import { ExportService } from '../services/scheduler/export-service'
import { ConfigValidationError } from '../services/scheduler/config-validator'
import { parseCronExpression, naturalLanguageToCron } from '../services/cron-utils'
import type { CreateJobInput, UpdateJobInput } from '@octopus/shared'
import { EvolutionConfigService } from '../services/scheduler/evolution-config'
import { UsageTrackerService } from '../services/scheduler/usage-tracker'
import { z } from 'zod'

// ── Rate Limiter ────────────────────────────────────────────────────

function createRateLimiter(maxTokens: number, refillIntervalMs: number) {
  const buckets = new Map<string, { tokens: number; lastRefill: number }>()

  // Cleanup old entries every 5 minutes
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > 300_000) buckets.delete(key)
    }
  }, 300_000)
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) cleanupTimer.unref()

  return function rateLimiter(c: Context, next: Next) {
    // Security: Don't trust X-Forwarded-For from untrusted sources
    // Use connection IP from Hono's connInfo or fallback to a safe default
    let ip = 'unknown'

    // Try to get connection IP from Hono context (if available)
    const connInfo = (c as any).env?.connInfo
    if (connInfo?.remote?.address) {
      ip = connInfo.remote.address
    } else {
      // Fallback: use x-real-ip if set by trusted reverse proxy, otherwise use a hash of user-agent + path
      const realIp = c.req.header('x-real-ip')
      if (realIp && isValidPrivateIp(realIp)) {
        ip = realIp
      } else {
        // For direct connections without proxy, use a combination of headers to identify the client
        // This is not spoofable without controlling the connection itself
        const userAgent = c.req.header('user-agent') ?? 'unknown'
        const path = c.req.path
        ip = `direct:${hashCode(userAgent + path)}`
      }
    }

    const key = `${c.req.path}:${ip}`
    const now = Date.now()

    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now }
      buckets.set(key, bucket)
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill
    const refilled = Math.floor(elapsed / refillIntervalMs) * maxTokens
    bucket.tokens = Math.min(maxTokens, bucket.tokens + refilled)
    bucket.lastRefill = now

    if (bucket.tokens <= 0) {
      return c.json({ error: 'Rate limit exceeded' }, 429)
    }

    bucket.tokens--
    return next()
  }
}

// Helper: Check if IP is from a trusted private network (proxy)
function isValidPrivateIp(ip: string): boolean {
  // Only trust x-real-ip from private network ranges (typical reverse proxy)
  const privateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^192\.168\./,
    /^127\./,
    /^::1$/,
    /^fc00:/i,
    /^fe80:/i,
  ]
  return privateRanges.some((range) => range.test(ip))
}

// Helper: Simple hash function for creating identifiers
function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36)
}

// Rate limiters per endpoint group
const rateLimitCreate = createRateLimiter(10, 60_000)   // 10/min
const rateLimitTrigger = createRateLimiter(5, 60_000)   // 5/min
const rateLimitDelete = createRateLimiter(5, 60_000)    // 5/min
const rateLimitDefault = createRateLimiter(60, 60_000)  // 60/min

// ── Error Classification ────────────────────────────────────────────

function classifyError(err: unknown): { status: number; message: string } {
  if (err instanceof ZodError) {
    const details = err.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    return { status: 400, message: details }
  }
  if (err instanceof SchedulerJobNotFoundError) return { status: 404, message: err.message }
  if (err instanceof SchedulerJobConflictError) return { status: 409, message: err.message }
  if (err instanceof SchedulerVersionConflictError) return { status: 409, message: err.message }
  if (err instanceof SchedulerTriggerConflictError) return { status: 409, message: err.message }
  if (err instanceof ConfigValidationError) return { status: 400, message: err.message }

  const msg = err instanceof Error ? err.message : String(err)
  return { status: 500, message: msg }
}

// ── Helpers ─────────────────────────────────────────────────────────

async function safeJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function parseIntParam(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

// ── Route Factory ───────────────────────────────────────────────────

export function createSchedulerRoutes(
  service: SchedulerService,
  dashboardService?: DashboardService,
  exportService?: ExportService,
  evolutionService?: EvolutionConfigService,
  usageTracker?: UsageTrackerService,
): Hono {
  const router = new Hono()

  // ── Job CRUD ────────────────────────────────────────────────────

  // GET /jobs — list with pagination, filtering, sorting
  router.get('/jobs', rateLimitDefault, (c) => {
    try {
      const result = service.listJobs({
        page: parseIntParam(c.req.query('page'), 1),
        limit: Math.min(parseIntParam(c.req.query('limit'), 20), 100),
        search: c.req.query('search'),
        status: c.req.query('status') as 'enabled' | 'disabled' | 'failed' | undefined,
        job_type: c.req.query('job_type') as 'workflow' | 'agent' | undefined,
        workspace_id: c.req.query('workspace_id'),
        sort: c.req.query('sort') as 'name' | 'created_at' | 'next_trigger_at' | undefined,
        order: c.req.query('order') as 'asc' | 'desc' | undefined,
      })
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /jobs — create
  router.post('/jobs', rateLimitCreate, async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: 'Invalid or missing JSON body' }, 400)
    try {
      const job = service.createJob(body as CreateJobInput)
      return c.json(job, 201)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /jobs/:id — detail
  router.get('/jobs/:id', rateLimitDefault, (c) => {
    try {
      const job = service.getJob(c.req.param('id'))
      return c.json(job)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // PUT /jobs/:id — update with If-Match for optimistic locking
  router.put('/jobs/:id', rateLimitDefault, async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: 'Invalid or missing JSON body' }, 400)

    const ifMatch = c.req.header('if-match')
    if (!ifMatch) {
      return c.json({ error: 'If-Match header is required for optimistic locking' }, 428)
    }

    const version = parseInt(ifMatch, 10)
    if (!Number.isFinite(version)) {
      return c.json({ error: 'If-Match header must be a valid integer' }, 400)
    }

    try {
      const job = service.updateJob(c.req.param('id'), body as UpdateJobInput, version)
      return c.json(job)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // DELETE /jobs/:id — soft delete
  router.delete('/jobs/:id', rateLimitDelete, (c) => {
    try {
      service.deleteJob(c.req.param('id'))
      return c.json({ success: true })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Job Actions ─────────────────────────────────────────────────

  // POST /jobs/:id/toggle — enable/disable
  router.post('/jobs/:id/toggle', rateLimitDefault, (c) => {
    try {
      const job = service.toggleJob(c.req.param('id'))
      return c.json(job)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /jobs/:id/trigger — manual trigger
  router.post('/jobs/:id/trigger', rateLimitTrigger, (c) => {
    try {
      const result = service.triggerJob(c.req.param('id'))
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Executions ──────────────────────────────────────────────────

  // GET /jobs/:id/executions — execution history
  router.get('/jobs/:id/executions', rateLimitDefault, (c) => {
    try {
      const result = service.getExecutions(c.req.param('id'), {
        page: parseIntParam(c.req.query('page'), 1),
        limit: Math.min(parseIntParam(c.req.query('limit'), 20), 100),
        status: c.req.query('status') as 'success' | 'failure' | 'skipped' | 'running' | undefined,
      })
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /jobs/:id/executions/:eid — single execution detail
  router.get('/jobs/:id/executions/:eid', rateLimitDefault, (c) => {
    try {
      const execution = service.getExecution(c.req.param('id'), c.req.param('eid'))
      return c.json(execution)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /jobs/:id/executions/:eid/log — execution log with offset/limit
  router.get('/jobs/:id/executions/:eid/log', rateLimitDefault, (c) => {
    try {
      const offset = parseIntParam(c.req.query('offset'), 0)
      const limit = Math.min(parseIntParam(c.req.query('limit'), 102400), 200_000)
      const log = service.getExecutionLog(c.req.param('eid'), offset, limit)
      return c.json(log)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Audit Logs ──────────────────────────────────────────────────

  // GET /jobs/:id/audit-logs — audit history
  router.get('/jobs/:id/audit-logs', rateLimitDefault, (c) => {
    try {
      const result = service.getAuditLogs(c.req.param('id'), {
        page: parseIntParam(c.req.query('page'), 1),
        limit: Math.min(parseIntParam(c.req.query('limit'), 20), 100),
        action: c.req.query('action'),
      })
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Schedule Workspaces ──────────────────────────────────────────

  // GET /jobs/:id/workspaces — list workspaces created by a schedule
  router.get('/jobs/:id/workspaces', rateLimitDefault, (c) => {
    try {
      const result = service.getScheduleWorkspaces(c.req.param('id'), {
        page: parseIntParam(c.req.query('page'), 1),
        limit: Math.min(parseIntParam(c.req.query('limit'), 20), 100),
        status: c.req.query('status'),
      })
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /jobs/:id/workspaces/:wsId — single schedule workspace detail
  router.get('/jobs/:id/workspaces/:wsId', rateLimitDefault, (c) => {
    try {
      const ws = service.getScheduleWorkspace(c.req.param('id'), c.req.param('wsId'))
      if (!ws) return c.json({ error: 'Schedule workspace not found' }, 404)
      return c.json(ws)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Cron Utilities ──────────────────────────────────────────────

  // POST /cron/parse — parse and describe a cron expression
  router.post('/cron/parse', rateLimitDefault, async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: 'Invalid or missing JSON body' }, 400)

    const { expression, timezone } = body as { expression?: string; timezone?: string }
    if (!expression || !timezone) {
      return c.json({ error: 'expression and timezone are required' }, 400)
    }

    const result = parseCronExpression(expression, timezone)
    // Transform to contract format: camelCase → snake_case + add missing fields
    const nextExecutions = result.nextExecutions ?? []
    const isHighFrequency = result.valid && expression.trim().startsWith('* *')
    // Detect DST transitions by comparing UTC offsets of consecutive executions
    const dstNotes: string[] = []
    if (result.valid && nextExecutions.length >= 2) {
      try {
        for (let i = 0; i < nextExecutions.length - 1; i++) {
          const d1 = new Date(nextExecutions[i])
          const d2 = new Date(nextExecutions[i + 1])
          const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
          const tz1 = fmt.formatToParts(d1).find(p => p.type === 'timeZoneName')?.value ?? ''
          const tz2 = fmt.formatToParts(d2).find(p => p.type === 'timeZoneName')?.value ?? ''
          if (tz1 !== tz2) {
            dstNotes.push(`DST transition detected between ${d1.toISOString().slice(0,10)} and ${d2.toISOString().slice(0,10)} (${tz1} → ${tz2})`)
            break
          }
        }
      } catch { /* non-DST timezone, ignore */ }
    }
    return c.json({
      valid: result.valid,
      description: result.description,
      next_executions: nextExecutions,
      is_high_frequency: isHighFrequency,
      dst_notes: dstNotes,
    })
  })

  // POST /cron/natural — natural language to cron expression
  router.post('/cron/natural', rateLimitDefault, async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: 'Invalid or missing JSON body' }, 400)

    const text = (body.text ?? body.input) as string | undefined
    if (!text) {
      return c.json({ error: 'text or input is required' }, 400)
    }

    const result = naturalLanguageToCron(text)
    // Transform to contract format: camelCase → snake_case
    return c.json({
      expression: result.expression || null,
      description: result.description,
      next_executions: result.nextExecutions ?? [],
      confidence: result.confidence,
      ...(result.error ? { error: result.error } : {}),
    })
  })

  // ── Dashboard ───────────────────────────────────────────────────

  // GET /dashboard
  router.get('/dashboard', rateLimitDefault, (c) => {
    if (!dashboardService) {
      return c.json({ error: 'Dashboard service not available' }, 503)
    }
    try {
      const rawRange = c.req.query('range') ?? 'all'
      const range = ['all', '24h', '7d', '30d', 'custom'].includes(rawRange)
        ? (rawRange as 'all' | '24h' | '7d' | '30d' | 'custom')
        : 'all'
      const from = c.req.query('from')
      const to = c.req.query('to')
      const summary = dashboardService.getSummary(range, from, to)
      return c.json(summary)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('required')) return c.json({ error: msg }, 400)
      return c.json({ error: msg }, 500)
    }
  })

  // GET /dashboard/export
  router.get('/dashboard/export', rateLimitDefault, (c) => {
    if (!exportService) {
      return c.json({ error: 'Export service not available' }, 503)
    }
    const format = c.req.query('format')
    if (!format) return c.json({ error: 'format is required' }, 400)

    const scope = (c.req.query('scope') ?? 'all') as 'all' | 'failed'
    const range = c.req.query('range') ?? '24h'
    const from = c.req.query('from')
    const to = c.req.query('to')

    if (format === 'csv') {
      const csv = exportService.exportCSV(range, scope, from, to)
      const date = new Date().toISOString().split('T')[0]
      c.header('Content-Type', 'text/csv; charset=utf-8')
      c.header('Content-Disposition', `attachment; filename="scheduler-export-${date}.csv"`)
      return c.body(csv)
    }

    // PDF not implemented in V1 - return error
    return c.json({ error: 'PDF export not yet available' }, 501)
  })

  // ── Evolution Config ───────────────────────────────────────────

  const evolutionScopeSchema = z.object({
    org: z.string().min(1).max(100),
    scopes: z.array(z.string().min(1).max(200)).max(50),
  })

  const evolutionProtectedSchema = z.object({
    org: z.string().min(1).max(100),
    items: z.array(z.string().min(1).max(200)).max(100),
  })

  // GET /evolution/scope?org=<org>
  router.get('/evolution/scope', rateLimitDefault, (c) => {
    if (!evolutionService) return c.json({ error: 'Evolution service not available' }, 503)
    const org = c.req.query('org')
    if (!org) return c.json({ error: 'org query parameter is required' }, 400)
    try {
      const scopes = evolutionService.getEvolutionScope(org)
      return c.json({ org, evolution_scope: scopes })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // PUT /evolution/scope
  router.put('/evolution/scope', rateLimitDefault, async (c) => {
    if (!evolutionService) return c.json({ error: 'Evolution service not available' }, 503)
    const body = await safeJson(c)
    if (!body) return c.json({ error: 'Invalid or missing JSON body' }, 400)
    try {
      const { org, scopes } = evolutionScopeSchema.parse(body)
      evolutionService.updateEvolutionScope(org, scopes)
      return c.json({ org, evolution_scope: scopes })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /evolution/protected?org=<org>
  router.get('/evolution/protected', rateLimitDefault, (c) => {
    if (!evolutionService) return c.json({ error: 'Evolution service not available' }, 503)
    const org = c.req.query('org')
    if (!org) return c.json({ error: 'org query parameter is required' }, 400)
    try {
      const items = evolutionService.getRetireProtected(org)
      return c.json({ org, retire_protected: items })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // PUT /evolution/protected
  router.put('/evolution/protected', rateLimitDefault, async (c) => {
    if (!evolutionService) return c.json({ error: 'Evolution service not available' }, 503)
    const body = await safeJson(c)
    if (!body) return c.json({ error: 'Invalid or missing JSON body' }, 400)
    try {
      const { org, items } = evolutionProtectedSchema.parse(body)
      evolutionService.updateRetireProtected(org, items)
      return c.json({ org, retire_protected: items })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Usage Tracking ─────────────────────────────────────────────

  // GET /usage/stats?workflow=<ref>&days=30
  router.get('/usage/stats', rateLimitDefault, (c) => {
    if (!usageTracker) return c.json({ error: 'Usage tracker not available' }, 503)
    const workflow = c.req.query('workflow')
    if (!workflow) return c.json({ error: 'workflow query parameter is required' }, 400)
    const days = parseIntParam(c.req.query('days'), 30)
    try {
      const stats = usageTracker.getUsageStats(workflow, days)
      if (!stats) return c.json({ error: 'No execution data found for workflow' }, 404)
      return c.json(stats)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /usage/low-usage?threshold=0.05&days=90
  router.get('/usage/low-usage', rateLimitDefault, (c) => {
    if (!usageTracker) return c.json({ error: 'Usage tracker not available' }, 503)
    const threshold = parseFloat(c.req.query('threshold') ?? '0.05')
    const days = parseIntParam(c.req.query('days'), 90)
    try {
      const items = usageTracker.getLowUsageWorkflows(threshold, days)
      return c.json({ items, threshold, days })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /usage/high-failure?threshold=0.5&days=90
  router.get('/usage/high-failure', rateLimitDefault, (c) => {
    if (!usageTracker) return c.json({ error: 'Usage tracker not available' }, 503)
    const threshold = parseFloat(c.req.query('threshold') ?? '0.5')
    const days = parseIntParam(c.req.query('days'), 90)
    try {
      const items = usageTracker.getHighFailureWorkflows(threshold, days)
      return c.json({ items, threshold, days })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /usage/all?days=30
  router.get('/usage/all', rateLimitDefault, (c) => {
    if (!usageTracker) return c.json({ error: 'Usage tracker not available' }, 503)
    const days = parseIntParam(c.req.query('days'), 30)
    try {
      const items = usageTracker.listAllWorkflowStats(days)
      return c.json({ items, days })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  return router
}
