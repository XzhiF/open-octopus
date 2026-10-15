import { Hono, type Context } from "hono"
import type { FindingRow, FindingStatus } from "../db/dao/findings-dao"
import { IngestError } from "../services/knowledge/raw"
import { FindingOpsError, type FixTaskRecord } from "../services/knowledge/findings"
import { severityOf } from "../services/knowledge/health-score"
import type { PatrolReport } from "../services/knowledge/patrol"
import type { BackfillInput, BackfillResult } from "../services/knowledge/backfill"
import { GLOBAL_WIKI_ORG } from "../services/knowledge/global-paths"
import { errorResponse } from "../services/knowledge/validators"

/**
 * findings 面路由（知识中心票13，S2 契约）——挂 `/api/knowledge`：
 *
 *   GET  /findings?status=open|resolved|ignored   列表（camelCase 视图，detail/pages 解形）
 *   POST /findings/:id/adopt       [采纳修订] ⇒ 202 {taskId, findingId, status:"queued"}
 *                                  （服务端生成修订稿经全局队列 finding-fix 编译；
 *                                   404 NOT_FOUND · 409 FINDING_ALREADY_ADJUDICATED）
 *   GET  /findings/fix/task/:id    修订任务状态（queued→running→committed/failed）
 *   POST /findings/:id/ignore      [忽略] ⇒ 200 {findingId, status:"ignored"}（同步、记录在案）
 *   POST /patrol                   对话「体检一下」即时触发（同步跑五查，返回巡检报告；
 *                                  夜巡自动面走 scheduler 作业，同一服务入口）
 *   POST /backfill                 回填卡 [编进 wiki]（对话摘录→raw 冻结→编译投递）
 *
 * [讨论] = 对话续流零状态变更（票面 AC2）：**本面无端点**——前端 sayToCurator 即可，
 * 不加"讨论回执"这种伪状态。错误契约沿用 {error:{code,message}} + 稳定码。
 */

export interface FindingOpsApi {
  list(status?: FindingStatus): FindingRow[]
  get(id: string): FindingRow | undefined
  ignore(id: string): FindingRow
  adopt(id: string): FixTaskRecord
  getTask(id: string): FixTaskRecord | undefined
}

export interface FindingsRoutesApi {
  ops: FindingOpsApi
  /** P4 票08：patrol() 起合并稿 seam（D2）后为异步——同步形态仍兼容（union 只放宽不收窄，契约形状零漂移） */
  patrolNow: () => PatrolReport | Promise<PatrolReport>
  backfill: (input: BackfillInput) => BackfillResult
}

const STATUSES: FindingStatus[] = ["open", "resolved", "ignored"]

/** DB 行 → API 视图（camelCase；JSON 列解形，坏 JSON 诚实回空形不炸列表）。 */
export function findingView(row: FindingRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    // P4 票08 分组视图薄扩：kind→severity 派生值（单源 health-score.ts，未知 kind 保守 minor——
    // additive 键纪律同 avgConfidence 先例，前端按此分组渲染 ranked findings，零新端点）
    severity: severityOf(row.kind),
    status: row.status,
    title: row.title,
    detail: tryParse(row.detail, {}),
    pages: tryParse(row.pages, []),
    rawRef: row.raw_ref,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function tryParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function createFindingsRoutes(api: FindingsRoutesApi): Hono {
  const routes = new Hono()

  const fail = (c: Context, err: unknown, context: string) => {
    if (err instanceof FindingOpsError || err instanceof IngestError) {
      const code = err.code
      const message = err instanceof IngestError ? err.detail : err.message.replace(new RegExp(`^${code}: `), "")
      return c.json({ error: { code, message } }, err.status as 400)
    }
    const { body, status } = errorResponse(err, context)
    return c.json(body, status)
  }

  routes.get("/findings", (c) => {
    const statusParam = c.req.query("status")
    let status: FindingStatus | undefined
    if (statusParam !== undefined && statusParam !== "") {
      if (!STATUSES.includes(statusParam as FindingStatus)) {
        return c.json({ error: { code: "INVALID_PARAM", message: `status 只许 open|resolved|ignored，得到 '${statusParam}'` } }, 400)
      }
      status = statusParam as FindingStatus
    }
    return c.json({ org: GLOBAL_WIKI_ORG, findings: api.ops.list(status).map(findingView) })
  })

  routes.post("/findings/:id/adopt", async (c) => {
    const id = c.req.param("id")
    try {
      const task = api.ops.adopt(id)
      return c.json({ findingId: task.findingId, taskId: task.id, status: task.status }, 202)
    } catch (err) {
      return fail(c, err, "findings.adopt")
    }
  })

  routes.post("/findings/:id/ignore", (c) => {
    const id = c.req.param("id")
    try {
      const row = api.ops.ignore(id)
      return c.json({ findingId: row.id, status: row.status })
    } catch (err) {
      return fail(c, err, "findings.ignore")
    }
  })

  routes.get("/findings/fix/task/:id", (c) => {
    const task = api.ops.getTask(c.req.param("id"))
    if (!task) return c.json({ error: { code: "NOT_FOUND", message: "修订任务不可查（进程内 registry，重启即清；git LOG 为审计真相）" } }, 404)
    return c.json({ task })
  })

  routes.post("/patrol", async (c) => {
    try {
      return c.json(await api.patrolNow())
    } catch (err) {
      return fail(c, err, "findings.patrol")
    }
  })

  routes.post("/backfill", async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const p = payload as Record<string, unknown>
    try {
      const res = api.backfill({
        text: typeof p.text === "string" ? p.text : "",
        ...(typeof p.title === "string" ? { title: p.title } : {}),
        ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
      })
      return c.json(res, 202)
    } catch (err) {
      return fail(c, err, "findings.backfill")
    }
  })

  return routes
}
