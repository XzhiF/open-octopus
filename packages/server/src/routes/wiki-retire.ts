import { Hono } from "hono"
import { PageRetireError, type PageRetireTaskRecord, type PageRetireInput } from "../services/knowledge/wiki/page-retire"
import { errorResponse } from "../services/knowledge/validators"

/**
 * 页退役路由（票08 清理账 · spec 故事32，S2 契约面）——挂 `/api/knowledge/wiki`：
 *
 *   POST /retire            { path: "concepts/x.md" } 或 { pageId: "con-x" } [, reason]
 *                           [, replacedBy（票04 supersede 指针：退役页 front-matter
 *                           `replaced_by` 机读行）] [, source（LOG retire 行 source 位，
 *                           缺省 dialogue；票09 自动退役传 auto 走同一入口）]
 *                           ⇒ 202 { taskId, path, status:"queued" }
 *                           任务经票06 全局队列 opKind="page-retire" 串行执行：
 *                           页迁 `_retired/<原相对路径>` + front-matter 注 superseded
 *                           + **活页入链摘除（票04·故事26，与退役同一 commit）**
 *                           + INDEX 程序化重建摘除 + LOG 追加 `## [date] retire | <path>`
 *                           行 + wiki_articles/FTS 摘除（宿主页正文同步）+ 单 commit 收口。
 *   GET  /retire/task/:id   状态可查 ⇒ { task: PageRetireTaskRecord }（queued→running→
 *                           committed/failed；committed 带 result：retiredPath/retireCommit
 *                           = 退役回执卡数据面）。
 *
 * 错误码沿用 `{error:{code,message}}` 纪律：INVALID_PARAM 400（缺 path/pageId、非法形态）、
 * NOT_FOUND 404（页不在册/wiki 无 git）、MANUAL_FILE_WRITE 403（人工文件 SCHEMA 拒退）、
 * WORKTREE_DIRTY 409。执行级失败（异步任务语义）不改 HTTP 码，落任务 failed + error.code。
 *
 * 恢复镜像通道（票09·故事17 同款接线）= routes/wiki-restore.ts（POST /restore 三口令
 * → 队列 page-restore 原号原行回迁 + 入链 diff 反放）。
 */

interface RetireTaskApi {
  retire(input: PageRetireInput): PageRetireTaskRecord
  get(id: string): PageRetireTaskRecord | undefined
}

export function createWikiRetireRoutes(api: RetireTaskApi): Hono {
  const routes = new Hono()

  routes.post("/retire", async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const p = payload as { path?: unknown; pageId?: unknown; reason?: unknown; replacedBy?: unknown; source?: unknown }
    const hasPath = typeof p.path === "string" && p.path.trim() !== ""
    const hasPageId = typeof p.pageId === "string" && p.pageId.trim() !== ""
    if (!hasPath && !hasPageId) {
      return c.json({ error: { code: "INVALID_PARAM", message: "path or pageId is required" } }, 400)
    }
    const input: PageRetireInput = {
      path: hasPath ? (p.path as string) : undefined,
      pageId: !hasPath && hasPageId ? (p.pageId as string) : undefined,
      reason: typeof p.reason === "string" ? p.reason : undefined,
      // 票04·故事26 / 票09 接缝：supersede 指针与 source 装饰位透传（缺席=旧行为零扰动）
      replacedBy: typeof p.replacedBy === "string" && p.replacedBy.trim() ? p.replacedBy : undefined,
      source: typeof p.source === "string" && p.source.trim() ? p.source : undefined,
    }
    try {
      const task = api.retire(input)
      return c.json({ taskId: task.id, path: task.path, status: task.status }, 202)
    } catch (err) {
      if (err instanceof PageRetireError) {
        return c.json(
          { error: { code: err.code, message: err.message.replace(new RegExp(`^${err.code}: `), "") } },
          err.status,
        )
      }
      const { body, status } = errorResponse(err, "wiki-retire")
      return c.json(body, status)
    }
  })

  routes.get("/retire/task/:id", (c) => {
    const id = c.req.param("id")
    const task = api.get(id)
    if (!task) {
      return c.json({ error: { code: "NOT_FOUND", message: `retire task not found: ${id}` } }, 404)
    }
    return c.json({ task })
  })

  return routes
}
