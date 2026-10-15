import { Hono } from "hono"
import { PageRestoreError, type PageRestoreTaskRecord, type PageRestoreInput } from "../services/knowledge/wiki/page-restore"
import { errorResponse } from "../services/knowledge/validators"

/**
 * 页恢复路由（票09 · spec 故事17，S2 契约面）——「对话退役一页」通道（routes/
 * wiki-retire.ts）的同款镜像接线，挂 `/api/knowledge/wiki`：
 *
 *   POST /restore           { anchor: "oct-042" } 或 { path: "topics/x.md" } 或 { pageId }
 *                           [, reason] [, source（LOG restore 行 source 位，缺省 dialogue）]
 *                           ⇒ 202 { taskId, path, status:"queued" }
 *                           任务经票06 全局队列 opKind="page-restore" 串行执行：
 *                           _retired/ 原号原行回迁（锚点随迁不重铸——永不复用纪律的
 *                           恢复豁免）+ 入链回补（retire 单 commit diff 反放，漂移让位
 *                           显形 warnings）+ INDEX 复列 + LOG `## [date] restore | <path>`
 *                           行 + DB/FTS 复登 + 单 commit 收口。
 *   GET  /restore/task/:id  状态可查 ⇒ { task: PageRestoreTaskRecord }（committed 带
 *                           result：fromRetired/restoreCommit/inboundRestored/warnings）。
 *
 * 错误码沿用 `{error:{code,message}}` 纪律：INVALID_PARAM 400（口令缺失/回迁位非法）、
 * RESTORE_TARGET_MISSING 404（_retired/ 无此页：未退役/已恢复/锚点未知——幂等二拒）、
 * RESTORE_TARGET_TAKEN 409（原位已有页，不覆盖不并置）、MANUAL_FILE_WRITE 409、
 * NOT_FOUND 404（wiki 无 git）。执行级失败（WORKTREE_DIRTY 等）不改 HTTP 码，
 * 落任务 failed + error.code（revert/retire 头注同律）。
 */

interface RestoreTaskApi {
  restore(input: PageRestoreInput): PageRestoreTaskRecord
  get(id: string): PageRestoreTaskRecord | undefined
}

export function createWikiRestoreRoutes(api: RestoreTaskApi): Hono {
  const routes = new Hono()

  routes.post("/restore", async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const p = payload as { anchor?: unknown; path?: unknown; pageId?: unknown; reason?: unknown; source?: unknown }
    const hasAnchor = typeof p.anchor === "string" && p.anchor.trim() !== ""
    const hasPath = typeof p.path === "string" && p.path.trim() !== ""
    const hasPageId = typeof p.pageId === "string" && p.pageId.trim() !== ""
    if (!hasAnchor && !hasPath && !hasPageId) {
      return c.json({ error: { code: "INVALID_PARAM", message: "anchor or path or pageId is required" } }, 400)
    }
    const input: PageRestoreInput = {
      // 口令优先级（服务面同律）：anchor（对话「恢复 oct-XXX」主形态）> path > pageId
      anchor: hasAnchor ? (p.anchor as string) : undefined,
      path: !hasAnchor && hasPath ? (p.path as string) : undefined,
      pageId: !hasAnchor && !hasPath && hasPageId ? (p.pageId as string) : undefined,
      reason: typeof p.reason === "string" ? p.reason : undefined,
      source: typeof p.source === "string" && p.source.trim() ? p.source : undefined,
    }
    try {
      const task = api.restore(input)
      return c.json({ taskId: task.id, path: task.path, status: task.status }, 202)
    } catch (err) {
      if (err instanceof PageRestoreError) {
        return c.json(
          { error: { code: err.code, message: err.message.replace(new RegExp(`^${err.code}: `), "") } },
          err.status,
        )
      }
      const { body, status } = errorResponse(err, "wiki-restore")
      return c.json(body, status)
    }
  })

  routes.get("/restore/task/:id", (c) => {
    const id = c.req.param("id")
    const task = api.get(id)
    if (!task) {
      return c.json({ error: { code: "NOT_FOUND", message: `restore task not found: ${id}` } }, 404)
    }
    return c.json({ task })
  })

  return routes
}
