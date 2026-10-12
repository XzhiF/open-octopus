import { Hono } from "hono"
import { errorResponse } from "../services/knowledge/validators"
import type { DistillReport } from "../services/knowledge/wiki/distill"

/**
 * 蒸馏迁移命令的 HTTP 入口（票07，spec §初始编译 蒸馏行 / prototype Tab③ lines 625-626）。
 * 薄封装（wiki-migrate.ts 同型）：org/可选 docsRoot 透传给 distiller 工厂。
 * 本路由零写 wiki——候选只入 pending_review；落盘属票06 采纳通道
 * （ReviewService.approveItem → WikiCurateService createEntry → compileEntry 唯一写闸）。
 *
 * 工厂注入（archive-routes stateDir 先例）：index.ts 用 getDb() 懒构造 + LLMCall 适配器；
 * 测试传 fake。
 */

export interface DistillRunner {
  run(): Promise<DistillReport>
}

export function createWikiDistillRoutes(
  makeDistiller: (org: string, opts: { docsRoot?: string }) => DistillRunner,
): Hono {
  const routes = new Hono()

  // POST /api/knowledge/wiki/distill?org=<org>[&docsPath=<绝对 docs 根>]
  routes.post("/distill", async (c) => {
    try {
      const org = c.req.query("org") || "default"
      const docsRoot = c.req.query("docsPath") || undefined
      const report = await makeDistiller(org, { docsRoot }).run()
      return c.json(report)
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki-distill")
      return c.json(body, status)
    }
  })

  return routes
}
