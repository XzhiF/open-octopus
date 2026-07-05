import type { Context } from "hono"
import { logError } from "../file-logger"
import { ResourceError } from "@octopus/shared"

export function errorHandler(err: Error, c: Context) {
  // HV-3 fix: Properly handle ResourceError with code + suggestion fields
  if (err instanceof ResourceError) {
    if (err.status >= 500) {
      logError(`HTTP ${err.status} ${c.req.method} ${c.req.path}: ${err.code}`, err)
    }
    return c.json(
      { error: err.message, code: err.code, suggestion: err.suggestion },
      err.status,
    )
  }

  const status = (err as any).status || 500

  // Log to file (non-4xx errors only — 4xx are expected client errors)
  if (status >= 500) {
    logError(`HTTP ${status} ${c.req.method} ${c.req.path}`, err, {
      method: c.req.method,
      path: c.req.path,
      status,
    })
  }

  console.error(`Error: ${err.message}`)
  return c.json({ error: err.message || "Internal Server Error" }, status)
}