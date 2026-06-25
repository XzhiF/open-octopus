import type { Context } from "hono"
import { logError } from "../file-logger"

export function errorHandler(err: Error, c: Context) {
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