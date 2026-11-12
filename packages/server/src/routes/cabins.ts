// packages/server/src/routes/cabins.ts
//
// /api/cabins routes — Cabin P1. Mirrors the tasks route factory pattern:
// a pure route layer delegating to CabinService/CabinInitService, Zod bodies,
// classifyError → 400/404/409, streamSSE on channel `cabin:<id>`.
// Usage aggregation (P4) and comm note/resume (P3) land with their phases.

import { Hono } from "hono"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { z, ZodError } from "zod"
import {
  CabinStatusSchema, CabinJobKindSchema, CabinMandateSchema,
} from "@octopus/shared"
import {
  CabinService, CabinNotFoundError, CabinVersionConflictError, CabinStatusConflictError,
} from "../services/cabin/cabin-service"
import type { CabinInitService } from "../services/cabin/cabin-init-service"
import { CabinCommService, CabinJobNotFoundError } from "../services/cabin/cabin-comm-service"
import type { CabinRow, CabinJobRow, CabinJobEventRow } from "../db/types"
import type { SSEService } from "../services/sse"
import { gitOps } from "../services/git-ops"

function classifyError(err: unknown): { status: number; message: string } {
  if (err instanceof ZodError) {
    return { status: 400, message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
  }
  if (err instanceof CabinNotFoundError) return { status: 404, message: err.message }
  if (err instanceof CabinJobNotFoundError) return { status: 404, message: err.message }
  if (err instanceof CabinVersionConflictError) return { status: 409, message: err.message }
  if (err instanceof CabinStatusConflictError) return { status: 409, message: err.message }
  return { status: 500, message: err instanceof Error ? err.message : String(err) }
}

async function safeJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

function toDTO(row: CabinRow) {
  let cockpitPrefs: unknown = null
  if (row.cockpit_prefs) {
    try { cockpitPrefs = JSON.parse(row.cockpit_prefs) } catch { cockpitPrefs = null }
  }
  return {
    id: row.id, name: row.name, path: row.path,
    workspace_id: row.workspace_id, main_session_id: row.main_session_id,
    requirements: row.requirements, status: row.status,
    mainline_strategy: row.mainline_strategy, org: row.org,
    focused_job_id: row.focused_job_id, version: row.version,
    created_at: row.created_at, updated_at: row.updated_at,
    last_active_at: row.last_active_at, archived_at: row.archived_at,
    cockpit_prefs: cockpitPrefs,
  }
}

function toJobDTO(row: CabinJobRow) {
  let mandate: unknown = null
  if (row.mandate) {
    try { mandate = JSON.parse(row.mandate) } catch { mandate = null }
  }
  return { ...row, mandate }
}

function toEventDTO(row: CabinJobEventRow) {
  let payload: unknown = null
  if (row.payload) {
    try { payload = JSON.parse(row.payload) } catch { payload = null }
  }
  return { ...row, payload }
}

const createBodySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  requirements: z.string().optional(),
  org: z.string().nullable().optional(),
  repos: z.array(z.string().min(1)).optional(),
})

const attachBodySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
})

const patchBodySchema = z.object({
  version: z.number().int(),
  name: z.string().min(1).optional(),
  requirements: z.string().optional(),
  mainline_strategy: z.enum(["clean-main", "pin"]).optional(),
  org: z.string().nullable().optional(),
  cockpit_prefs: z.record(z.unknown()).optional(),
})

const iterationBodySchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  sort_order: z.number().int().optional(),
})

const iterationPatchSchema = z.object({
  name: z.string().min(1).optional(),
  sort_order: z.number().int().optional(),
  status: z.enum(["pending", "active", "done"]).optional(),
})

const jobBodySchema = z.object({
  kind: CabinJobKindSchema,
  ref_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  iteration_id: z.string().nullable().optional(),
  title: z.string().min(1),
  mandate: CabinMandateSchema.optional(),
  prompt: z.string().nullable().optional(),
  priority: z.number().int().optional(),
})

const focusBodySchema = z.object({
  version: z.number().int(),
  job_id: z.string().nullable(),
})

export function createCabinRoutes(
  service: CabinService,
  initService: CabinInitService,
  sse: SSEService,
  comm?: CabinCommService,
): Hono {
  const router = new Hono()

  // ── collection ─────────────────────────────────────────────────────

  router.get("/", (c) => {
    try {
      const statusParam = c.req.query("status")
      const status = statusParam ? CabinStatusSchema.parse(statusParam) : undefined
      return c.json({ cabins: service.list(status).map(toDTO) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = createBodySchema.parse(body)
      return c.json({ cabin: toDTO(service.create(input)) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/attach", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = attachBodySchema.parse(body)
      return c.json({ cabin: toDTO(service.attach(input.path, input.name)) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── per-cabin ──────────────────────────────────────────────────────

  router.get("/:id", (c) => {
    try {
      const { cabin, view } = service.getView(c.req.param("id"))
      return c.json({ cabin: toDTO(cabin), view })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.patch("/:id", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = patchBodySchema.parse(body)
      const fields: Record<string, unknown> = {}
      if (input.name !== undefined) fields.name = input.name
      if (input.requirements !== undefined) fields.requirements = input.requirements
      if (input.mainline_strategy !== undefined) fields.mainline_strategy = input.mainline_strategy
      if (input.org !== undefined) fields.org = input.org
      if (input.cockpit_prefs !== undefined) fields.cockpit_prefs = JSON.stringify(input.cockpit_prefs)
      return c.json({ cabin: toDTO(service.patch(c.req.param("id"), input.version, fields)) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.delete("/:id", (c) => {
    try {
      service.delete(c.req.param("id"))
      return c.json({ ok: true })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── init gate ──────────────────────────────────────────────────────

  router.post("/:id/init", (c) => {
    try {
      return c.json({ cabin: toDTO(service.init(c.req.param("id"))) }, 202)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/init", (c) => {
    try {
      const row = service.get(c.req.param("id"))
      return c.json({ status: row.status, state: initService.loadState(row) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/init/retry", (c) => {
    const id = c.req.param("id")
    try {
      const row = service.get(id)
      if (row.status !== "initializing") {
        throw new CabinStatusConflictError(id, row.status, "initializing")
      }
      void initService.runGate(id).catch((err) => {
        console.error(`[cabin-routes] init retry crashed for ${id}:`, err instanceof Error ? err.message : String(err))
      })
      return c.json({ ok: true, status: "initializing" }, 202)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── lifecycle ──────────────────────────────────────────────────────

  router.post("/:id/wake", (c) => {
    try {
      return c.json({ cabin: toDTO(service.wake(c.req.param("id"))) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/archive", (c) => {
    try {
      return c.json({ cabin: toDTO(service.archive(c.req.param("id"))) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/reopen", (c) => {
    try {
      return c.json({ cabin: toDTO(service.reopen(c.req.param("id"))) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.put("/:id/requirements", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = z.object({ version: z.number().int(), requirements: z.string() }).parse(body)
      return c.json({ cabin: toDTO(service.setRequirements(c.req.param("id"), input.version, input.requirements)) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── attention / iterations ─────────────────────────────────────────

  router.get("/:id/attention", (c) => {
    try {
      const { view } = service.getView(c.req.param("id"))
      return c.json({ attention: view.attention, health: view.health })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/iterations", (c) => {
    try {
      const { view } = service.getView(c.req.param("id"))
      return c.json({ iterations: view.iterations })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/iterations", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = iterationBodySchema.parse(body)
      return c.json({ iteration: service.createIteration(c.req.param("id"), input) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.patch("/:id/iterations/:iid", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = iterationPatchSchema.parse(body)
      service.updateIteration(c.req.param("iid"), input)
      return c.json({ ok: true })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── repos / worktrees (config.json.repos[] contract) ───────────────

  router.get("/:id/repos", async (c) => {
    try {
      const repos = service.listRepos(c.req.param("id"))
      const enriched = await Promise.all(repos.map(async (r) => {
        if (!r.worktree_path) return { ...r, git: null }
        try {
          const info = await gitOps.getBranchInfo(r.worktree_path)
          const commit = await gitOps.getHeadCommitInfo(r.worktree_path)
          const remote = r.main_path ? await gitOps.getRemoteUrl(r.main_path) : null
          return {
            ...r,
            git: {
              branch: info.branch, detached: info.detached,
              commit: commit.sha.slice(0, 8), msg: commit.msg, at: commit.at, remote,
            },
          }
        } catch {
          return { ...r, git: null }
        }
      }))
      return c.json({ repos: enriched })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/repos", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = z.object({ name: z.string().min(1) }).parse(body)
      return c.json({ repo: service.addRepo(c.req.param("id"), input.name) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // S5 拉取主线（clean-main → syncToDefaultBranch / pin → pullLatest）
  router.post("/:id/repos/:name/pull", async (c) => {
    try {
      const result = await service.pullRepo(c.req.param("id"), c.req.param("name"))
      return c.json(result)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // P3 变更窗：任务总账跨仓聚合（round-diff scope=task）
  router.get("/:id/changes", async (c) => {
    try {
      return c.json(await service.changesSummary(c.req.param("id")))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/worktrees", async (c) => {
    try {
      const repos = service.listRepos(c.req.param("id"))
      const result: Array<{ repo: string; worktrees: Array<{ path: string; head: string; branch: string | null }> }> = []
      for (const r of repos) {
        if (!r.main_path) continue
        try {
          result.push({ repo: r.name, worktrees: await gitOps.worktreeList(r.main_path) })
        } catch {
          result.push({ repo: r.name, worktrees: [] })
        }
      }
      return c.json({ worktrees: result })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── jobs / trace (C2/C6/C8 ledger) ─────────────────────────────────

  router.get("/:id/jobs", (c) => {
    try {
      return c.json({ jobs: service.listJobsView(c.req.param("id")).map(toJobDTO) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/jobs", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = jobBodySchema.parse(body)
      const job = comm
        ? comm.dispatch(c.req.param("id"), input)
        : service.dispatchJob(c.req.param("id"), input)
      return c.json({ job: toJobDTO(job) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/jobs/:jid", (c) => {
    try {
      const job = service.getJob(c.req.param("jid"))
      if (!job || job.cabin_id !== c.req.param("id")) {
        return c.json({ error: `job not found: ${c.req.param("jid")}` }, 404)
      }
      return c.json({ job: toJobDTO(job), events: service.listEvents(job.id).map(toEventDTO) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.patch("/:id/jobs/:jid", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = z.object({ priority: z.number().int() }).parse(body)
      const job = service.getJob(c.req.param("jid"))
      if (!job || job.cabin_id !== c.req.param("id")) {
        return c.json({ error: `job not found: ${c.req.param("jid")}` }, 404)
      }
      await service.bumpJobPriority(c.req.param("id"), job.id, input.priority)
      service.appendEvent(job.id, c.req.param("id"), "human_input", "human", { action: "priority", priority: input.priority })
      return c.json({ ok: true })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── comm protocol (C9/D6): note 不授权 / resume 恢复 ─────────────────
  router.post("/:id/jobs/:jid/note", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = z.object({
        text: z.string().min(1),
        actor: z.enum(["orchestrator", "human"]).optional(),
      }).parse(body)
      if (!comm) return c.json({ error: "comm service not wired" }, 501)
      const event = comm.note(c.req.param("id"), c.req.param("jid"), input.text, input.actor ?? "human")
      return c.json({ event: toEventDTO(event) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/jobs/:jid/resume", async (c) => {
    try {
      if (!comm) return c.json({ error: "comm service not wired" }, 501)
      const event = await comm.resume(c.req.param("id"), c.req.param("jid"))
      return c.json({ event: toEventDTO(event) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/jobs/:jid/trace", (c) => {
    try {
      const job = service.getJob(c.req.param("jid"))
      if (!job || job.cabin_id !== c.req.param("id")) {
        return c.json({ error: `job not found: ${c.req.param("jid")}` }, 404)
      }
      return c.json({ events: service.listEvents(job.id).map(toEventDTO) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/trace", (c) => {
    try {
      return c.json({ events: service.listTrace(c.req.param("id")).map(toEventDTO) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── focus (C8) ─────────────────────────────────────────────────────

  router.post("/:id/focus", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = focusBodySchema.parse(body)
      const cabin = service.setFocus(c.req.param("id"), input.version, input.job_id)
      if (input.job_id) {
        service.appendEvent(input.job_id, c.req.param("id"), "human_input", "human", { action: "focus" })
      }
      return c.json({ cabin: toDTO(cabin) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.delete("/:id/focus", (c) => {
    try {
      const version = Number(c.req.query("version"))
      if (!Number.isInteger(version)) return c.json({ error: "version query param required (integer)" }, 400)
      return c.json({ cabin: toDTO(service.setFocus(c.req.param("id"), version, null)) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── SSE (channel cabin:<id>) ───────────────────────────────────────

  router.get("/:id/events", (c) => {
    const id = c.req.param("id")
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "heartbeat",
        data: JSON.stringify({ ts: new Date().toISOString(), hello: true }),
      })
      const unsub = sse.subscribe(`cabin:${id}`, (event) => {
        stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) })
      })
      const interval = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: new Date().toISOString() }) })
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

  return router
}