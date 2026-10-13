import { Hono } from "hono"
import { RevertError, type RevertTaskRecord } from "../services/knowledge/wiki/revert"
import { errorResponse } from "../services/knowledge/validators"

/**
 * 回滚路由（知识中心票12 AC5，S2 契约面）——挂 `/api/knowledge/wiki`：
 *
 *   POST /revert            { commit: "<hash>" }  diff 卡「回滚本次编译」入口
 *                           ⇒ 202 { taskId, commit, status:"queued" }
 *                           任务经票06 全局队列 opKind="revert" 串行执行：
 *                           git revert 单 commit + INDEX/LOG/FTS 重同步 + LOG 追加
 *                           `## [date] revert | compile <short>` 行。
 *   GET  /revert/task/:id   状态可查 ⇒ { task: RevertTaskRecord }（状态流转
 *                           queued → running → committed/failed；committed 带 result：
 *                           revertCommit/触及页清单 = 回滚回执卡数据面）。
 *
 * 错误码沿用 `{error:{code,message}}` 纪律：
 * INVALID_PARAM 400（非 JSON/缺 commit/坏 hash 形）· NOT_FOUND 404（目标 commit
 * 不在 wiki 仓/任务不存在）。执行级失败（REVERT_CONFLICT/LOCK_HELD/WORKTREE_DIRTY）
 * 不改 HTTP 码（异步任务语义），落任务 failed + error.code，经 GET task 可查。
 */

interface RevertTaskApi {
  revert(commit: string): RevertTaskRecord
  get(id: string): RevertTaskRecord | undefined
}

export function createWikiRevertRoutes(api: RevertTaskApi): Hono {
  const routes = new Hono()

  routes.post("/revert", async (c) => {
    const payload = await c.req.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return c.json({ error: { code: "INVALID_PARAM", message: "A JSON object body is required" } }, 400)
    }
    const commit = (payload as { commit?: unknown }).commit
    if (typeof commit !== "string" || commit.trim() === "") {
      return c.json({ error: { code: "INVALID_PARAM", message: "commit is required (wiki commit hash)" } }, 400)
    }
    try {
      const task = api.revert(commit)
      return c.json({ taskId: task.id, commit: task.commit, status: task.status }, 202)
    } catch (err) {
      if (err instanceof RevertError) {
        return c.json({ error: { code: err.code, message: err.message.replace(new RegExp(`^${err.code}: `), "") } }, err.status)
      }
      const { body, status } = errorResponse(err, "wiki-revert")
      return c.json(body, status)
    }
  })

  routes.get("/revert/task/:id", (c) => {
    const id = c.req.param("id")
    const task = api.get(id)
    if (!task) {
      return c.json({ error: { code: "NOT_FOUND", message: `revert task not found: ${id}` } }, 404)
    }
    return c.json({ task })
  })

  return routes
}
