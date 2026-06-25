import { Hono } from "hono"
import { ZodError } from "zod"
import { WorkspaceScheduleService } from "../services/schedule"

const scheduleRoutes = new Hono()

let _scheduleService: WorkspaceScheduleService | null = null
export function setScheduleService(svc: WorkspaceScheduleService) { _scheduleService = svc }

function getSvc(): WorkspaceScheduleService {
  if (!_scheduleService) throw new Error("WorkspaceScheduleService not initialized")
  return _scheduleService
}

function getWsId(c: any): string { return c.req.param("id") }

/** Custom error classes for type-safe HTTP status classification */
class ScheduleNotFoundError extends Error {
  constructor(message = "Schedule not found") { super(message); this.name = "ScheduleNotFoundError" }
}
class ScheduleConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleConflictError" }
}
class ScheduleValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ScheduleValidationError" }
}

/** Classify service errors into proper HTTP status codes */
function classifyError(err: unknown): { status: number; message: string } {
  // Zod validation errors → 400
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    return { status: 400, message: details }
  }

  // Typed error classes
  if (err instanceof ScheduleNotFoundError) return { status: 404, message: err.message }
  if (err instanceof ScheduleConflictError) return { status: 409, message: err.message }
  if (err instanceof ScheduleValidationError) return { status: 400, message: err.message }

  // Fallback: keyword matching for legacy errors
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes("not found") || msg.includes("不存在") || msg.includes("已被删除")) {
    return { status: 404, message: msg }
  }
  if (msg.includes("已存在") || msg.includes("正在运行")) {
    return { status: 409, message: msg }
  }
  if (msg.includes("Cron") || msg.includes("时区") || msg.includes("验证") || msg.includes("通知") || msg.includes(">=") || msg.includes("<=") || msg.includes("Invalid input") || msg.includes("expected") || msg.includes("invalid_type") || msg.includes("too_small") || msg.includes("too_big") || msg.includes("must contain") || msg.includes("must be")) {
    return { status: 400, message: msg }
  }
  return { status: 500, message: msg }
}

/** Safely parse JSON body, returning error response or null */
async function safeJson(c: any): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

// GET / — list schedules
scheduleRoutes.get("/", (c) => {
  const wsId = getWsId(c)
  const search = c.req.query("search")
  const status = c.req.query("status")
  return c.json(getSvc().list(wsId, { search, status }))
})

// POST / — create schedule
scheduleRoutes.post("/", async (c) => {
  const wsId = getWsId(c)
  const body = await safeJson(c)
  if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
  try {
    const schedule = getSvc().create(wsId, body)
    return c.json(schedule, 201)
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

// GET /audit-logs — must be before /:sid
scheduleRoutes.get("/audit-logs", (c) => {
  const wsId = getWsId(c)
  const rawPage = parseInt(c.req.query("page") ?? "1")
  const rawLimit = parseInt(c.req.query("pageSize") ?? c.req.query("limit") ?? "20")
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20
  return c.json(getSvc().listAuditLogs(wsId, { page, limit }))
})

// GET /permissions — must be before /:sid
scheduleRoutes.get("/permissions", (c) => {
  return c.json(getSvc().getPermissions(getWsId(c)))
})

// POST /emergency-stop — must be before /:sid to avoid matching as schedule ID
scheduleRoutes.post("/emergency-stop", (c) => {
  const wsId = getWsId(c)
  const result = getSvc().emergencyStop(wsId)
  // Return both keys for backward compatibility
  return c.json({ ...result, stopped: result.disabled_count })
})

// GET /:sid — get schedule
scheduleRoutes.get("/:sid", (c) => {
  const schedule = getSvc().getById(getWsId(c), c.req.param("sid"))
  if (!schedule) return c.json({ error: "Not found" }, 404)
  if (schedule.deleted_at) return c.json({ error: "调度已被删除" }, 410)
  return c.json(schedule)
})

// PATCH /:sid — update schedule
scheduleRoutes.patch("/:sid", async (c) => {
  const body = await safeJson(c)
  if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
  try {
    return c.json(getSvc().update(getWsId(c), c.req.param("sid"), body))
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

// DELETE /:sid — soft delete
scheduleRoutes.delete("/:sid", (c) => {
  try {
    getSvc().delete(getWsId(c), c.req.param("sid"))
    return c.json({ success: true })
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

// POST /:sid/enable
scheduleRoutes.post("/:sid/enable", (c) => {
  try {
    return c.json(getSvc().enable(getWsId(c), c.req.param("sid")))
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

// POST /:sid/disable
scheduleRoutes.post("/:sid/disable", (c) => {
  try {
    return c.json(getSvc().disable(getWsId(c), c.req.param("sid")))
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

// POST /:sid/trigger — manual trigger
scheduleRoutes.post("/:sid/trigger", (c) => {
  try {
    const result = getSvc().trigger(getWsId(c), c.req.param("sid"), 'manual')
    if (result === null) {
      return c.json({ error: "调度正在运行中，跳过本次触发" }, 409)
    }
    return c.json(result)
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

// POST /:sid/dismiss-alert
scheduleRoutes.post("/:sid/dismiss-alert", (c) => {
  const wsId = getWsId(c)
  const sid = c.req.param("sid")
  try {
    getSvc().dismissAlert(wsId, sid)
    const schedule = getSvc().getById(wsId, sid)
    if (!schedule) return c.json({ success: true })
    return c.json(schedule)
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

// GET /:sid/executions — execution history
scheduleRoutes.get("/:sid/executions", (c) => {
  const rawPage = parseInt(c.req.query("page") ?? "1")
  const rawLimit = parseInt(c.req.query("pageSize") ?? c.req.query("limit") ?? "20")
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20
  return c.json(getSvc().listExecutions(getWsId(c), c.req.param("sid"), { page, limit }))
})

// POST /:sid/executions/:eid/retry
scheduleRoutes.post("/:sid/executions/:eid/retry", (c) => {
  try {
    return c.json(getSvc().retryExecution(getWsId(c), c.req.param("sid"), c.req.param("eid")))
  } catch (err: unknown) {
    const { status, message } = classifyError(err)
    return c.json({ error: message }, status)
  }
})

export default scheduleRoutes
