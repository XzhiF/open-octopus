// packages/server/src/routes/task-chat.ts
//
// taskboard-modal-v2 票01 (S1) — the ONLY task-level chat entry:
//
//   GET  /api/tasks/:id/chat   → ensure (lazy-create, idempotent) the task's
//                                single task-doer session.
//   POST /api/tasks/:id/chat   → SSE turn answered by task-doer, with the
//                                task context injected (phase/round, batch dir
//                                spec family, runbook, 写纪律) and every
//                                effective edit auto-committed on the
//                                execution branch with a [quick-edit] marker.
//
// All behavior lives behind TaskDoerService (services/tasks/task-doer-service);
// this layer only maps errors to statuses (same classification table as
// routes/tasks.ts). The three chat forms the feature needs — 快速修改 /
// 人工接管 (票08) / 修复轮追加指令 — all speak through this one seam; the UI
// never resolves session ownership itself (US38).
//

import { Hono } from "hono"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { TaskNotFoundError, TaskStatusConflictError } from "../services/tasks/tasks-service"
import type { TaskDoerService } from "../services/tasks/task-doer-service"

function classifyError(err: unknown): { status: number; message: string } {
  if (err instanceof TaskNotFoundError) return { status: 404, message: err.message }
  if (err instanceof TaskStatusConflictError) return { status: 409, message: err.message }
  const msg = err instanceof Error ? err.message : String(err)
  return { status: 500, message: msg }
}

export function createTaskChatRoutes(doer: TaskDoerService): Hono {
  const routes = new Hono()

  routes.get("/:id/chat", (c) => {
    try {
      const s = doer.ensureSession(c.req.param("id")!)
      return c.json({
        task_id: s.taskId,
        session_id: s.sessionId,
        workspace_id: s.workspaceId,
        created: s.created,
      })
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }
  })

  const messageHandler = async (c: Context) => {
    const taskId = c.req.param("id")!
    let body: { content?: unknown } | null
    try {
      body = await c.req.json<{ content?: unknown }>().catch(() => null)
    } catch {
      body = null
    }
    const content = typeof body?.content === "string" ? body.content.trim() : ""
    if (!content) return c.json({ error: "content 必填（非空字符串）" }, 400)

    // 404/409 在流开始前定掉（状态码就是状态码，不混进 SSE 帧）。
    try {
      doer.ensureSession(taskId)
    } catch (err) {
      const { status, message } = classifyError(err)
      return c.json({ error: message }, status)
    }

    return streamSSE(c, async (stream) => {
      await doer.streamTurn(taskId, content, stream)
    })
  }

  // Canonical path is POST /api/tasks/:id/chat（票面 S1）；/chat/messages 是
  // spec 行文里的同义别名，两处行为完全一致。
  routes.post("/:id/chat", messageHandler)
  routes.post("/:id/chat/messages", messageHandler)

  return routes
}
