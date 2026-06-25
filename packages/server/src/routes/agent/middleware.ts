import type { Context, Next } from 'hono'
import type { AgentErrorResponse } from '@octopus/shared'
import { NotImplementedError } from '../../services/agent/agent-service'
import { OrgDAO } from '../../db/dao'

// ── DAO reference for auth middleware ────────────────────────────
let _orgDAO: OrgDAO | null = null

export function setAgentAuthOrgDAO(dao: OrgDAO): void {
  _orgDAO = dao
}

// ── Error code → HTTP status mapping ─────────────────────────────

const ERROR_STATUS_MAP: Record<string, number> = {
  INVALID_PARAM: 400,
  INVALID_CRON: 400,
  INVALID_ORG_NAME: 400,
  PERSONA_TOO_LONG: 413,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  DANGEROUS_BLOCKED: 403,
  ORG_NOT_FOUND: 403,
  NOT_FOUND: 404,
  SAFE_MODE_READONLY: 409,
  CLONE_BUSY: 409,
  MEMORY_CONFLICT: 409,
  MAX_CLONES_EXCEEDED: 409,
  BACKUP_MISSING: 409,
  BUILTIN_MISSING: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  DB_LOCKED: 503,
  SUBSYSTEM_UNAVAILABLE: 503,
  PROVIDER_TIMEOUT: 504,
  NOT_IMPLEMENTED: 501,
}

export function mapErrorToStatus(code: string): number {
  return ERROR_STATUS_MAP[code] ?? 500
}

export function createAgentError(
  code: string,
  message: string,
  details?: unknown,
): AgentErrorResponse {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  }
}

// ── Error middleware ──────────────────────────────────────────────

/**
 * Agent error middleware — catches errors and formats them as AgentErrorResponse.
 */
export async function agentErrorMiddleware(c: Context, next: Next): Promise<void> {
  try {
    await next()
  } catch (err: unknown) {
    if (err instanceof NotImplementedError) {
      const body = createAgentError('NOT_IMPLEMENTED', err.message)
      c.status(501)
      c.header('Content-Type', 'application/json')
      await c.body(JSON.stringify(body))
      return
    }

    const error = err instanceof Error ? err : new Error(String(err))
    const code: string = (error as { code?: string }).code ?? 'INTERNAL_ERROR'
    const status = mapErrorToStatus(code)
    const body = createAgentError(code, error.message)

    if (status >= 500) {
      console.error(`[agent] ${code}: ${error.message}`, error.stack)
    }

    c.status(status)
    c.header('Content-Type', 'application/json')
    await c.body(JSON.stringify(body))
  }
}

// ── Auth middleware (placeholder) ─────────────────────────────────

/**
 * Auth middleware — validates Bearer token and org existence.
 */
export async function agentAuthMiddleware(c: Context, next: Next): Promise<void> {
  const authHeader = c.req.header('Authorization')

  // Health endpoint is exempt from auth (handled before this middleware)
  // All other endpoints require Authorization header
  if (!authHeader) {
    c.res = c.json(createAgentError('UNAUTHORIZED', 'Authorization header is required'), 401)
    return
  }

  if (!authHeader.startsWith('Bearer ')) {
    c.res = c.json(createAgentError('UNAUTHORIZED', 'Invalid Authorization header format'), 401)
    return
  }

  // Validate org existence when X-Octopus-Org header is provided
  const orgHeader = c.req.header('X-Octopus-Org')
  if (orgHeader && orgHeader.trim() !== '') {
    try {
      if (_orgDAO && !_orgDAO.exists(orgHeader)) {
        c.res = c.json(createAgentError('ORG_NOT_FOUND', `Organization "${orgHeader}" not found`), 403)
        return
      }
    } catch (err: unknown) {
      // Fail closed: return 503 when DB check fails (do not silently allow)
      const msg = err instanceof Error ? err.message : String(err)
      c.res = c.json(createAgentError('SUBSYSTEM_UNAVAILABLE', `Organization validation failed: ${msg}`), 503)
      return
    }
  }

  await next()
}
