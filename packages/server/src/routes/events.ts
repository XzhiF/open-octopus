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
 * Global task-pool SSE channel. Kanban /tasks subscribes here for real-time
 * schedule status changes (running / done / rollback). Draft→queued→claimed
 * transitions stay on the existing 10s poll (fast enough); the expensive,
 * user-care-about transitions (task starts running, completes) push instantly.
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