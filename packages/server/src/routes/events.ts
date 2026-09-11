import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { SSEService } from "../services/sse"

export function eventRoutes(sse: SSEService): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    const workspaceId = c.req.param("id")
    return streamSSE(c, async (stream) => {
      const unsub = sse.subscribe(workspaceId, (event) => {
        stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) })
      })
      const interval = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: new Date().toISOString() }) })
      }, 30000)
      stream.onAbort(() => { unsub(); clearInterval(interval) })
      while (true) { await stream.sleep(1000) }
    })
  })

  return app
}

/**
 * Global task-pool SSE channel. /tasks (kanban) and the 系统调度页 subscribe here.
 *
 * 票03 (ADR-0021) changed what flows on it: the scheduler's `schedule_status` mirror of
 * task rows is gone — that event now describes a job's own run-state only (queued/claimed/
 * aborted on the pump, still tested by 07-sse-schedule-status). The task vocabulary is the
 * task domain's own: `task_execution` (a run moved: armed → running → terminal, with
 * `reason` on the red paths) and `task_status` (the task card's column moved). Every
 * terminal write on a task run owes exactly one of these, including 中止 (票05): a
 * transition that only touches the row is invisible until the board's next poll, and the
 * poll has no reason to show.
 */
export function taskpoolEventRoutes(sse: SSEService): Hono {
  const app = new Hono()

  app.get("/", (c) => {
    return streamSSE(c, async (stream) => {
      const unsub = sse.subscribe("taskpool", (event) => {
        stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) })
      })
      const interval = setInterval(() => {
        stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ ts: new Date().toISOString() }) })
      }, 30000)
      stream.onAbort(() => { unsub(); clearInterval(interval) })
      while (true) { await stream.sleep(1000) }
    })
  })

  return app
}