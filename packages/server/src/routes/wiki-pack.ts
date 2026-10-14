import { Hono } from "hono"
import { PackOpsError, type MaterialPackOpsService } from "../services/knowledge/pack-ops"

/**
 * 素材包路由 — P3 票02（S2 契约面）——挂 `/api/knowledge/wiki`：
 *
 *   GET  /pack/:taskId                 包视图（manifest 件清单 = 素材包卡数据面）。
 *                                      旧单文件归档 ⇒ 200 {legacy:true}（兼容读，不迁移不报错）。
 *   POST /pack/:taskId/recompile       { excludePath?, focus? } ⇒ 202 { queueTaskId, … }。
 *                                      剔除某件→重编译 / 对话焦点重编译的执行面；
 *                                      **重编译经全局串行队列**（archive-compile，禁直写 wiki）。
 *
 * 错误形状沿用 `{error:{code,message}}`：INVALID_PARAM 400 · PACK_NOT_FOUND 404 ·
 * ALREADY_EXCLUDED 409 · 队列 id 冲突由 errorResponse 兜底。
 */

export function createWikiPackRoutes(ops: MaterialPackOpsService): Hono {
  const routes = new Hono()

  routes.get("/pack/:taskId", (c) => {
    const taskId = c.req.param("taskId")
    try {
      return c.json(ops.getPack(taskId))
    } catch (err) {
      if (err instanceof PackOpsError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      throw err
    }
  })

  routes.post("/pack/:taskId/recompile", async (c) => {
    const taskId = c.req.param("taskId")
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const body = payload as { excludePath?: unknown; focus?: unknown }
    try {
      const ack = ops.recompile(taskId, {
        ...(body.excludePath !== undefined ? { excludePath: body.excludePath } : {}),
        ...(body.focus !== undefined ? { focus: body.focus } : {}),
      })
      return c.json(ack, 202)
    } catch (err) {
      if (err instanceof PackOpsError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400)
      throw err
    }
  })

  return routes
}
