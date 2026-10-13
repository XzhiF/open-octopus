import { Hono } from "hono"
import { errorResponse } from "../services/knowledge/validators"
import type { GlobalMoveReport } from "../services/knowledge/wiki/global-move"

/**
 * wiki 全局化搬家命令的 HTTP 入口（知识中心票03，spec §迁移与幂等「单入口、幂等、可重跑」）。
 * 真数据唯一调用面：主控对运行中的 server 打这条路由（server 持有 DB 连接与路径解析），
 * 默认 dry-run 只读列计划；`?apply=true` 才执行。备份纪律：apply 前按报告 backupHint
 * 先 VACUUM INTO（由主控执行），两步（wiki 搬家 / re-key）各自 git/备份可回滚。
 *
 * 工厂注入（createWikiMigrateRoutes 先例）：index.ts 用 getDb() 懒构造；测试传 fake。
 */

export interface GlobalMoveRunner {
  run(): Promise<GlobalMoveReport>
}

export function createWikiGlobalMoveRoutes(
  makeMigrator: (apply: boolean) => GlobalMoveRunner,
): Hono {
  const routes = new Hono()

  // POST /api/knowledge/wiki/global-move[?apply=true] — 缺省 dry-run
  routes.post("/global-move", async (c) => {
    try {
      const apply = c.req.query("apply") === "true"
      const report = await makeMigrator(apply).run()
      return c.json(report)
    } catch (err) {
      const { body, status } = errorResponse(err, "wiki-global-move")
      return c.json(body, status)
    }
  })

  return routes
}
