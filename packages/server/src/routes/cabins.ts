// packages/server/src/routes/cabins.ts
//
// /api/cabins routes — Cabin P1. Mirrors the tasks route factory pattern:
// a pure route layer delegating to CabinService/CabinInitService, Zod bodies,
// classifyError → 400/404/409, streamSSE on channel `cabin:<id>`.
// Usage aggregation (P4) and comm note/resume (P3) land with their phases.

import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { z, ZodError } from "zod"
import {
  CabinStatusSchema, CabinJobKindSchema, CabinMandateSchema, gitBranchRefSchema,
} from "@octopus/shared"
import {
  CabinService, CabinNotFoundError, CabinVersionConflictError, CabinStatusConflictError,
  WorktreeConflictError, CabinRepoInputError,
} from "../services/cabin/cabin-service"
import { scanLocalProjects, isGitRepo, isWorktreeDirty } from "../services/cabin/cabin-repos"
import type { CabinInitService } from "../services/cabin/cabin-init-service"
import { CabinCommService, CabinJobNotFoundError } from "../services/cabin/cabin-comm-service"
import { CabinDecisionService, CabinDecisionError } from "../services/cabin/cabin-decision-service"
import { CabinDelegationService } from "../services/cabin/cabin-delegation-service"
import { CabinItemService, CabinItemError } from "../services/cabin/cabin-item-service"
import type { CabinRow, CabinJobRow, CabinJobEventRow } from "../db/types"
import type { SSEService } from "../services/sse"
import { gitOps } from "../services/git-ops"
import { getLocalTree } from "../services/local-tree"
import { touchTreeWatch } from "../services/tree-watch"
import { findingView } from "./findings"

function classifyError(err: unknown): { status: number; message: string } {
  if (err instanceof ZodError) {
    return { status: 400, message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }
  }
  if (err instanceof CabinNotFoundError) return { status: 404, message: err.message }
  if (err instanceof CabinJobNotFoundError) return { status: 404, message: err.message }
  if (err instanceof CabinDecisionError) return { status: err.status, message: err.message }
  if (err instanceof CabinItemError) return { status: err.status, message: err.message }
  if (err instanceof CabinVersionConflictError) return { status: 409, message: err.message }
  if (err instanceof CabinStatusConflictError) return { status: 409, message: err.message }
  if (err instanceof WorktreeConflictError) return { status: 409, message: err.message }
  if (err instanceof CabinRepoInputError) return { status: 400, message: err.message }
  if (err instanceof DocAccessError) return { status: err.status, message: err.message }
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
    version: row.version,
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

/** 只读查阅的文本上限（tree 扫描 / 缓存 / 深度见 services/local-tree.ts）。 */
const REPO_FILE_MAX_BYTES = 512 * 1024

/** 本舱目录里允许直出原始字节的类型（v22 九轮：图片预览）；其余走 /file 文本接口。 */
const CABIN_RAW_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
}
const CABIN_RAW_MAX_BYTES = 8 * 1024 * 1024

/* ── 文档查看器（2026-11-19 用户 #4）：聊天里出现的产物绝对路径 → 只读查阅。
      文本类回内容（2MB 上限）；图片 / 视频 / 音频走 /doc-raw（64MB，支持 Range）；
      其余（未知扩展 = 二进制）只回 kind=binary，UI 显示「无法查阅二进制文件」。 ── */
class DocAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = "DocAccessError"
  }
}

/** 文本类文档（md / yaml / json 等优化显示，html 按纯文本看，不做页面渲染）。 */
const DOC_TEXT_EXT = new Set([
  ".md", ".markdown", ".mdx", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".conf",
  ".csv", ".tsv", ".log", ".xml", ".html", ".htm", ".css", ".scss", ".less",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".sh", ".bash", ".zsh", ".ps1",
  ".sql", ".graphql", ".proto", ".diff", ".patch", ".rst", ".adoc",
])

/** 媒体类文档：<img> / <video> / <audio> 直连 /doc-raw（只读字节流）。 */
const CABIN_DOC_MEDIA_MIME: Record<string, string> = {
  ...CABIN_RAW_IMAGE_MIME,
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
}

const DOC_TEXT_MAX_BYTES = 2 * 1024 * 1024
const DOC_RAW_MAX_BYTES = 64 * 1024 * 1024

function withinDocRoot(target: string, root: string): boolean {
  const fold = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v)
  const t = fold(target)
  const r = fold(root)
  return t === r || t.startsWith(r + path.sep)
}

/** 绝对路径 → 校验必须落在本舱文档根内（舱目录 / 本舱任务 workspace）。 */
function resolveCabinDoc(service: CabinService, cabinId: string, rawPath: string): { abs: string; ext: string } {
  if (!rawPath.trim()) throw new DocAccessError(400, "Query param 'path' is required")
  const expanded = rawPath.trim().replace(/^~(?=$|[\\/])/, os.homedir())
  if (!path.isAbsolute(expanded)) throw new DocAccessError(400, "path must be absolute")
  const abs = path.resolve(expanded)
  const roots = service.docRoots(cabinId)
  if (!roots.some((root) => withinDocRoot(abs, root))) {
    throw new DocAccessError(403, "path outside this cabin's docs")
  }
  return { abs, ext: path.extname(abs).toLowerCase() }
}

const createBodySchema = z.object({
  /** v5：可选。空名先落「未命名舱」，init 开头按需求取名（一次请求就建）。 */
  name: z.string().max(64).optional(),
  /** 可省略 = 新建工作空间（服务端生成 ~/.octopus/workspaces/cabin-…）。 */
  path: z.string().min(1).optional(),
  requirements: z.string().optional(),
  org: z.string().nullable().optional(),
  repos: z.array(z.string().min(1)).optional(),
  /** 项目关联；优先于 org+repos。ORG（org+repo）/ 本地（localPath）/ 舱外（absolutePath+external）。 */
  projects: z.array(z.object({
    source: z.enum(["org", "local"]).optional(),
    org: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    localPath: z.string().min(1).optional(),
    absolutePath: z.string().min(1).optional(),
    external: z.boolean().optional(),
  })).optional(),
})

const repoBodySchema = z.object({
  source: z.enum(["org", "local"]).optional(),
  name: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  localPath: z.string().min(1).optional(),
  absolutePath: z.string().min(1).optional(),
  external: z.boolean().optional(),
  /** 落点分支（mainline_branch）；空 = 按仓库当前分支探测。 */
  mainline: gitBranchRefSchema.optional(),
})

/** 改项目落点分支：key 必须显式出现 —— null 表示清空回「按默认分支探测」。 */
const repoPatchBodySchema = z.object({
  mainline: gitBranchRefSchema.nullable(),
})

const worktreeBodySchema = z.object({
  branch: z.string().min(1).optional(),
  instance: z.string().min(1).optional(),
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

const jobBodySchema = z.object({
  kind: CabinJobKindSchema,
  ref_id: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  title: z.string().min(1),
  mandate: CabinMandateSchema.optional(),
  prompt: z.string().nullable().optional(),
})

const decisionBodySchema = z.object({
  askId: z.string().min(1),
  choice: z.string().min(1),
  note: z.string().optional(),
  source: z.enum(["card", "composer", "thread_fallback"]).optional(),
  focusAtSubmit: z.string().nullable().optional(),
  taskId: z.string().optional(),
})

/** 「还需讨论」：不作答，先请提问的 agent 解释选项（不写决策账本）。 */
const discussBodySchema = z.object({
  askId: z.string().min(1),
  note: z.string().optional(),
})

const delegationBodySchema = z.object({
  title: z.string().min(1),
  intent: z.string().min(1),
  brief: z.object({
    goal: z.string().min(1),
    done_when: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    non_goals: z.array(z.string()).optional(),
    refs: z.array(z.string()).optional(),
    autonomy: z.enum(["approve", "checkpoint", "hands-off"]).optional(),
  }).optional(),
  autonomy: z.enum(["approve", "checkpoint", "hands-off"]).optional(),
})

/** 舱内事项（2026-11-24 用户）：零散小待办。 */
const cabinItemKindSchema = z.enum(["optimize", "fix", "idea"])
const cabinItemCreateSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(8000).optional(),
  kind: cabinItemKindSchema.optional(),
})
const cabinItemPatchSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(8000).optional(),
  kind: cabinItemKindSchema.optional(),
})
const cabinItemIdsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(50),
})
const cabinItemCloseSchema = cabinItemIdsSchema.extend({
  outcome: z.enum(["done", "dropped"]),
})

export function createCabinRoutes(
  service: CabinService,
  initService: CabinInitService,
  sse: SSEService,
  comm?: CabinCommService,
  decisions?: CabinDecisionService,
  delegations?: CabinDelegationService,
): Hono {
  const router = new Hono()

  /** 目录窗打开期间的增量刷新（2026-11-24 目录窗优化）：GET /tree?watch=1 续租，
   *  chokidar 发现结构变化 → 失效缓存 + 在 cabin:<id> 推 tree_changed；
   *  窗口关掉后没人续租，watcher 120s 自动退场。 */
  const ensureTreeWatch = (cabinId: string, root: string) => {
    touchTreeWatch(root, (dirs) => {
      // tree-watch 已经失效缓存；这里只负责把变化广播给前端（静默重拉）。
      sse.emit(`cabin:${cabinId}`, {
        event: "tree_changed",
        data: { cabin_id: cabinId, dir: path.resolve(root), dirs },
      })
    })
  }

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
      const { cabin, created } = service.createWithResult(input)
      // created:false = 目录已经是一个舱（一目录一舱）。客户端据此直接打开已有舱，
      // 不再 init（plan §4.2：保持 201 + 不报错，避免牵连 attach/测试）。
      return c.json({ cabin: toDTO(cabin), created }, 201)
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

  /** 建舱/绑定前的本地项目扫描（只读）：返回 path 下深度 ≤2 的 git 仓库元信息。 */
  router.get("/local-projects", (c) => {
    const raw = c.req.query("path")?.trim()
    if (!raw) return c.json({ error: "path required" }, 400)
    if (!path.isAbsolute(raw)) return c.json({ error: "path must be absolute" }, 400)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(raw)
    } catch {
      return c.json({ error: "path not found" }, 400)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return c.json({ error: "path must be a directory" }, 400)
    return c.json({ projects: scanLocalProjects(raw) })
  })

  router.get("/:id", (c) => {
    try {
      const { cabin, view } = service.getView(c.req.param("id"))
      // 右栏「变更」的出现条件：本舱 cwd 本身是一个独立 git 仓库。前端据此隐藏按钮，
      // 不靠额外探测请求（详情随 cabin_status 一起重拉，条件始终新鲜）。
      return c.json({
        cabin: { ...toDTO(cabin), cwd_git: isGitRepo(cabin.path) },
        view,
      })
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

  /** 软删除（计费账不删）。`?delete_files=1` = 确认弹框里勾了「同时删除本地文件」，
   *  连同舱目录一起删；默认只删记录、目录不动。 */
  router.delete("/:id", (c) => {
    try {
      const flag = (c.req.query("delete_files") ?? "").toLowerCase()
      const deleteFiles = flag === "1" || flag === "true"
      const result = service.delete(c.req.param("id"), { deleteFiles })
      return c.json({ ok: true, ...result })
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

  /** 人来了：进舱 / 键鼠 / 点汐音都打这一枪（客户端节流）。
   *  dormant → active 静默叫醒；active → 刷新空闲计时。幂等，不返回错误态。 */
  router.post("/:id/activity", async (c) => {
    try {
      const body = await c.req.json<{ at?: number }>().catch(() => ({} as { at?: number }))
      return c.json({ cabin: toDTO(service.activity(c.req.param("id"), body?.at)) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/dormant", (c) => {
    try {
      return c.json({ cabin: toDTO(service.dormant(c.req.param("id"))) })
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

  // ── attention ──────────────────────────────────────────────────────

  router.get("/:id/attention", (c) => {
    try {
      const { view } = service.getView(c.req.param("id"))
      return c.json({ attention: view.attention, health: view.health })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── repos / worktrees (config.json.repos[] contract) ───────────────

  router.get("/:id/repos", async (c) => {
    try {
      const repos = service.repoViews(c.req.param("id"))
      // ?enrich=0 只回条目（HUD 计数用），不打 git。
      if (c.req.query("enrich") === "0") return c.json({ repos })
      const enriched = await Promise.all(repos.map(async (r) => {
        // 无 worktree 也富化：目标回落到主仓（项目面要看分支 / HEAD）。
        const target = r.worktree_path ?? r.main_path
        if (!target) return { ...r, git: null }
        try {
          const info = await gitOps.getBranchInfo(target)
          const commit = await gitOps.getHeadCommitInfo(target)
          const remote = r.main_path ? await gitOps.getRemoteUrl(r.main_path) : null
          return {
            ...r,
            git: {
              branch: info.branch, detached: info.detached,
              commit: commit.sha.slice(0, 8), msg: commit.msg, at: commit.at, remote,
              // 工作区是否有未提交改动（浮层/项目面「dirty」徽标）。status 是
              // best-effort：读不到按 clean，不把错误画成脏。
              dirty: isWorktreeDirty(target),
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
      const input = repoBodySchema.parse(body)
      if (!input.name && !input.repo) throw new Error("name or repo required")
      const entry = service.addRepo(c.req.param("id"), { ...input, name: input.name ?? input.repo })
      return c.json({ repo: entry }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /** 改项目落点分支（mainline_branch）：只影响此后新建的 worktree / 任务分支。 */
  router.patch("/:id/repos/:name", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = repoPatchBodySchema.parse(body)
      const entry = service.setRepoMainline(c.req.param("id"), c.req.param("name"), input.mainline)
      return c.json({ repo: entry })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /** 解绑：只动 config，不动磁盘；有活跃任务 → 409。 */
  router.delete("/:id/repos/:name", (c) => {
    try {
      return c.json(service.removeRepo(c.req.param("id"), c.req.param("name")))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 409)
    }
  })

  /** 显式开工作树（默认不预建；重复开同分支 409，不覆盖）。 */
  router.post("/:id/repos/:name/worktree", async (c) => {
    const body = (await safeJson(c)) ?? {}
    try {
      const input = worktreeBodySchema.parse(body)
      const entry = service.openRepoWorktree(c.req.param("id"), c.req.param("name"), input)
      return c.json({ repo: entry }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status === 500 ? 409 : status as 400)
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

  // v22 十三轮（问题 #1）：本舱变更窗 —— cwd 的工作区改动（worktree vs HEAD + 未跟踪）。
  router.get("/:id/worktree-changes", async (c) => {
    try {
      return c.json(await service.worktreeChanges(c.req.param("id")))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // 单文件 unified patch（点开才拉；untracked=1 时按新文件 diff /dev/null）。
  router.get("/:id/worktree-changes/patch", async (c) => {
    const repo = c.req.query("repo")
    const rel = c.req.query("path")
    if (!repo || !rel) return c.json({ error: "Query params 'repo' and 'path' are required" }, 400)
    try {
      return c.json(await service.worktreeChangePatch(
        c.req.param("id"), repo, rel, c.req.query("untracked") === "1",
      ))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── knowledge (S7 / G4) / usage (C7) ───────────────────────────────

  // G4 读时 scoping；裁决复用全局 /api/knowledge/findings/:id/adopt|ignore。
  router.get("/:id/findings", (c) => {
    try {
      const statusParam = c.req.query("status")
      const status = statusParam ? z.enum(["open", "resolved", "ignored"]).parse(statusParam) : undefined
      const findings = service.listFindings(c.req.param("id"), status)
      return c.json({ findings: findings.map(findingView) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/usage", (c) => {
    try {
      return c.json(service.usage(c.req.param("id")))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── 舱内事项（2026-11-24 用户）────────────────────────────────────────
  // 零散小待办：新增 / 编辑 / 删除 / 投递 / 关项 / 重开。与「任务」不是一层：
  // 事项只是待办条目，投递给主对话即 delivered；人确认「完成 / 搁置」才关项。
  const cabinItems = new CabinItemService(service.getDb())

  router.get("/:id/items", (c) => {
    try {
      const list = cabinItems.list(c.req.param("id"))
      const open = list.filter((item) => item.status === "todo" || item.status === "delivered").length
      return c.json({ items: list, open })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/items", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = cabinItemCreateSchema.parse(body)
      return c.json({ item: cabinItems.create(c.req.param("id"), input) }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /** 投递：把事项标成 delivered（todo → delivered，幂等）。聊天路由发送时也会
   *  自动调用同一个口径；这里留一个显式入口，便于重试 / 外部投递。 */
  router.post("/:id/items/deliver", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = cabinItemIdsSchema.parse(body)
      return c.json({ items: cabinItems.deliver(c.req.param("id"), input.ids) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /** 关项：人确认「完成 / 搁置」；写 closed_at，记录保留。 */
  router.post("/:id/items/close", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = cabinItemCloseSchema.parse(body)
      return c.json({ items: cabinItems.close(c.req.param("id"), input.ids, input.outcome) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.patch("/:id/items/:itemId", async (c) => {
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = cabinItemPatchSchema.parse(body)
      return c.json({ item: cabinItems.update(c.req.param("id"), c.req.param("itemId"), input) })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.delete("/:id/items/:itemId", (c) => {
    try {
      cabinItems.remove(c.req.param("id"), c.req.param("itemId"))
      return c.json({ ok: true })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/items/:itemId/reopen", (c) => {
    try {
      return c.json({ item: cabinItems.reopen(c.req.param("id"), c.req.param("itemId")) })
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

  // ── v20（design 29 §6 ws）：工作树只读查阅（ff-only 纪律：只读不写）──
  // tree = 磁盘直扫（services/local-tree.ts：depth≤14 / 20000 文件，异步 + 10s 缓存，
  //   响应带 truncated/reason；?fresh=1 绕过缓存，?sizes=1 才取每文件字节）；
  //   ?watch=1 让 chokidar 盯着这个根，变化推 cabin:<id> 的 tree_changed。
  // file = 任意常规文件（守卫不出工作树根 + 512KB 上限，与 home-content 同码）。

  // ── v22 九轮：本舱 cwd 只读目录树（右栏「目录」）──
  // 一目录一舱：根 = cabin.path（不是某个项目的 worktree）。tree 与 repo tree 同口径；
  // file 只出常规文本（512KB）；raw 只给图片（8MB），UI 用 <img src> 直接预览。

  router.get("/:id/tree", async (c) => {
    try {
      const cabin = service.get(c.req.param("id"))
      if (!cabin.path) return c.json({ error: "cabin has no local path" }, 409)
      const resolvedRoot = path.resolve(cabin.path)
      const scan = await getLocalTree(resolvedRoot, {
        fresh: c.req.query("fresh") === "1",
        withSizes: c.req.query("sizes") === "1",
      })
      if (c.req.query("watch") === "1") ensureTreeWatch(c.req.param("id"), resolvedRoot)
      return c.json({ dir: resolvedRoot, ...scan })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/file", (c) => {
    const rel = c.req.query("path")
    if (!rel || !rel.trim()) return c.json({ error: "Query param 'path' is required" }, 400)
    try {
      const cabin = service.get(c.req.param("id"))
      if (!cabin.path) return c.json({ error: "cabin has no local path" }, 409)
      const resolvedRoot = path.resolve(cabin.path)
      const abs = path.resolve(resolvedRoot, rel)
      if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
        return c.json({ error: "path escapes cabin root" }, 403)
      }
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        return c.json({ error: "file not found" }, 404)
      }
      if (!st.isFile()) return c.json({ error: "not a regular file" }, 404)
      if (st.size > REPO_FILE_MAX_BYTES) return c.json({ error: "file too large to read" }, 413)
      return c.json({ path: rel, content: fs.readFileSync(abs, "utf8") })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/raw", (c) => {
    const rel = c.req.query("path")
    if (!rel || !rel.trim()) return c.json({ error: "Query param 'path' is required" }, 400)
    try {
      const cabin = service.get(c.req.param("id"))
      if (!cabin.path) return c.json({ error: "cabin has no local path" }, 409)
      const mime = CABIN_RAW_IMAGE_MIME[path.extname(rel).toLowerCase()]
      if (!mime) return c.json({ error: "unsupported raw file type" }, 415)
      const resolvedRoot = path.resolve(cabin.path)
      const abs = path.resolve(resolvedRoot, rel)
      if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
        return c.json({ error: "path escapes cabin root" }, 403)
      }
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        return c.json({ error: "file not found" }, 404)
      }
      if (!st.isFile()) return c.json({ error: "not a regular file" }, 404)
      if (st.size > CABIN_RAW_MAX_BYTES) return c.json({ error: "file too large" }, 413)
      const body = fs.readFileSync(abs)
      return c.body(new Uint8Array(body), 200, {
        "Content-Type": mime,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/doc", (c) => {
    try {
      const { abs, ext } = resolveCabinDoc(service, c.req.param("id"), c.req.query("path") ?? "")
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        throw new DocAccessError(404, "file not found")
      }
      if (!st.isFile()) throw new DocAccessError(404, "not a regular file")
      const base = { path: abs, ext, size: st.size }
      const mediaMime = CABIN_DOC_MEDIA_MIME[ext]
      if (mediaMime) {
        const kind = mediaMime.startsWith("video/") ? "video"
          : mediaMime.startsWith("audio/") ? "audio" : "image"
        return c.json({ ...base, kind, mime: mediaMime })
      }
      if (!DOC_TEXT_EXT.has(ext)) return c.json({ ...base, kind: "binary" })
      if (st.size > DOC_TEXT_MAX_BYTES) throw new DocAccessError(413, "file too large to read")
      return c.json({ ...base, kind: "text", content: fs.readFileSync(abs, "utf8") })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // 媒体字节流：<img src> / <video src> 直连；支持 Range（视频可拖动进度）。
  router.get("/:id/doc-raw", (c) => {
    try {
      const { abs, ext } = resolveCabinDoc(service, c.req.param("id"), c.req.query("path") ?? "")
      const mime = CABIN_DOC_MEDIA_MIME[ext]
      if (!mime) throw new DocAccessError(415, "unsupported raw file type")
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        throw new DocAccessError(404, "file not found")
      }
      if (!st.isFile()) throw new DocAccessError(404, "not a regular file")
      if (st.size > DOC_RAW_MAX_BYTES) throw new DocAccessError(413, "file too large")
      const buf = fs.readFileSync(abs)
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Cache-Control": "no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
      }
      const range = c.req.header("range")
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
      if (m && (m[1] || m[2])) {
        let start: number
        let end: number
        if (!m[1] && m[2]) {
          // 后缀区间：最后 N 字节
          const suffix = Number(m[2])
          start = Math.max(0, buf.byteLength - suffix)
          end = buf.byteLength - 1
        } else {
          start = Number(m[1])
          end = m[2] ? Number(m[2]) : buf.byteLength - 1
        }
        end = Math.min(end, buf.byteLength - 1)
        if (!Number.isFinite(start) || start > end || start >= buf.byteLength) {
          return c.body(null, 416, { "Content-Range": `bytes */${buf.byteLength}` })
        }
        const slice = buf.subarray(start, end + 1)
        return c.body(new Uint8Array(slice), 206, {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
          "Content-Length": String(slice.byteLength),
        })
      }
      return c.body(new Uint8Array(buf), 200, {
        ...headers,
        "Content-Length": String(buf.byteLength),
      })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/repos/:name/tree", async (c) => {
    try {
      const repo = service.listRepos(c.req.param("id")).find((r) => r.name === c.req.param("name"))
      if (!repo) return c.json({ error: "repo not bound to cabin" }, 404)
      const root = repo.worktree_path ?? repo.main_path
      if (!root) return c.json({ error: "repo has no local path" }, 409)
      const resolvedRoot = path.resolve(root)
      const scan = await getLocalTree(resolvedRoot, {
        fresh: c.req.query("fresh") === "1",
        withSizes: c.req.query("sizes") === "1",
      })
      if (c.req.query("watch") === "1") ensureTreeWatch(c.req.param("id"), resolvedRoot)
      return c.json({ dir: resolvedRoot, ...scan })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.get("/:id/repos/:name/file", (c) => {
    const rel = c.req.query("path")
    if (!rel || !rel.trim()) return c.json({ error: "Query param 'path' is required" }, 400)
    try {
      const repo = service.listRepos(c.req.param("id")).find((r) => r.name === c.req.param("name"))
      if (!repo) return c.json({ error: "repo not bound to cabin" }, 404)
      const root = repo.worktree_path ?? repo.main_path
      if (!root) return c.json({ error: "repo has no local path" }, 409)
      const resolvedRoot = path.resolve(root)
      const abs = path.resolve(resolvedRoot, rel)
      if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
        return c.json({ error: "path escapes worktree root" }, 403)
      }
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        return c.json({ error: "file not found" }, 404)
      }
      if (!st.isFile()) return c.json({ error: "not a regular file" }, 404)
      if (st.size > REPO_FILE_MAX_BYTES) return c.json({ error: "file too large to read" }, 413)
      return c.json({ path: rel, content: fs.readFileSync(abs, "utf8") })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /**
   * 2026-11-23 用户 #1：项目面「git 变更」—— 单个关联项目的工作区改动。
   * 目标 = worktree_path ?? main_path（与舱籍读数同口径）；只读。
   */
  router.get("/:id/repos/:name/worktree-changes", async (c) => {
    try {
      return c.json(await service.repoWorktreeChanges(c.req.param("id"), c.req.param("name")))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // 单文件 unified patch（点开才拉；untracked=1 时按新文件 diff /dev/null）。
  router.get("/:id/repos/:name/worktree-changes/patch", async (c) => {
    const rel = c.req.query("path")
    if (!rel) return c.json({ error: "Query param 'path' is required" }, 400)
    try {
      return c.json(await service.repoWorktreeChangePatch(
        c.req.param("id"), c.req.param("name"), rel, c.req.query("untracked") === "1",
      ))
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

  // ── comm protocol (D6): resume 恢复 ────────────────────────────────

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

  // ── 决策（design 25 §7.1：票据 / 账本 / 队列）──────────────────────

  /** 提交决策：askId 是唯一权威；choice 逐字命中 options；重复提交幂等。 */
  router.post("/:id/decisions", async (c) => {
    if (!decisions) return c.json({ error: "decision service not wired" }, 503)
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = decisionBodySchema.parse(body)
      const res = await decisions.submitDecision(c.req.param("id"), input)
      return c.json({
        decision: res.record,
        already: res.already,
        receipt: {
          handle: res.record.handle,
          choice: res.record.choice,
          // 第 5 步纪律：提交成功立刻可见，不等转达（§5.6）。
          line: res.already
            ? `已经答过（你选的是「${res.record.choice}」）`
            : `✓ 已记下：${res.record.choice} · 汐音正在转达…`,
        },
      })
    } catch (err) {
      const { status, message } = classifyError(err)
      const detail = err instanceof CabinDecisionError ? err.detail : undefined
      return c.json({ error: message, ...(detail !== undefined ? { detail } : {}) }, status as 400)
    }
  })

  /** 「还需讨论」（用户 #20）：不作答，把讨论请求送进提问所在会话 ——
   *  提问仍待答，不写决策账本；agent 解释选项后人在对话里继续。 */
  router.post("/:id/decisions/discuss", async (c) => {
    if (!decisions) return c.json({ error: "decision service not wired" }, 503)
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = discussBodySchema.parse(body)
      return c.json(await decisions.discussAsk(c.req.param("id"), input))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /** 忽略一条提问（旧卡 / 不再需要回答）：写回消息 decision，attention 随即消项。 */  router.post("/:id/asks/:askId/dismiss", (c) => {
    try {
      return c.json(service.dismissAsk(c.req.param("id"), c.req.param("askId")))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /** 完成回流收项（2026-11-19 用户 #9）：「确认不会回复了」只写 ack 表，
   *  不回写任务 / 会话、不唤醒执行者。 */
  router.post("/:id/attention/:itemId/ack", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { actor?: unknown }
      const actor = body.actor === "orchestrator" ? "orchestrator" as const : "person" as const
      return c.json(service.ackAttention(c.req.param("id"), c.req.param("itemId"), actor))
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  /** 决策账本（可重放）：state = decided | relayed | fallback_relayed | expired。 */
  router.get("/:id/decisions", (c) => {
    if (!decisions) return c.json({ decisions: [], pending: [] })
    try {
      return c.json({
        decisions: decisions.listDecisions(c.req.param("id")),
        pending: decisions.pendingRelays(c.req.param("id")),
        asks: decisions.listAskCards(c.req.param("id")),
      })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  // ── 独立委派（design 25 §4.2）─────────────────────────────────────

  router.get("/:id/delegations", (c) => {
    if (!delegations) return c.json({ delegations: [] })
    try {
      const rows = delegations.list(c.req.param("id"))
      const handles = service.listWorkView(c.req.param("id"))
        .filter((w) => w.kind === "delegation")
      return c.json({
        delegations: rows.map((d) => {
          const h = handles.find((w) => w.id === d.id)
          return {
            ...d,
            brief: d.brief ? JSON.parse(d.brief) as unknown : null,
            handle: h?.handle ?? null,
            color: h?.color ?? null,
          }
        }),
      })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/delegations", async (c) => {
    if (!delegations) return c.json({ error: "delegation service not wired" }, 503)
    const body = await safeJson(c)
    if (!body) return c.json({ error: "Invalid or missing JSON body" }, 400)
    try {
      const input = delegationBodySchema.parse(body)
      const row = delegations.delegate(c.req.param("id"), {
        title: input.title,
        intent: input.intent,
        brief: input.brief ?? null,
        autonomy: input.autonomy,
      })
      return c.json({
        delegation: {
          ...row,
          brief: row.brief ? JSON.parse(row.brief) as unknown : null,
        },
      }, 201)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status as 400)
    }
  })

  router.post("/:id/delegations/:did/cancel", (c) => {
    if (!delegations) return c.json({ error: "delegation service not wired" }, 503)
    const row = delegations.get(c.req.param("did"))
    if (!row || row.cabin_id !== c.req.param("id")) return c.json({ error: "delegation not found" }, 404)
    return c.json({ delegation: delegations.cancel(row.id) })
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