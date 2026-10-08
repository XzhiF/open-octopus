import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { ChatService } from "../services/chat"
import { WorkspaceService } from "../services/workspace"
import { SSEService } from "../services/sse"
import { runChatTurn } from "../services/chat-turn"
import { getProvider } from "@octopus/providers"
import { CloneRuntime } from "../services/agent/clone-runtime"
import { getBuiltinCloneDef } from "../services/agent/builtin-clones"
import { taskPoolSystemPrompt } from "../services/scheduler/task-pool-system-prompt"
import os from "os"

export function chatRoutes(sseService: SSEService, chatService: ChatService, workspaceService: WorkspaceService): Hono {
  const chatRoutes = new Hono()

  chatRoutes.post("/sessions", async (c) => {
    const workspaceId = c.req.param("id")!
    let title: string | undefined
    try { title = (await c.req.json<{ title?: string }>()).title } catch { /* no body */ }
    const session = chatService.createSession(workspaceId, title)
    return c.json(session, 201)
  })

  chatRoutes.get("/sessions", (c) => {
    const workspaceId = c.req.param("id")!
    const sessions = chatService.listSessions(workspaceId)
    return c.json(sessions)
  })

  chatRoutes.get("/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    const limit = Number(c.req.query("limit") ?? "0") || undefined
    const before = c.req.query("before") || undefined  // cursor timestamp for "load more"
    const session = chatService.getSession(sessionId, limit, before)
    if (!session) return c.json({ error: "not found" }, 404)
    return c.json(session)
  })

  chatRoutes.delete("/sessions/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")

    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "not found" }, 404)
    chatService.deleteSession(sessionId)
    return c.json({ ok: true })
  })

  chatRoutes.patch("/sessions/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId")
    const body = await c.req.json<{ title?: string }>()
    if (!body.title) return c.json({ error: "title required" }, 400)

    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "not found" }, 404)
    chatService.updateSessionTitle(sessionId, body.title)
    return c.json({ ok: true })
  })

  chatRoutes.post("/sessions/:sessionId/messages", async (c) => {
    const sessionId = c.req.param("sessionId")
    const body = await c.req.json<{ content: string; purpose?: 'requirement' }>()




    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "session not found" }, 404)

    const workspace = workspaceService.getById(session.workspaceId)
    if (!workspace) return c.json({ error: "workspace not found" }, 404)
    const cwd = workspace.path.replace(/^~/, os.homedir())

    const provider = session.provider ?? "claude"

    // Assemble workspace clone system prompt (persona + memory + skills)
    let workspaceClonePrompt = ''
    try {
      const cloneDef = getBuiltinCloneDef('workspace')
      if (cloneDef) {
        workspaceClonePrompt = new CloneRuntime(cloneDef, 'default').assembleContext()
      }
    } catch {
      // Non-fatal — proceed with empty clone prompt (pure claude_code preset)
    }

    // T-2: task-pool hatch mode — replace clone prompt with task-pool system prompt
    // ponytail: replace (not append) because task-pool chat doesn't need workspace persona
    const systemPromptAppend = body.purpose === 'requirement'
      ? taskPoolSystemPrompt
      : (workspaceClonePrompt || undefined)

    // The turn engine lives in services/chat-turn.ts (extracted verbatim for the
    // task-level doer chat, 票01 — one protocol, two entry points).
    return streamSSE(c, async (stream) => {
      await runChatTurn({
        stream,
        chatService,
        sseService,
        sessionId,
        notifyChannel: workspace.id,
        content: body.content,
        cwd,
        provider,
        providerSessionId: session.providerSessionId,
        systemPromptAppend,
      })
    })
  })

  chatRoutes.post("/sessions/:sessionId/generate-title", async (c) => {
    const sessionId = c.req.param("sessionId")

    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "session not found" }, 404)

    if (session.title) return c.json({ title: session.title })

    const userMsg = session.messages.find(m => m.role === "user")
    const assistantMsg = session.messages.find(m => m.role === "assistant")
    if (!userMsg || !assistantMsg) return c.json({ title: null })

    try {
      const provider = session.provider ?? "claude"
      const agent = getProvider(provider)
      const prompt = `Generate a short Chinese title (≤20 characters) for this conversation. Only output the title, no extra text.\n\nUser: ${userMsg.content.slice(0, 200)}\nAssistant: ${assistantMsg.content.slice(0, 200)}`
      const stream = agent.sendQuery(prompt, process.cwd())
      let title = ""
      for await (const chunk of stream) {
        if (chunk.type === 'text_delta') {
          title += chunk.content
        }
      }
      title = title.trim().slice(0, 20)
      if (title) {
        chatService.updateSessionTitle(sessionId, title)
      }
      return c.json({ title: title || null })
    } catch {
      return c.json({ title: null })
    }
  })

  return chatRoutes
}