import type { Context, Next } from "hono"
import { ResourceError, SAFE_NAME_RE } from "@octopus/shared"

// ── requireJsonContentType ─────────────────────────────────────────────────
// POST/PUT must send application/json. 415 on violation.

export async function requireJsonContentType(c: Context, next: Next): Promise<void> {
  if (c.req.method === "POST" || c.req.method === "PUT") {
    const ct = c.req.header("content-type") ?? ""
    if (!ct.includes("application/json")) {
      throw new ResourceError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json")
    }
  }
  await next()
}

// ── validateResourceParams ──────────────────────────────────────────────────
// URL params :type and :name must pass SAFE_NAME_RE / type enum.

const VALID_TYPES = new Set(["skill", "agent", "workflow"])

export function validateTypeParam(type: string): void {
  if (!VALID_TYPES.has(type)) {
    throw new ResourceError("INVALID_TYPE", `Invalid type: ${type}`, {
      suggestion: "Type must be one of: skill, agent, workflow",
    })
  }
}

export function validateNameParam(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new ResourceError("INVALID_NAME", `Invalid resource name: ${name}`, {
      suggestion: "Name must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$",
    })
  }
}

// ── withResourceLock ───────────────────────────────────────────────────────
// Server-level concurrent lock per org:resourceName (R1 fix).
// Wraps install/uninstall; rejects if another operation is in-flight.

const LOCK_TIMEOUT_MS = 30_000
const activeLocks = new Map<string, Promise<void>>()

export async function withResourceLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (activeLocks.has(lockKey)) {
    throw new ResourceError("LOCK_BUSY", `Operation in progress for ${lockKey}`, {
      suggestion: "Wait for current operation to complete and retry",
    })
  }

  let release!: () => void
  const lockPromise = new Promise<void>((resolve) => {
    release = resolve
  })
  activeLocks.set(lockKey, lockPromise)

  const timeout = setTimeout(() => {
    activeLocks.delete(lockKey)
    release()
  }, LOCK_TIMEOUT_MS)

  try {
    return await fn()
  } finally {
    clearTimeout(timeout)
    activeLocks.delete(lockKey)
    release()
  }
}

// ── withErrorCatch ──────────────────────────────────────────────────────────
// Wraps route handlers: ResourceError → structured JSON; unknown → 500 (no leak).

export function withErrorCatch(handler: (c: Context) => Promise<Response>) {
  return async (c: Context) => {
    try {
      return await handler(c)
    } catch (err) {
      if (err instanceof ResourceError) {
        return c.json(err.toJSON(), err.status)
      }
      // Password oracle prevention: never leak internal details
      return c.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Internal server error",
            suggestion: "Check server logs.",
          },
        },
        500,
      )
    }
  }
}
