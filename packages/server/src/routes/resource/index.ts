import { Hono, type Context } from "hono"
import fs from "fs"
import path from "path"
import {
  ResourceError,
  InstallRequestSchema,
  UninstallRequestSchema,
  type ResourceType,
} from "@octopus/shared"
import type { ResourceManager } from "@octopus/shared"
import {
  requireJsonContentType,
  validateTypeParam,
  validateNameParam,
  withResourceLock,
  withErrorCatch,
} from "./middleware"

/**
 * Resource routes — 10 REST endpoints for unified resource management.
 * Route factory pattern: accepts a getter `(org) => ResourceManager`.
 * Org is resolved from `?org=` query param on every request.
 *
 * Security middleware chain:
 *   requireJsonContentType (POST) → validateResourceParams (URL) → withResourceLock (POST install/uninstall)
 */

export function createResourceRoutes(
  getManager: (org: string) => ResourceManager,
): Hono {
  const app = new Hono()

  // Apply content-type guard to all routes under this sub-app
  app.use("*", requireJsonContentType)

  // ── Helpers ──────────────────────────────────────────────────────────────

  function org(c: Context): string {
    return (c.req.query("org") as string) || "default"
  }

  /**
   * Translate ResourceManager error codes to API-contract codes.
   * - RESOURCE_ALREADY_EXISTS → ALREADY_INSTALLED (409)
   * - LOCK_BUSY               → RESOURCE_LOCKED   (409)
   */
  function mapError(err: unknown): never {
    if (err instanceof ResourceError) {
      if (err.code === "RESOURCE_ALREADY_EXISTS") {
        throw new ResourceError("ALREADY_INSTALLED", err.message, {
          suggestion: "Uninstall first or use --force",
        })
      }
      if (err.code === "LOCK_BUSY") {
        throw new ResourceError("RESOURCE_LOCKED", err.message, {
          suggestion: "Retry after current operation completes",
        })
      }
    }
    throw err
  }

  // ── GET / — List resources ───────────────────────────────────────────────
  app.get("/", withErrorCatch(async (c) => {
    const manager = getManager(org(c))
    const type = c.req.query("type") as ResourceType | undefined
    const query = c.req.query("query") as string | undefined
    const installedParam = c.req.query("installed") as string | undefined

    const filter: { type?: ResourceType; query?: string; installed?: boolean } = {}
    if (type && ["skill", "agent", "workflow"].includes(type)) filter.type = type
    if (query) filter.query = query
    if (installedParam !== undefined) filter.installed = installedParam === "true"

    return c.json(manager.list(filter))
  }))

  // ── GET /stats — Statistics ──────────────────────────────────────────────
  app.get("/stats", withErrorCatch(async (c) => {
    return c.json(getManager(org(c)).stats())
  }))

  // ── GET /audit — Audit log (time-descending) ────────────────────────────
  app.get("/audit", withErrorCatch(async (c) => {
    const manager = getManager(org(c))
    const action = c.req.query("action") as string | undefined
    const lastParam = c.req.query("last") as string | undefined
    const last = lastParam ? parseInt(lastParam, 10) : undefined

    const VALID_ACTIONS = new Set(["install", "uninstall", "verify", "install_blocked", "verify_warn", "verify_fail"])
    const filter: { action?: string; last?: number } = {}
    if (action && VALID_ACTIONS.has(action)) filter.action = action
    if (last && last > 0 && last <= 1000) filter.last = last

    const records = manager.auditQuery(filter)
    return c.json({ records, total: records.length })
  }))

  // ── GET /builtin — Available builtin catalog ─────────────────────────────
  app.get("/builtin", withErrorCatch(async (c) => {
    const manager = getManager(org(c))
    const catalog = manager.listBuiltin().map((entry) => ({
      ...entry,
      installed: manager.get(entry.type, entry.name) !== null,
    }))
    return c.json({ resources: catalog, total: catalog.length })
  }))

  // ── POST /install — Install resource ─────────────────────────────────────
  app.post("/install", withErrorCatch(async (c) => {
    const o = org(c)
    const manager = getManager(o)

    const body = await c.req.json()
    const parsed = InstallRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ResourceError("INVALID_REF", parsed.error.issues[0]?.message ?? "Invalid request", {
        suggestion: "Use format: builtin:{name} or local:{path}",
      })
    }

    // Server-level lock: `${org}:${name}` to serialize concurrent install/uninstall.
    // Key uses resource name (not ref/type) so install and uninstall lock the same resource.
    const refName = parsed.data.ref.replace(/^[^:]+:/, "")
    const result = await withResourceLock(`${o}:${refName}`, async () => {
      try {
        return await manager.install({ ...parsed.data, caller: "ui" })
      } catch (err) { mapError(err) }
    })

    return c.json(result)
  }))

  // ── POST /uninstall — Uninstall resource ─────────────────────────────────
  app.post("/uninstall", withErrorCatch(async (c) => {
    const o = org(c)
    const manager = getManager(o)

    const body = await c.req.json()
    const parsed = UninstallRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ResourceError("INVALID_NAME", parsed.error.issues[0]?.message ?? "Invalid request", {
        suggestion: "Provide valid name and type",
      })
    }

    const result = await withResourceLock(`${o}:${parsed.data.name}`, async () => {
      try {
        return await manager.uninstall({ ...parsed.data, caller: "ui" })
      } catch (err) { mapError(err) }
    })

    return c.json(result)
  }))

  // ── GET /:type/:name — Detail ────────────────────────────────────────────
  app.get("/:type/:name", withErrorCatch(async (c) => {
    const type = c.req.param("type")
    const name = c.req.param("name")
    validateTypeParam(type)
    validateNameParam(name)

    const manager = getManager(org(c))
    const entry = manager.get(type as ResourceType, name)
    if (!entry) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource ${type}/${name} not found`)
    }
    return c.json(entry)
  }))

  // ── GET /:type/:name/verify — Verify ─────────────────────────────────────
  app.get("/:type/:name/verify", withErrorCatch(async (c) => {
    const type = c.req.param("type")
    const name = c.req.param("name")
    validateTypeParam(type)
    validateNameParam(name)

    const manager = getManager(org(c))
    const entry = manager.get(type as ResourceType, name)
    if (!entry) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource ${type}/${name} not found`)
    }

    const result = manager.verify(type as ResourceType, name)
    // Map to API contract shape: { name, type, verify: { status, steps } }
    return c.json({
      name,
      type,
      verify: {
        status: result.passed ? "installed" : "installed_but_unverified",
        steps: result.steps.map((s) => ({
          name: s.step,
          status: s.passed ? "pass" : "warn",
          message: s.message,
        })),
      },
    })
  }))

  // ── GET /:type/:name/files — File list + content ─────────────────────────
  app.get("/:type/:name/files", withErrorCatch(async (c) => {
    const type = c.req.param("type")
    const name = c.req.param("name")
    validateTypeParam(type)
    validateNameParam(name)

    const manager = getManager(org(c))
    const entry = manager.get(type as ResourceType, name)
    if (!entry) {
      throw new ResourceError("RESOURCE_NOT_FOUND", `Resource ${type}/${name} not found`)
    }

    const filePath = c.req.query("path") as string | undefined

    if (filePath) {
      // Security: isPathWithinBase checked inside readFile
      const content = manager.readFile(type as ResourceType, name, filePath)
      return c.json({ path: filePath, content, size: Buffer.byteLength(content, "utf-8") })
    }

    // List all files with metadata
    const paths = manager.listFiles(type as ResourceType, name)
    const files = paths.map((p: string) => {
      try {
        const abs = path.join(entry.installPath, p)
        const stat = fs.statSync(abs)
        return { path: p, size: stat.size }
      } catch {
        return { path: p, size: 0 }
      }
    })
    return c.json({ name, type, files })
  }))

  return app
}
