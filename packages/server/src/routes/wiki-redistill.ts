import { Hono } from "hono"
import { errorResponse } from "../services/knowledge/validators"
import type { RedistillReport } from "../services/knowledge/wiki/redistill"

/**
 * wiki v2→v3 重蒸馏命令的 HTTP 入口（知识中心票07，spec §迁移与幂等「单入口、幂等、可重跑」）。
 * 真数据唯一调用面：主控对运行中的 server 打这条路由（默认 dry-run 只读列计划，
 * `?apply=true` 才执行）。前置 = 票03 真搬家已执行（全局根 + DB org 钉 global）；
 * apply 前主控先按报告 backupHint VACUUM INTO 备份 DB；fs 面 = 单 commit 可整体 revert。
 *
 * 工厂注入（createWikiGlobalMoveRoutes 先例）：index.ts 用 getDb() 懒构造；测试传 fake。
 */

export interface RedistillRunner {
  run(): Promise<RedistillReport>
}

export function createWikiRedistillRoutes(
  makeMigrator: (apply: boolean) => RedistillRunner,
): Hono {
  const routes = new Hono()

  // POST /api/knowledge/wiki/redistill[?apply=true] — 缺省 dry-run
  routes.post("/redistill", async (c) => {
    try {
      const apply = c.req.query("apply") === "true"
      const report = await makeMigrator(apply).run()
      return c.json(report)
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki-redistill")
      return c.json(body, status)
    }
  })

  return routes
}
