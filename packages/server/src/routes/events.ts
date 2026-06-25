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