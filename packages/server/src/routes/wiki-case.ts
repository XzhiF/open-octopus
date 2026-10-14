import { Hono } from "hono"
import { CaseArchiveError } from "../services/knowledge/case-extract-service"

/**
 * 判例路由 — P3 票03（S2 契约面）——挂 `/api/knowledge/wiki`：
 *
 *   POST /case/retire   { caseId } ⇒ 202 { caseId, queueTaskId, casePath }。
 *                        判例退役（故事 11 事后纠的执行面：判例卡钮/策展对话同落此口）——
 *                        **经 case-archive 第八类 opKind 入全局串行队列**（红线2：
 *                        判例一切写经此通道，禁直写 cases/）；状态经 GET /wiki/queue/task/:id 可查。
 *
 * 错误形状 {error:{code,message}}：INVALID_PARAM 400 · CASE_NOT_FOUND 404 ·
 * CASE_ALREADY_SUPERSEDED 409。红线3：这不是审批态——退役即时生效，无 pending。
 */

export interface WikiCaseRouteDeps {
  retireCase: (caseId: string) => { queueTaskId: string; casePath: string }
}

export function createWikiCaseRoutes(deps: WikiCaseRouteDeps): Hono {
  const routes = new Hono()

  routes.post("/case/retire", async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const caseId = (payload as { caseId?: unknown }).caseId
    if (typeof caseId !== "string" || caseId.trim() === "" || !/^[a-z][a-z0-9-]*$/.test(caseId)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "caseId 必须是判例 id（小写 kebab-case）" } }, 400)
    }
    try {
      const ack = deps.retireCase(caseId)
      return c.json({ caseId, ...ack }, 202)
    } catch (err) {
      if (err instanceof CaseArchiveError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      throw err
    }
  })

  return routes
}
