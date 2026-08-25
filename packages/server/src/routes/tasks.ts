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
import fs from "fs"
import path from "path"
import {
  TasksService,
  TaskNotFoundError,
  TaskVersionConflictError,
  TaskStatusConflictError,
  TaskSpecFieldError,
  TaskReadyGateError,
  TaskLockViolationError,
  ArtifactAccessError,
  type CreateTaskInput,
  type UpdateTaskInput,
  type UpdateSpecFieldInput,
  type ServerSpecField,
} from "../services/tasks/tasks-service"
import { AssistWorkflowService, AssistWorkflowError } from "../services/tasks/assist-workflow-service"
import { SSEService } from "../services/sse"
import { TaskHomeService } from "../services/tasks/task-home-service"
import {
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
  // 04 (SW-BP9): skill_groups/task_type locked at creation → 409 (not 400 — the
  // task exists and is editable; only these two fields are immutable).
  if (err instanceof TaskLockViolationError) return { status: 409, message: err.message }
  if (err instanceof TaskSpecFieldError) return { status: 400, message: err.message }
  // 06 (US7): artifact content whitelist + missing-file classification. The
  // code field carries FORBIDDEN (403 — path not whitelisted / escape attempt)
  // vs NOT_FOUND (404 — whitelisted but file missing on disk, AC4).
  if (err instanceof ArtifactAccessError) {
    switch (err.code) {
      case "FORBIDDEN": return { status: 403, message: err.message }
      case "NOT_FOUND": return { status: 404, message: err.message }
    }
  }
  // 07: assist-workflow template/run classification.
  if (err instanceof AssistWorkflowError) {
    switch (err.code) {
      case "INVALID_TEMPLATE": return { status: 400, message: err.message }
      case "TASK_NOT_FOUND": return { status: 404, message: err.message }
      case "RUN_NOT_FOUND": return { status: 404, message: err.message }
      case "RUN_MISMATCH": return { status: 403, message: err.message }
    }
  }
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

export function createTasksRoutes(
  service: TasksService,
  sse: SSEService,
  assistService?: AssistWorkflowService,
): Hono {
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

  // POST / — create a draft task. 04 (D13/D15): the two-phase-flow template page
  // sends source_chat_session_id (created first, D15) + task_type + skill_groups[]
  // + preset{org,projects}. Legacy callers (no task_type) take the v2 path.
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
      // 04 (D13): task_type selects the template (coding/generic); present ⇒ v3.
      if (body.task_type === "coding" || body.task_type === "generic") {
        input.task_type = body.task_type
      }
      // 04 (D2/D3): skill groups chosen at creation then LOCKED (ADR-0012).
      if (Array.isArray(body.skill_groups)) {
        input.skill_groups = body.skill_groups.filter(
          (s: unknown) => typeof s === "string" && s.length > 0,
        )
      }
      // 04 (D13): preset = org + projects (coding template; skills belong to
      // workflow.requires, NOT the preset).
      if (body.preset && typeof body.preset === "object") {
        const p = body.preset as { org?: unknown; projects?: unknown }
        input.preset = {}
        if (typeof p.org === "string") input.preset.org = p.org
        if (Array.isArray(p.projects)) {
          input.preset.projects = p.projects.filter(
            (proj: unknown) => typeof proj === "string" && proj.length > 0,
          )
        }
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

  // ── Artifacts (ticket 06 — US7) ────────────────────────────────────
  // GET /:id/artifacts — the artifact index (artifacts.json). Missing file →
  // []; corrupted JSON → [] + warn (SW-BP12); missing task → 404. The index
  // is the single source of truth for "what did this task produce" (ADR-0011).
  router.get("/:id/artifacts", (c) => {
    try {
      const entries = service.listArtifacts(c.req.param("id"))
      return c.json(entries)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /:id/artifacts/content?path= — full artifact content (US7). The
  // `path` query param is required (non-empty string) → 400 when missing;
  // the service then whitelists it (AC2: relative-inside-artifacts no-escape
  // OR registered external=true absolute; else 403) and reads live disk
  // content (AC3) or 404 when the whitelisted file is missing (AC4).
  router.get("/:id/artifacts/content", (c) => {
    const requestedPath = c.req.query("path")
    if (!requestedPath || !requestedPath.trim()) {
      return c.json({ error: "Query param 'path' is required" }, 400)
    }
    try {
      const result = service.readArtifactContent(c.req.param("id"), requestedPath)
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Context file (workspace state visible to agent) ──────────────────
  // GET /:id/context — read the task's context.md + spec.json + filesystem
  // paths. The dynamic workspace state file the agent reads when notified via
  // @@context_updated. Also returns absolute paths for the UI (artifactsDir,
  // homePath) so the frontend can display + copy real filesystem locations.
  // Returns { content, path, artifactsDir, homePath, specContent, specPath }.
  // content/specContent may be null if the file hasn't been created yet.
  router.get("/:id/context", (c) => {
    try {
      const homeService = new TaskHomeService()
      const homePath = homeService.homePath(c.req.param("id"))
      const artifactsDir = homeService.artifactsDir(c.req.param("id"))
      const ctxPath = path.join(homePath, "context.md")
      let content: string | null = null
      if (fs.existsSync(ctxPath)) {
        content = fs.readFileSync(ctxPath, "utf-8")
      }
      const specPath = path.join(homePath, "spec.json")
      let specContent: string | null = null
      if (fs.existsSync(specPath)) {
        specContent = fs.readFileSync(specPath, "utf-8")
      }
      return c.json({ content, path: ctxPath, artifactsDir, homePath, specContent, specPath })
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
      // 04 (SW-BP9): pass the RAW task_spec (not taskSpecSchema.parse'd) so the
      // service can (a) lock-check skill_groups/task_type on the pre-parse
      // values (parse defaults absent skill_groups→[], masking an explicit
      // change) and (b) merge-preserve the locked fields when the body omits
      // them. The service parses + validates (ZodError → 400 via classifyError).
      if (body.task_spec !== undefined) input.task_spec = body.task_spec
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

  // ── Assist workflows (ticket 07 — US9/10/11) ────────────────────
  // POST /:id/assist-workflows — trigger a built-in assist-workflow run
  // (AC3). Body: { template, input? }. Returns { run_id, execution_id,
  // workspace_id, template }. Non-whitelist template → 400.
  router.post("/:id/assist-workflows", async (c) => {
    if (!assistService) return c.json({ error: "Assist workflow service not configured" }, 503)
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    const template = typeof body.template === "string" ? body.template : ""
    try {
      const result = assistService.trigger(c.req.param("id"), template, body.input as never)
      return c.json(result, 200)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /:id/assist-workflows/:runId — run status + process logs + structured
  // output (AC4). Parse failure → output_raw + output_parse_error (SW-BP10),
  // surfaced as fields on the 200 response, not an error status.
  router.get("/:id/assist-workflows/:runId", (c) => {
    if (!assistService) return c.json({ error: "Assist workflow service not configured" }, 503)
    try {
      const run = assistService.getRun(c.req.param("id"), c.req.param("runId"))
      return c.json(run)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // task-workflow-handoff (ADR-0013, US5 / AC8): view the bound workflow's
  // content + source. 200 `{ ref, content, source }` on hit; `{ ref: null,
  // content: null, source: null }` when unbound; 400 when the bound ref is no
  // longer resolvable (uninstalled builtin / missing task-home file); 404 when
  // the task doesn't exist.
  router.get("/:id/workflow-ref", (c) => {
    try {
      const result = service.viewWorkflowRef(c.req.param("id"))
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })


  return router
}
