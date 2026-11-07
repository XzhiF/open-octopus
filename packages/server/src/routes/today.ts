import { Hono } from "hono"
import { buildTodayDigest, type TodayDigestDeps } from "../services/today-digest"

/**
 * GET /api/dashboard/today —— 「今日」页一次取全量。
 *
 * 只读，无写入。窗口 = 服务器本地零点到现在。
 * 运行中对话数从内存流取（与 header 运行指示同源），通过注入避免 route
 * 直接依赖 agent-service 单例（测试可给 0 / 固定值）。
 */
export function createTodayRoutes(deps: TodayDigestDeps): Hono {
  const routes = new Hono()

  routes.get("/today", (c) => {
    try {
      return c.json(buildTodayDigest(deps))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[today] digest failed:", msg)
      return c.json({ error: { code: "TODAY_DIGEST_FAILED", message: msg } }, 500)
    }
  })

  return routes
}

export default createTodayRoutes