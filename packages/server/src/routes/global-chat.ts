import { Hono } from "hono"
import { ChatService } from "../services/chat"
import { SSEService } from "../services/sse"
import { ChatStreamHandler } from "../services/chat-stream-handler"
import { registerSessionRoutes } from "./chat-session-routes"
import { loadSchedulerSystemPrompt } from "../services/scheduler-prompt"

const SYSTEM_PROMPT = loadSchedulerSystemPrompt()

export function globalChatRoutes(sseService: SSEService, chatService: ChatService): Hono {
  const router = new Hono()
  registerSessionRoutes(router, chatService, "global-scheduler-chat")

  router.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId")
    const body = await c.req.json<{ content: string }>()
    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "session not found" }, 404)

    chatService.addMessage(sessionId, {
      role: "user",
      content: body.content,
      metadata: JSON.stringify({ displayType: "user" }),
    })

    const handler = new ChatStreamHandler(chatService)

    return handler.handleStream(c, {
      sessionId,
      content: body.content,
      cwd: process.cwd(),
      providerSessionId: session.providerSessionId ?? undefined,
      systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
      provider: session.provider ?? "claude",
    })
  })

  return router
}
