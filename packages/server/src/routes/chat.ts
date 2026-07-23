import { Hono } from "hono"
import { ChatService } from "../services/chat"
import { WorkspaceService } from "../services/workspace"
import { SSEService } from "../services/sse"
import { ChatStreamHandler } from "../services/chat-stream-handler"
import { registerSessionRoutes } from "./chat-session-routes"
import os from "os"

export function chatRoutes(sseService: SSEService, chatService: ChatService, workspaceService: WorkspaceService): Hono {
  const router = new Hono()
  registerSessionRoutes(router, chatService, "id")

  router.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId")
    const body = await c.req.json<{ content: string }>()
    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "session not found" }, 404)

    const workspace = workspaceService.getById(session.workspaceId)
    if (!workspace) return c.json({ error: "workspace not found" }, 404)
    const cwd = workspace.path.replace(/^~/, os.homedir())

    chatService.addMessage(sessionId, {
      role: "user",
      content: body.content,
      metadata: JSON.stringify({ displayType: "user" }),
    })

    const handler = new ChatStreamHandler(chatService, {
      onComplete: (sessionId) => {
        sseService.emit(workspace.id, {
          event: "session_updated",
          data: { sessionId },
        })
      },
    })

    return handler.handleStream(c, {
      sessionId,
      content: body.content,
      cwd,
      providerSessionId: session.providerSessionId ?? undefined,
      systemPrompt: { type: "preset", preset: "claude_code" },
      provider: session.provider ?? "claude",
    })
  })

  return router
}
