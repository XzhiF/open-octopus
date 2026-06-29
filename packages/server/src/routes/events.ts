import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { SSEService } from "../services/sse"

export function eventRoutes(sse: SSEService): Hono {
  const app = new Hono()

  // ponytail: require auth for SSE subscriptions (SYN-P0-12)
  app.use("*", async (c, next) => {
    const authHeader = c.req.header("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Authorization required for SSE events" } }, 401)
    }
    const expectedToken = process.env.OCTOPUS_AGENT_TOKEN
    if (expectedToken && authHeader.slice(7) !== expectedToken) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid bearer token" } }, 401)
    }
    await next()
  })

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