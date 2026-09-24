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
import { TaskHomeService, MANIFEST_FILENAME, LEGACY_SPEC_FILENAME } from "../services/tasks/task-home-service"
import {
  resourceRefSchema,
  type TaskStatus,
} from "@octopus/shared"
import type { RoundEvidenceService } from "../services/tasks/round-evidence-service"
import { InstanceGateError } from "../services/tasks/round-evidence-service"

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
  // 实例关闭安全闸（2026-09-24）：status 由闸侧裁定（400 非法/宿主端口、
  // 403 未登记端口、409 进程树涉宿主）。
  if (err instanceof InstanceGateError) return { status: err.status, message: err.message }
  // 06 (US7): artifact content whitelist + missing-file classification. The
  // code field carries FORBIDDEN (403 — path not whitelisted / escape attempt)
  // vs NOT_FOUND (404 — whitelisted but file missing on disk, AC4) vs
  // TOO_LARGE (413 — batch evidence file over the read ceiling; a missed case
  // would silently fall through to 500, pinned by tasks-home-file tests).
  if (err instanceof ArtifactAccessError) {
    switch (err.code) {
      case "FORBIDDEN": return { status: 403, message: err.message }
      case "NOT_FOUND": return { status: 404, message: err.message }
      case "TOO_LARGE": return { status: 413, message: err.message }
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
    // ADR-0018 打回二分路由（rejected 生效）：rerun=重跑绑定流（缺省，流内再审
    // spec）；fix=轻量修复轮（server override built-in/task-fix + 合成输入）。
    next_flow: z.enum(["fix", "rerun"]).optional(),
    // ADR-0022 验收台 ✗ 闭环：rejected 时打回的票名基（`NN-e2e-*`），server 把
    // 对应 issues/<name>.md 的 Status done→reopened。路径安全：仅文件名基。
    reopen_tickets: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/)).max(20).optional(),
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

// 剧本探针单发执行体（POST /:id/playbook/run）——command 来自编译票步,人点才跑。
const probeRunBodySchema = z.object({
  command: z.string().min(1).max(4000),
  timeoutS: z.number().int().min(5).max(600).optional(),
})

// ── Route Factory ───────────────────────────────────────────────────

export function createTasksRoutes(
  service: TasksService,
  sse: SSEService,
  assistService?: AssistWorkflowService,
  evidence?: RoundEvidenceService,
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
      // task-board-title 改版: 任务标题创建即必填 — 不再回落 "Untitled task"
      // 等对话/autosave 事后生成。
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return c.json({ error: "name is required: 任务标题必须非空" }, 400)
      }
      const input: CreateTaskInput = {
        org: typeof body.org === "string" ? body.org : "default",
        name: body.name,
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

  // ── Run history (票03/票05 — ADR-0021) ──────────────────────────────
  // GET /:id/executions — this task's runs, newest first. The board's 执行历史 and the
  // 弹窗 drill-down read this instead of the retired envelope's children[]: one row per
  // run (v4 round / composite dispatch), with the phase/round coordinates the acceptance
  // ledger uses and the workspace to deep-link into.
  router.get("/:id/executions", (c) => {
    try {
      const limitParam = c.req.query("limit")
      const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 200) : 50
      const id = c.req.param("id")
      const rows = service.listRunHistory(id, limit)
      return c.json({ items: rows, total: rows.length })
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
  // GET /:id/context — read the task's context.md + manifest.json + filesystem
  // paths. The dynamic workspace state file the agent reads when notified via
  // @@context_updated. Also returns absolute paths for the UI (artifactsDir,
  // homePath) so the frontend can display + copy real filesystem locations.
  // Returns { content, path, artifactsDir, homePath, manifestContent, manifestPath }.
  // content/manifestContent may be null if the file hasn't been created yet.
  // Read fallback: pre-rename homes that never got a snapshot write still have
  // only spec.json on disk — serve it as manifestContent (read-only, never writes).
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
      const manifestPath = path.join(homePath, MANIFEST_FILENAME)
      let manifestContent: string | null = null
      if (fs.existsSync(manifestPath)) {
        manifestContent = fs.readFileSync(manifestPath, "utf-8")
      } else {
        const legacyPath = path.join(homePath, LEGACY_SPEC_FILENAME)
        if (fs.existsSync(legacyPath)) {
          manifestContent = fs.readFileSync(legacyPath, "utf-8")
        }
      }
      return c.json({ content, path: ctxPath, artifactsDir, homePath, manifestContent, manifestPath })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── Home batch-file read/write (v4 spec 审阅/编辑 + 验收证据面) ────────────
  // GET /:id/home-file?path=<rel> — read ANY file under `.scratch/**` (v4
  // acceptance evidence: e2e-data/*.txt, probe/*.json …; read capped at
  // MAX_HOME_FILE_READ_BYTES → 413). ?path=<dir>&list=1 — list the dir's .md
  // files (ADR-0018 spec-family visibility); &all=1 widens the listing to all
  // regular files (acceptance 中列). PUT /:id/home-file {path, content} —
  // write/overwrite, STILL `.md`-only (creates parents, so a UI-added phase row
  // can seed a spec skeleton). Guards (`.scratch` prefix / suffix-by-mode /
  // no-escape / no absolute / task-exists→404 / edit-window→409) live in the
  // service+home service; a body over 512_000 chars → 400 via homeFileBodySchema.
  // Errors classify through ArtifactAccessError (403 / 404 / TOO_LARGE→413).
  router.get("/:id/home-file", (c) => {
    const requestedPath = c.req.query("path")
    if (!requestedPath || !requestedPath.trim()) {
      return c.json({ error: "Query param 'path' is required" }, 400)
    }
    try {
      if (c.req.query("list")) {
        const all = ["1", "true"].includes(c.req.query("all") ?? "")
        return c.json({ files: service.listHomeDir(c.req.param("id"), requestedPath, all) })
      }
      const result = service.readHomeFile(c.req.param("id"), requestedPath)
      return c.json(result)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /:id/batch-tree — draft-artifact visibility (#53): disk-direct scan of
  // the `.scratch/` batch dirs (落盘即现, decoupled from phases[]). No path param
  // (the scan roots from the home layout — no escape surface). Empty `.scratch/`
  // → `{ batches: [] }` 200; only an unknown task 404s.
  router.get("/:id/batch-tree", (c) => {
    try {
      const batches = service.batchTree(c.req.param("id"))
      return c.json({ batches })
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /:id/home-tree — 输出区磁盘直扫（2026-09-24 拍板）：任务 home 的原始
  // 目录树（空目录/全部文件如实呈现）+ 绝对路径。{ dir, entries }。
  router.get("/:id/home-tree", (c) => {
    try {
      return c.json(service.homeTree(c.req.param("id")))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /:id/home-content?path= — 读任务 home 下任意常规文件（目录树查看器；
  // 守卫 = 相对路径不出 home + 512KB 上限，403/404/413 与 home-file 同码）。
  router.get("/:id/home-content", (c) => {
    const requestedPath = c.req.query("path")
    if (!requestedPath || !requestedPath.trim()) {
      return c.json({ error: "Query param 'path' is required" }, 400)
    }
    try {
      return c.json(service.readHomeAnyFile(c.req.param("id"), requestedPath))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── 验货台 (acceptance v2)：实物 round-diff + 当场复检 ──────────────────
  // 服务端按 task id 解析 awaiting round（web 永不见 SHA）；无 evidence 注入
  // （如未装配的测试 app）→ 501 而非崩溃。verify 端点的错误都经 classifyError：
  // 未配置命令 400 / 无 awaiting·在跑·ws 没了 409 / 未知任务 404。
  // 实物 diff。S3（2026-09-20）起支持 ?scope=cumulative：本 phase 首轮 exec 的
  // start 锚 .. 本轮 exec 的 end 锚（放行判的是 phase 终态，修复轮不再只见
  // delta）；缺省/其他值 = round（本轮区间，现行为逐字不变）。payload 形状
  // 两口径完全一致（RoundDiffPayload），web 零解析改动。
  router.get("/:id/round-diff", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    const scope = c.req.query("scope") === "cumulative" ? "cumulative" : "round"
    try {
      return c.json(await evidence.getRoundDiff(c.req.param("id"), scope))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  router.get("/:id/round-diff/patch", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    const repo = c.req.query("repo")
    const filePath = c.req.query("path")
    if (!repo?.trim() || !filePath?.trim()) {
      return c.json({ error: "Query params 'repo' and 'path' are required" }, 400)
    }
    try {
      return c.json(await evidence.getFilePatch(c.req.param("id"), repo, filePath))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // 验收剧本：把 awaiting 轮的契约文件编译成走查清单（派生视图，不入库）。
  // 纯读 + 编译，绝不 spawn；缺料 → available:false 仍 200。无 awaiting → 409。
  router.get("/:id/playbook", (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    try {
      return c.json(evidence.getPlaybook(c.req.param("id")))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // 剧本探针单发执行：票步里的可执行命令（curl/until 级），同步返回 exit+tail
  // 供面板就地盖章。与复检同纪律——只有人点击才执行；GET /playbook 保持纯读。
  router.post("/:id/playbook/run", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    const parsed = probeRunBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, 400)
    }
    try {
      return c.json(await evidence.runProbe(c.req.param("id"), parsed.data.command, parsed.data.timeoutS))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // 复检绝不自动跑 —— 本 POST 是唯一入口（202 = 已起会话，进度走 taskpool SSE：
  // task_verify_log 逐行 + task_verify 终态）。
  router.post("/:id/verify", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    try {
      return c.json(await evidence.startVerify(c.req.param("id")), 202)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // GET /:id/verify — 会话摘要（tail ≤200）。S5（2026-09-20）：可选
  // ?since=<n> 增量补拉 —— n = 客户端已收 task_verify_log 行数（0 基全局序号），
  // 响应附 lines_after（自第 n 行起）；SSE 断线重连后找回错过的行。非法/缺省
  // since = 现行为不变（无该字段）。
  router.get("/:id/verify", (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    const sinceRaw = c.req.query("since")
    const since = sinceRaw !== undefined && sinceRaw !== "" ? Number(sinceRaw) : undefined
    try {
      return c.json(evidence.getVerifyStatus(c.req.param("id"), Number.isFinite(since) ? since : undefined))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  router.post("/:id/verify/abort", (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    try {
      return c.json(evidence.abortVerify(c.req.param("id")))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // 跑起来看：acceptance_preview 命令在活工作区长驻 + HTTP 探活。同样绝不自动跑，
  // POST /:id/preview 是唯一启动入口（202）。进度走 taskpool SSE task_preview。
  router.post("/:id/preview", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    try {
      return c.json(await evidence.startPreview(c.req.param("id")), 202)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })
  router.get("/:id/preview", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    try {
      return c.json(await evidence.getPreview(c.req.param("id")))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })
  router.post("/:id/preview/stop", (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    try {
      return c.json(evidence.stopPreview(c.req.param("id")))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // ── 测试实例管理（2026-09-24，自动回收 + 一键关闭） ────────────────────
  // 注册表 ~/.octopus/instances/{taskId}.json 的读/收/关三面。GET 纯读但带
  // 读时端口复核（reconcile）；两个 POST 都会真杀进程 —— UI 侧必须过确认框，
  // 服务端另有 host-guard 三重闸兜底（绝不碰宿主 PID/端口/祖先链）。

  router.get("/:id/instances", (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    try {
      return c.json(evidence.listInstances(c.req.param("id")))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST reclaim — 回收注册表内实例（down → 等端口 → 树杀 → 落账）。
  // body 可选 {entry_ids}（缺省 = 全部非 stopped entry）。
  router.post("/:id/instances/reclaim", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    const body = await safeJson(c)
    const entryIds = Array.isArray(body?.entry_ids)
      ? (body.entry_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined
    if (body !== null && !entryIds && body.entry_ids !== undefined) {
      return c.json({ error: "entry_ids 必须是字符串数组" }, 400)
    }
    try {
      return c.json(await evidence.reclaimTaskInstances(c.req.param("id"), { entryIds }))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST close-dev — 按端口关掉 worktree 上手动 `pnpm dev` 起的整棵 dev 树
  // （端口须与任务有登记关联；宿主端口/PID/祖先链三闸拦截）。
  router.post("/:id/instances/close-dev", async (c) => {
    if (!evidence) return c.json({ error: "round evidence not wired" }, 501)
    const body = await safeJson(c)
    const port = typeof body?.port === "number" ? body.port : NaN
    if (!Number.isInteger(port)) return c.json({ error: "body 需数值字段 port" }, 400)
    try {
      return c.json(await evidence.closeDevPort(c.req.param("id"), port))
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

  // DELETE /:id — soft-delete. 票03: nothing cascades (a task's runs are executions rows);
  // only a running task is refused, everything else is discardable.
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
  // 07, K3/K6/K7). Body {phase_index, round_index, decision, feedback?, next_flow?}:
  //   accepted ∧ i<n ∧ autoAdvance → 下一 phase round 1 开跑 (next_action
  //     'dispatched'); autoAdvance=false → 'awaiting_manual_trigger' (人工起)
  //   accepted ∧ i=n               → 持久态 'archiving' (票 08 编排到 done)
  //   rejected (feedback 必填)      → fix-feedback-r{N}.md 进批次目录 + 同 phase
  //     新 round 开跑；next_flow(ADR-0018)：缺省 'rerun'=重跑绑定流（流内再审
  //     spec），'fix'=override built-in/task-fix + server 合成输入（轻量修复轮）
  // 409 = 派生态非待验收 / round 不匹配 / 该轮已验收 / 非 v4（state conflict,
  // not a body defect — the client re-GETs /:id's `derived` view and re-opens the
  // gate on whatever round is now awaiting）; 404 任务不存在; 400 body 非法
  // （含 rejected 缺 feedback — K7「打回必填反馈文本」由 superRefine 拦）。
  // S1 硬闸：accepted ∧ 本轮 checks 有 ✗ → 409 不落决策（见路由内注释）。
  // 响应体（S2 起）除 AcceptanceResult 外另带 ledger_written: boolean。
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
        ...(parsed.next_flow !== undefined ? { next_flow: parsed.next_flow } : {}),
      }
      // ADR-0022: freeze the round's evidence BEFORE the decision lands (after
      // it, the awaiting view is gone), and stop any live preview. The
      // acceptance itself stays authoritative — ledger/reopen side-effects are
      // best-effort (a failed ledger never rolls back a committed decision).
      const snap = evidence ? await evidence.snapshotEvidence(c.req.param("id")).catch(() => null) : null
      // 走查 ✗ 服务端硬闸（S1，2026-09-20）：前端 gate.fail>0 的 disabled 只拦
      // UI 入口，任何非 UI 通道（curl/脚本）都能无痕放行。checks 与写入侧同源
      // （snapshotEvidence 内 batchRelDir + checksFileName/parseChecksMd），此
      // 处在决策落账之前重数 ✗：n>0 → 409，不落决策、不写台账、不翻票。
      // 诚实降级：文件缺失/解析失败/无 ✗/快照拿不到 → 放行（未决软放行本就是
      // 前端既有语义，绝不误伤）。轮次不匹配时交给 service.acceptance 的 409。
      if (parsed.decision === "accepted" && snap
        && snap.phaseIndex === parsed.phase_index && snap.roundIndex === parsed.round_index) {
        const nFail = Object.values(snap.checks?.checks ?? {}).filter((ck) => ck.decision === "fail").length
        if (nFail > 0) {
          return c.json({ error: `走查存在 ${nFail} 项 ✗ —— 服务端硬闸拦截，请改走打回` }, 409)
        }
      }
      const result = await service.acceptance(c.req.param("id"), input)
      // 台账写入诚实化（S2，2026-09-20）：写没写成功不再只有 console.error 知道 ——
      // ledger_written 进响应体。判据：accepted = writeLedger 落盘非 null；
      // rejected = writeLedger 非 null 且 augmentReject 未抛；快照缺失 /
      // batchRelDir 解析不出 / 写失败 / 抛错 → false。决策本身不回滚（K6）。
      let ledgerWritten = false
      if (evidence) {
        try {
          evidence.stopPreviewQuiet(c.req.param("id"))
          if (snap) {
            if (parsed.decision === "accepted") {
              ledgerWritten = evidence.writeLedger(snap, "accepted") !== null
            } else {
              const led = evidence.writeLedger(snap, "rejected")
              evidence.augmentReject(snap, parsed.reopen_tickets)
              ledgerWritten = led !== null
            }
          }
        } catch (err: unknown) {
          console.error("[tasks] acceptance ledger/reopen side-effect failed (decision already committed):", err)
        }
      }
      return c.json({ ...result, ledger_written: ledgerWritten })
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

  // POST /:id/ready — draft→ready + arm seam (writes tasks.trigger_* / arms an execution
  // row; 票03: no schedule row is created, the built-in job starts it).
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

  // POST /:id/duplicate — 整单复制（spec/issues/自写 workflows 全量）→ 新 task。
  // body { ready?: boolean }（默认 true）：复制完立刻过同款入队 gate —— 源完备
  // 则副本直达待执行；gate 不过则副本留草稿并回传 gate_missing。201。
  router.post("/:id/duplicate", async (c) => {
    const body = await safeJson(c)
    if (body && body.ready !== undefined && typeof body.ready !== "boolean") {
      return c.json({ error: "ready must be a boolean" }, 400)
    }
    const ready = body && typeof body.ready === "boolean" ? body.ready : true
    try {
      const result = service.duplicateTask(c.req.param("id"), { ready })
      return c.json(result, 201)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/reopen — the enqueue undo (ready→draft): reaps the not-yet-
  // started envelope and unlocks structural editing. Claimed/running ⇒ 409.
  router.post("/:id/reopen", (c) => {
    try {
      const task = service.reopenTask(c.req.param("id"))
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/trigger — manual / one-shot time trigger. Body: { at?: ISO8601 }
  // (absent or past = 立即跑; future = 单次定时, the built-in job starts it at that
  // moment without anyone pressing anything). Same-task mutex is now a DB constraint:
  // only a ready task with no live instance can arm, so a double click and a
  // schedule-collides-with-a-running-round get the same 409 with a readable reason.
  router.post("/:id/trigger", async (c) => {
    const body = await safeJson(c)
    let at: string | undefined
    if (body && body.at !== undefined && body.at !== null) {
      const parsed = z.string().datetime({ offset: true }).safeParse(body.at)
      if (!parsed.success) return c.json({ error: "at must be an ISO8601 datetime" }, 400)
      at = parsed.data
    }
    try {
      // trigger-prebuild (2026-09-08): 生产入口走异步包装 —— 当场同步建
      // workspace+worktree（失败 409 弹回，不排队），再走 triggerTask 翻转。
      const task = await service.triggerTaskWithPrebuild(c.req.param("id"), at)
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/trigger/cancel — withdraw a not-yet-started fire (the queued instance
  // and/or the armed cursor); the task returns to ready. Already started → 409.
  router.post("/:id/trigger/cancel", (c) => {
    try {
      const task = service.cancelTaskTrigger(c.req.param("id"))
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/trigger/schedule — 周期触发 (票03, ADR-0021). Body:
  //   { cron: "* * * * *", timezone?: "Asia/Shanghai" }  → arm a recurring fire
  //   { enabled: false }                                 → pause without forgetting it
  //   { cron: null } / POST /:id/trigger/unschedule      → back to manual
  // The task's own columns hold this; there is no job row, and the scheduler is
  // unaware a cron expression exists anywhere outside its own definitions.
  router.post("/:id/trigger/schedule", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    const id = c.req.param("id")
    try {
      if (typeof body.enabled === "boolean" && body.cron === undefined) {
        service.setTriggerEnabled(id, body.enabled)
      } else {
        const cron = typeof body.cron === "string" ? body.cron : null
        const timezone = typeof body.timezone === "string" ? body.timezone : "Asia/Shanghai"
        service.setCronTrigger(id, cron, timezone)
      }
      return c.json(service.getTaskSummary(id))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/trigger/unschedule — drop the schedule, keep the task.
  router.post("/:id/trigger/unschedule", (c) => {
    try {
      service.setCronTrigger(c.req.param("id"), null, undefined)
      return c.json(service.getTaskSummary(c.req.param("id")))
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/abort — running→aborted (the task's own instances stop; the bound
  // workspace survives for the next round, K12)
  router.post("/:id/abort", async (c) => {
    try {
      const task = await service.abortTask(c.req.param("id"))
      // 2026-09-24 补齐缺口：前端中止确认一直宣称「预览会被一并 SIGTERM」，但
      // stopPreviewQuiet 此前只挂在验收决策路径上。abort 成功后静默收现场：
      // 停预览（内部含注册表 reclaim）+ 掐掉在跑的复检。容错 —— 回收失败不
      // 反转已提交的 abort。
      if (evidence) {
        const id = c.req.param("id")
        try { evidence.stopPreviewQuiet(id) } catch (err: unknown) { console.warn("[tasks] abort stopPreviewQuiet failed:", err) }
        try { evidence.abortVerify(id) } catch { /* 无在跑复检 = 正常 */ }
      }
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/pause — suspend the task's live round. The pause is delegated to the
  // bound execution (ExecutionLifecycle.pause) and the task's 已暂停 is DERIVED from
  // executions.status='paused' — nothing writes a paused task row. 409 carries the
  // state-specific reason (queued / at an approval gate / nothing in flight).
  router.post("/:id/pause", async (c) => {
    try {
      const task = await service.pauseTask(c.req.param("id"))
      return c.json(task)
    } catch (err: unknown) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  // POST /:id/resume — take the round back off the brake. Optional body
  // { intervention } rides through to the interrupted node, same as the workflow
  // page's resume. No body at all is the normal case, so a parse failure is not
  // an error (mirrors execution.ts's resume route).
  router.post("/:id/resume", async (c) => {
    const body = await safeJson(c)
    const raw = body?.intervention
    if (raw !== undefined && typeof raw !== "string") {
      return c.json({ error: "intervention must be a string" }, 400)
    }
    // Bound the prompt: it is injected into a node's context, not a free-form log.
    if (typeof raw === "string" && raw.length > 4000) {
      return c.json({ error: "intervention must be at most 4000 characters" }, 400)
    }
    try {
      const task = await service.resumeTask(c.req.param("id"), raw)
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
