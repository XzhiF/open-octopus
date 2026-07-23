import type { Hono } from "hono"
import type { ChatService } from "../services/chat"
import { getProvider } from "@octopus/providers"

export function registerSessionRoutes(router: Hono, chatService: ChatService, scopeIdParam: string): void {
  router.post("/sessions", async (c) => {
    const scopeId = c.req.param(scopeIdParam) ?? "global-scheduler-chat"
    let title: string | undefined
    try { title = (await c.req.json<{ title?: string }>()).title } catch { /* no body */ }
    return c.json(chatService.createSession(scopeId, title), 201)
  })

  router.get("/sessions", (c) => {
    const scopeId = c.req.param(scopeIdParam) ?? "global-scheduler-chat"
    return c.json(chatService.listSessions(scopeId))
  })

  router.get("/sessions/:sessionId", (c) => {
    const session = chatService.getSession(c.req.param("sessionId"), Number(c.req.query("limit") ?? "0") || undefined, c.req.query("before") || undefined)
    if (!session) return c.json({ error: "not found" }, 404)
    return c.json(session)
  })

  router.delete("/sessions/:sessionId", (c) => {
    const session = chatService.getSession(c.req.param("sessionId"))
    if (!session) return c.json({ error: "not found" }, 404)
    chatService.deleteSession(c.req.param("sessionId"))
    return c.json({ ok: true })
  })

  router.patch("/sessions/:sessionId", async (c) => {
    const { title } = await c.req.json<{ title?: string }>()
    if (!title) return c.json({ error: "title required" }, 400)
    const session = chatService.getSession(c.req.param("sessionId"))
    if (!session) return c.json({ error: "not found" }, 404)
    chatService.updateSessionTitle(c.req.param("sessionId"), title)
    return c.json({ ok: true })
  })

  router.post("/sessions/:sessionId/generate-title", async (c) => {
    const sessionId = c.req.param("sessionId")
    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "session not found" }, 404)
    if (session.title) return c.json({ title: session.title })

    const userMsg = session.messages.find(m => m.role === "user")
    const assistantMsg = session.messages.find(m => m.role === "assistant")
    if (!userMsg || !assistantMsg) return c.json({ title: null })

    try {
      const agent = getProvider(session.provider ?? "claude")
      const prompt = `Generate a short Chinese title (≤20 characters) for this conversation. Only output the title, no extra text.\n\nUser: ${userMsg.content.slice(0, 200)}\nAssistant: ${assistantMsg.content.slice(0, 200)}`
      let title = ""
      for await (const chunk of agent.sendQuery(prompt, process.cwd())) {
        if (chunk.type === "text_delta") title += chunk.content
      }
      title = title.trim().slice(0, 20)
      if (title) chatService.updateSessionTitle(sessionId, title)
      return c.json({ title: title || null })
    } catch {
      return c.json({ title: null })
    }
  })
}
