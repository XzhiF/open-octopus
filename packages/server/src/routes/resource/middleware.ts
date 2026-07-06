import { isTrustedOrigin, requireJsonContentType } from "@octopus/shared"
import type { Context, Next } from "hono"

export async function resourceCors(c: Context, next: Next): Promise<Response | void> {
  const origin = c.req.header("Origin") ?? ""
  if (origin && isTrustedOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin)
    c.header("Access-Control-Allow-Methods", "GET, POST")
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Octopus-Org")
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204)
  }
  return next()
}

export async function requireJsonBody(c: Context, next: Next): Promise<Response | void> {
  if (c.req.method === "POST") {
    const ct = c.req.header("Content-Type")
    if (!requireJsonContentType(ct)) {
      return c.json(
        { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" } },
        415,
      )
    }
  }
  return next()
}
