import { Hono } from "hono"
import { CuratorError } from "../services/knowledge/wiki/curator"
import { errorResponse } from "../services/knowledge/validators"
import type { CompileTaskRecord } from "../services/knowledge/wiki/curator-task"

/**
 * 编译任务路由（知识中心票05 AC5，S2 契约面）——挂 `/api/knowledge/wiki`：
 *
 *   POST /compile            { path: "raw/inbox/….md" }  显式触发编译（投喂侧由
 *                            ingest 的 ?compile=true 承接）⇒ 202 { taskId, rawPath, status:"queued" }
 *   GET  /compile/task/:id   状态可查 ⇒ { task: CompileTaskRecord }（状态流转
 *                            queued → compiling → committed/failed；committed 带 result：
 *                            触及页清单/新页数/矛盾数/commit hash = DIFF 卡数据面）
 *
 * 错误码沿用 errorResponse 形状 `{error:{code,message}}`：
 * INVALID_PARAM 400（非 JSON/缺 path/raw 逃逸）· NOT_FOUND 404（raw 不在盘/task 不存在）。
 * 队列与锁属票06——本路由只投递，不做并发承诺。
 */

interface CompileTaskApi {
  submit(rawPath: string): CompileTaskRecord
  get(id: string): CompileTaskRecord | undefined
}

export function createWikiCompileRoutes(tasks: CompileTaskApi): Hono {
  const routes = new Hono()

  routes.post("/compile", async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const rawPath = (payload as { path?: unknown }).path
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      return c.json({ error: { code: "INVALID_PARAM", message: "path is required (knowledge-root-relative raw/… path)" } }, 400)
    }
    try {
      const task = tasks.submit(rawPath)
      return c.json({ taskId: task.id, rawPath: task.rawPath, status: task.status }, 202)
    } catch (err) {
      if (err instanceof CuratorError) {
        const code = err.code === "RAW_NOT_FOUND" ? "NOT_FOUND" : err.code
        return c.json({ error: { code, message: err.message.replace(new RegExp(`^${err.code}: `), "") } }, err.status)
      }
      const { body, status } = errorResponse(err, "wiki-compile")
      return c.json(body, status)
    }
  })

  routes.get("/compile/task/:id", (c) => {
    const id = c.req.param("id")
    const task = tasks.get(id)
    if (!task) {
      return c.json({ error: { code: "NOT_FOUND", message: `compile task not found: ${id}` } }, 404)
    }
    return c.json({ task })
  })

  return routes
}
