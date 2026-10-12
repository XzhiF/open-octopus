import { Hono } from "hono"
import { errorResponse } from "../services/knowledge/validators"
import type { MigrationReport } from "../services/knowledge/wiki/migrate"

/**
 * 初始编译迁移命令的 HTTP 入口（票05，spec §服务端 API 与存储「初始编译：一次性迁移命令
 * （幂等，可重跑）」）。薄封装：org/可选 glossary 路径透传给 migrator 工厂，
 * 真正的写入仍全部经唯一闸门 WikiCompileService.compileEntry（本路由不旁路写）。
 *
 * 工厂注入（archive-routes stateDir 先例）：index.ts 用 getDb() 懒构造；测试传 fake。
 */

export interface MigrateRunner {
  run(): Promise<MigrationReport>
}

export function createWikiMigrateRoutes(
  makeMigrator: (org: string, opts: { glossaryMapPath?: string }) => MigrateRunner,
): Hono {
  const routes = new Hono()

  // POST /api/knowledge/wiki/migrate?org=<org>[&glossaryPath=<绝对路径>]
  routes.post("/migrate", async (c) => {
    try {
      const org = c.req.query("org") || "default"
      const glossaryMapPath = c.req.query("glossaryPath") || undefined
      const report = await makeMigrator(org, { glossaryMapPath }).run()
      return c.json(report)
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki-migrate")
      return c.json(body, status)
    }
  })

  return routes
}
