// packages/server/src/routes/tasks.ts
//
// /api/tasks routes — first-class tasks domain (v2-D1). Mirrors the scheduler
// routes factory pattern (createSchedulerRoutes): a pure route layer that
// delegates to TasksService, classifies errors to HTTP status, and never
// touches the DB directly. The SSE endpoint subscribes to the global
// 'taskpool' channel (same channel scheduler emits schedule_status on; 03's
// listener emits task_status + spec_field_update here too).

import { Hono } from "hono"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { z, ZodError } from "zod"
import {
  TasksService,
  TaskNotFoundError,
  TaskVersionConflictError,
  TaskStatusConflictError,
  TaskSpecFieldError,
  TaskReadyGateError,
  type CreateTaskInput,
  type UpdateTaskInput,
  type UpdateSpecFieldInput,
  type ServerSpecField,
} from "../services/tasks/tasks-service"
import { SSEService } from "../services/sse"
import {
  taskSpecSchema,
  resourceRefSchema,
  type TaskStatus,
} from "@octopus/shared"

// ── Error Classification ────────────────────────────────────────────

function classifyError(err: unknown): { status: number; message: string } {
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { status: 400, message: details }
  }
  if (err instanceof TaskNotFoundError) return { status: 404, message: err.message }
  if (err instanceof TaskVersionConflictError) return { status: 409, message: err.message }
  if (err instanceof TaskStatusConflictError) return { status: 409, message: err.message }
  if (err instanceof TaskSpecFieldError) return { status: 400, message: err.message }
  const msg = err instanceof Error ? err.message : String(err)
  return { status: 500, message: msg }
}

async function safeJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

// ── Route Factory ───────────────────────────────────────────────────

export function createTasksRoutes(service: TasksService, sse: SSEService): Hono {
  const router = new Hono()
  // SSE route — MUST be registered BEFORE /:id below. Hono v4 matches
  // routes in registration order; a /:id registered first shadows the
  // literal /events (returns 404 "Task not found" for /api/tasks/events).
  // Verified by Phase-4 E2E. See ticket 12.
  // ── SSE ────────────────────────────────────────────────────────

  // GET /events — task_status + spec_field_update on the 'taskpool' channel.
  // Mirrors taskpoolEventRoutes (routes/events.ts) so the /tasks kanban can
  // subscribe at /api/tasks/events without coupling to the scheduler path.
  router.get("/events", (c) => {
    return streamSSE(c, async (stream) => {
      // Immediate heartbeat so the client's fetch/EventSource resolves within
      // milliseconds instead of waiting up to 30s for the first periodic
      // heartbeat. Without this, the SpecPanel's EventSource stays in
      // CONNECTING state + misses early spec_field_update events (the
      // Phase-4 Story-C test 12 failure). Hono's streamSSE flushes response
      // headers on the first writeSSE, so this also opens the connection.
      await stream.writeSSE({
        event: "heartbeat",
        data: JSON.stringify({ ts: new Date().toISOString(), hello: true }),
      })
      const unsub = sse.subscribe("taskpool", (event) => {
        stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) })
      })
      const interval = setInterval(() => {
        stream.writeSSE({
          event: "heartbeat",
          data: JSON.stringify({ ts: new Date().toISOString() }),
        })
      }, 30000)
      stream.onAbort(() => {
        unsub()
        clearInterval(interval)
      })
      while (true) {
        await stream.sleep(1000)
      }
    })
  })


  // ── CRUD ──────────────────────────────────────────────────────

  // POST / — create a draft task
  router.post("/", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input: CreateTaskInput = {
        org: typeof body.org === "string" ? body.org : "default",
        name: typeof body.name === "string" ? body.name : undefined,
        source_chat_session_id:
          typeof body.source_chat_session_id === "string"
            ? body.source_chat_session_id
            : body.source_chat_session_id === null
              ? null
              : undefined,
      }
      const task = service.createTask(input)
      return c.json(task, 201)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET / — list (kanban); ?status=&org=
  router.get("/", (c) => {
    try {
      const statusParam = c.req.query("status") as TaskStatus | undefined
      const orgParam = c.req.query("org")
      const result = service.listTasks({
        status: statusParam,
        org: orgParam,
      })
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /:id — detail (task + children schedules)
  router.get("/:id", (c) => {
    try {
      const task = service.getTask(c.req.param("id"))
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // PUT /:id — update ([save draft]) with If-Match optimistic locking
  router.put("/:id", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    const ifMatch = c.req.header("if-match")
    if (!ifMatch) {
      return c.json({ error: "If-Match header is required for optimistic locking" }, 428)
    }
    const version = parseInt(ifMatch, 10)
    if (!Number.isFinite(version)) {
      return c.json({ error: "If-Match header must be a valid integer" }, 400)
    }
    try {
      const input: UpdateTaskInput = {}
      if (typeof body.name === "string") input.name = body.name
      if (body.task_spec !== undefined) input.task_spec = taskSpecSchema.parse(body.task_spec)
      if (body.skills !== undefined) input.skills = z.array(z.string()).parse(body.skills)
      if (body.project_ids !== undefined) input.project_ids = z.array(z.string()).parse(body.project_ids)
      if (body.resources !== undefined) input.resources = z.array(resourceRefSchema).parse(body.resources)
      if (body.authoring_resources !== undefined) input.authoring_resources = z.array(resourceRefSchema).parse(body.authoring_resources)
      if (body.workflow_ref !== undefined) {
        input.workflow_ref = typeof body.workflow_ref === "string" ? body.workflow_ref : null
      }
      const task = service.updateTask(c.req.param("id"), input, version)
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // DELETE /:id — soft-delete (discard draft/ready) + cascade-reap schedules
  router.delete("/:id", (c) => {
    try {
      const result = service.deleteTask(c.req.param("id"))
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Actions ───────────────────────────────────────────────────

  // POST /:id/spec-field — agent update_task_spec_field tool endpoint OR user
  // direct edit (05, SW-BP4) → merge field + emit spec_field_update SSE. The
  // optional `source` flag (default "agent") routes user-direct edits through
  // the @@spec_updated notice so the agent reconciles next turn; agent edits
  // don't set the notice.
  router.post("/:id/spec-field", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const field = body.field as ServerSpecField
      // source: "user" → record @@spec_updated notice; anything else (incl.
      // omitted — the existing agent-curl / E2E-helper callers, AC5) → "agent",
      // no notice. Lenient default-to-agent keeps backward compat.
      const source = body.source === "user" || body.source === "agent" ? body.source : "agent"
      const input: UpdateSpecFieldInput = { field, value: body.value, source }
      const result = service.updateSpecField(c.req.param("id"), input)
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/ready — draft→ready + dispatch seam (creates schedules envelope).
  // 05 (D18): a v3 task whose confirmation gate fails → 409 + missing-items
  // list so the UI can show exactly what to confirm before enqueue (US6).
  router.post("/:id/ready", (c) => {
    try {
      const task = service.readyTask(c.req.param("id"))
      return c.json(task)
    } catch (err: unknown) {
      if (err instanceof TaskReadyGateError) {
        return c.json({ error: err.message, missing: err.missing }, 409)
      }
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/abort — running→aborted + ws cleanup (v1 G4)
  router.post("/:id/abort", async (c) => {
    try {
      const task = await service.abortTask(c.req.param("id"))
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })


  return router
}
