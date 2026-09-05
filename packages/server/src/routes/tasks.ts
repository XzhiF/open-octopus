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
  type AcceptanceInput,
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

// task-phase-redesign (ticket 07): POST /:id/acceptance body. A ZodError here
// maps to 400 through classifyError (body defect), while the service's own
// rejections are TaskStatusConflictError → 409 (state defect) — the two are
// deliberately different so 票 12 can tell "fix the form" from "someone else
// decided first".
const acceptanceBodySchema = z
  .object({
    phase_index: z.number().int().min(1),
    round_index: z.number().int().min(1),
    decision: z.enum(["accepted", "rejected"]),
    feedback: z.string().max(20000).optional(),
  })
  .superRefine((b, ctx) => {
    // K7/US10: 打回必填反馈文本（agent 判严重度 + 修复流推荐都吃它）。
    if (b.decision === "rejected" && !(b.feedback ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["feedback"],
        message: "decision='rejected' 必须携带非空 feedback",
      })
    }
  })

// 契约修复 (v4 batch spec 编辑面): PUT /:id/home-file body. `content` caps at
// 512_000 chars (a spec.md/brief.md量级 — generous but bounded; the file guard in
// the service additionally whitelists `.scratch/**.md`). ZodError → 400 via
// classifyError.
const homeFileBodySchema = z.object({
  path: z.string().min(1),
  content: z.string().max(512_000),
})

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
  // 契约修复 (v4 直建): the body may also carry task_spec (RAW — service-owned
  // validation, same SW-BP9 discipline as PUT) + top-level project_ids/skills/
  // resources/authoring_resources. `{task_spec:{format:"v4"}, project_ids:[...]}`
  // now creates a v4 draft (with home + snapshot) in one call — this is the
  // POST recipe task-author's SKILL §1 / persona have been advertising.
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
      // 契约修复: v4 create-time fields (route idioms mirror PUT :313-317).
      if (body.task_spec !== undefined) input.task_spec = body.task_spec
      if (body.project_ids !== undefined) input.project_ids = z.array(z.string()).parse(body.project_ids)
      if (body.skills !== undefined) input.skills = z.array(z.string()).parse(body.skills)
      if (body.resources !== undefined) input.resources = z.array(resourceRefSchema).parse(body.resources)
      if (body.authoring_resources !== undefined) input.authoring_resources = z.array(resourceRefSchema).parse(body.authoring_resources)
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

  // ── Home batch-file read/write (契约修复: v4 phase spec.md 审阅/编辑面) ────
  // GET /:id/home-file?path=<rel> — read a `.scratch/**.md` under the task home
  // (the per-phase spec.md). PUT /:id/home-file {path, content} — write/overwrite
  // (creates parents, so a UI-added phase row can seed a spec skeleton). Guards
  // (`.scratch` prefix / `.md` suffix / no-escape / no absolute / task-exists→404 /
  // edit-window→409) live in the service+home service; a body over 512_000 chars
  // → 400 via homeFileBodySchema. Errors classify through the shared
  // ArtifactAccessError (FORBIDDEN 403 / NOT_FOUND 404) path already wired below.
  router.get("/:id/home-file", (c) => {
    const requestedPath = c.req.query("path")
    if (!requestedPath || !requestedPath.trim()) {
      return c.json({ error: "Query param 'path' is required" }, 400)
    }
    try {
      const result = service.readHomeFile(c.req.param("id"), requestedPath)
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  router.put("/:id/home-file", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const parsed = homeFileBodySchema.parse(body)
      const result = service.writeHomeFile(c.req.param("id"), parsed.path, parsed.content)
      return c.json(result)
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

  // POST /:id/acceptance — the v4 phase 验收 Gate (task-phase-redesign ticket
  // 07, K3/K6/K7). Body {phase_index, round_index, decision, feedback?}:
  //   accepted ∧ i<n ∧ autoAdvance → 下一 phase round 1 开跑 (next_action
  //     'dispatched'); autoAdvance=false → 'awaiting_manual_trigger' (人工起)
  //   accepted ∧ i=n               → 持久态 'archiving' (票 08 编排到 done)
  //   rejected (feedback 必填)      → fix-feedback-r{N}.md 进批次目录 + 同 phase
  //     新 round 开跑
  // 409 = 派生态非待验收 / round 不匹配 / 该轮已验收 / 非 v4（state conflict,
  // not a body defect — the client re-GETs /:id's `derived` view and re-opens the
  // gate on whatever round is now awaiting）; 404 任务不存在; 400 body 非法
  // （含 rejected 缺 feedback — K7「打回必填反馈文本」由 superRefine 拦）。
  router.post("/:id/acceptance", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const parsed = acceptanceBodySchema.parse(body)
      const input: AcceptanceInput = {
        phase_index: parsed.phase_index,
        round_index: parsed.round_index,
        decision: parsed.decision,
        ...(parsed.feedback !== undefined ? { feedback: parsed.feedback } : {}),
      }
      const result = await service.acceptance(c.req.param("id"), input)
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/archive/retry — 票 08 archiving 幂等续跑 (project 粒度, K11/US15).
  // ONLY the persisted 'archiving' state is retryable (409 otherwise; 404
  // unknown). 202: the orchestration (ADR 顺延 / 术语 append / commit / push /
  // PR → done) continues ASYNC — the board reflects completion via the
  // task_status SSE ('done'), not this response. A retry while a run is still
  // in flight is idempotent (the in-flight run is reused).
  router.post("/:id/archive/retry", (c) => {
    try {
      const task = service.retryArchive(c.req.param("id"))
      return c.json({ ok: true, task_id: task.id, status: task.status }, 202)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/advance — 票 07 移交裁决：auto_advance=false 的人工「起下一
  // phase」入口（也覆盖「上 phase 已 accepted 但派发失败」的续跑）。200 同
  // acceptance 的 dispatched 形状；409 = 非 v4 / 不存在「前序 accepted ∧ 该
  // phase pending」的派生窗口（首 phase 请走 /:id/trigger，K6 不变）。
  router.post("/:id/advance", async (c) => {
    try {
      const result = await service.advancePhase(c.req.param("id"))
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

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

  // POST /:id/trigger — v39 manual/time trigger: arms the parked (draft) root
  // envelope draft→queued with scheduled_at = at ?? now. Body: { at?: ISO8601 }
  // (absent = 立即触发; future = 单次定时; past = 尽快). Same-task mutex is
  // structural: only a ready task with a draft root can arm (409 otherwise).
  router.post("/:id/trigger", async (c) => {
    const body = await safeJson(c)
    let at: string | undefined
    if (body && body.at !== undefined && body.at !== null) {
      const parsed = z.string().datetime({ offset: true }).safeParse(body.at)
      if (!parsed.success) return c.json({ error: "at must be an ISO8601 datetime" }, 400)
      at = parsed.data
    }
    try {
      const task = service.triggerTask(c.req.param("id"), at)
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/trigger/cancel — withdraw an armed-but-not-started one-shot
  // (queued, unclaimed, future due) back to parked draft; task returns to
  // ready. Already claimed/executing → 409.
  router.post("/:id/trigger/cancel", (c) => {
    try {
      const task = service.cancelTaskTrigger(c.req.param("id"))
      return c.json(task)
    } catch (err: unknown) {
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
