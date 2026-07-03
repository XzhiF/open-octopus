import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { ChatService } from "../services/chat"
import { WorkspaceService } from "../services/workspace"
import { SSEService } from "../services/sse"
import { getProviderAsync, type TokenUsage } from "@octopus/providers"
import os from "os"

export function chatRoutes(sseService: SSEService, chatService: ChatService, workspaceService: WorkspaceService): Hono {
  const chatRoutes = new Hono()

  function classifyError(error: string): 'auth' | 'rate_limit' | 'timeout' | 'unknown' {
    const lower = String(error).toLowerCase()
    if (['unauthorized', 'credit balance', '401', '403', 'invalid api key', 'authentication', 'auth'].some(p => lower.includes(p))) return 'auth'
    if (['rate limit', 'too many requests', '429', 'overloaded'].some(p => lower.includes(p))) return 'rate_limit'
    if (['timeout', 'produced no output'].some(p => lower.includes(p))) return 'timeout'
    return 'unknown'
  }

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
    const body = await c.req.json<{ content: string }>()




    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: "session not found" }, 404)

    const workspace = workspaceService.getById(session.workspaceId)
    if (!workspace) return c.json({ error: "workspace not found" }, 404)
    const cwd = workspace.path.replace(/^~/, os.homedir())

    // Store user message
    chatService.addMessage(sessionId, {
      role: "user",
      content: body.content,
      metadata: JSON.stringify({ displayType: "user" }),
    })

    const provider = session.provider ?? "claude"
    const agent = await getProviderAsync(provider)

    let fullText = ""
    let sdkMessageId = ""
    let currentTokens: TokenUsage | undefined
    let currentCostUsd: number | undefined
    let thinkingContent = ""
    let thinkingMessageId = ""
    let thinkingStartTime = 0
  let thinkingDurationValue: string | undefined
    const toolCallMap = new Map<string, {
      dbMessageId: string
      toolCallId: string
      toolName: string
      toolInput: unknown
      toolStatus: string
      startTime: number
    }>()

    return streamSSE(c, async (stream) => {
      let aborted = false

      const abortController = new AbortController()
      stream.onAbort(() => {
        aborted = true
        abortController.abort()
      })

      try {
        const chunkStream = agent.sendQuery(body.content, cwd, session.providerSessionId ?? undefined, {
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          abortSignal: abortController.signal,
        })

        for await (const chunk of chunkStream) {
          if (aborted) break

          if (chunk.type === 'local_command_output') {
            fullText += chunk.content
          }

          if (chunk.type === 'text_delta') {
            fullText += chunk.content
          }

          if (chunk.type === 'result' && chunk.content && !fullText) {
            fullText = chunk.content
          }

          if (chunk.type === 'message_start') {
            sdkMessageId = chunk.messageId
          }

          if (chunk.type === 'thinking_start') {
            thinkingContent = ""
            thinkingMessageId = chunk.messageId
            thinkingStartTime = Date.now()
          }

          if (chunk.type === 'thinking') {
            thinkingContent += chunk.content
          }

          if (chunk.type === 'thinking_done') {
            const thinkingDuration = thinkingStartTime > 0
              ? `${((Date.now() - thinkingStartTime) / 1000).toFixed(1)}s`
              : undefined
            thinkingDurationValue = thinkingDuration
            if (thinkingContent) {
              chatService.addMessage(sessionId, {
                role: "assistant",
                type: "thinking",
                content: "",
                metadata: JSON.stringify({
                  displayType: "thinking",
                  thinkingContent,
                  thinkingDone: true,
                  thinkingDuration,
                }),
              })
            }
            thinkingContent = ""
            thinkingMessageId = ""
            thinkingStartTime = 0
          }

          if (chunk.type === 'tool_call_start') {
            toolCallMap.set(chunk.toolCallId, {
              dbMessageId: "",
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              toolInput: undefined,
              toolStatus: "running",
              startTime: Date.now(),
            })
          }

          if (chunk.type === 'tool_call') {
            const entry = toolCallMap.get(chunk.toolCallId)
            if (entry) {
              entry.toolInput = chunk.toolInput
              const msg = chatService.addMessage(sessionId, {
                role: "assistant",
                type: "tool_call",
                content: "",
                metadata: JSON.stringify({
                  displayType: "tool_call",
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  toolInput: chunk.toolInput,
                  toolStatus: "running",
                }),
              })
              entry.dbMessageId = msg.id
            }
          }

          if (chunk.type === 'tool_result') {
            const entry = toolCallMap.get(chunk.toolCallId)
            if (entry && entry.dbMessageId) {
              const durationMs = Date.now() - entry.startTime
              entry.toolStatus = chunk.isError ? "error" : "done"
              chatService.updateMessageMetadata(entry.dbMessageId, JSON.stringify({
                displayType: "tool_call",
                toolCallId: entry.toolCallId,
                toolName: entry.toolName,
                toolInput: entry.toolInput,
                toolStatus: entry.toolStatus,
                toolResult: chunk.content,
                toolDuration: `${(durationMs / 1000).toFixed(1)}s`,
              }))
            }
          }

          if (chunk.type === 'ask_user_question') {
            const entry = toolCallMap.get(chunk.toolCallId)
            if (entry && entry.dbMessageId) {
              entry.toolStatus = "done"
              chatService.updateMessageMetadata(entry.dbMessageId, JSON.stringify({
                displayType: "ask_user_question",
                toolCallId: entry.toolCallId,
                toolName: entry.toolName,
                toolInput: (chunk as { questions: unknown }).questions ?? entry.toolInput,
                toolStatus: "done",
              }))
            }
          }

          if (chunk.type === 'result') {
            if (chunk.sessionId) {
              chatService.updateProviderSession(sessionId, chunk.sessionId)
            }
            currentTokens = chunk.tokens
            currentCostUsd = chunk.costUsd
          }

          const sseExtras: Record<string, unknown> = {}
          if (chunk.type === 'tool_result') {
            const entry = toolCallMap.get(chunk.toolCallId)
            if (entry?.startTime) {
              sseExtras.toolDuration = `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`
            }
          }
          if (chunk.type === 'thinking_done') {
            sseExtras.thinkingDuration = thinkingDurationValue
          }

          const sseData: Record<string, unknown> = {
            sessionId,
            ...chunk,
            ...sseExtras,
          }
          // For result events with empty/undefined content, fallback to accumulated fullText
          // (ensures slash command output like /context reaches the frontend)
          if (chunk.type === 'result' && !chunk.content && fullText) {
            sseData.content = fullText
          }

          await stream.writeSSE({
            event: chunk.type,
            data: JSON.stringify(sseData),
          })
        }

        // Persist full response text with metadata
        if (!aborted) {
          chatService.addMessage(sessionId, {
            role: "assistant",
            content: fullText,
            type: "text",
            metadata: JSON.stringify({
              displayType: 'text',
              tokens: currentTokens,
              costUsd: currentCostUsd,
            }),
          })
        }

        // Notify other tabs session updated
        sseService.emit(workspace.id, {
          event: "session_updated",
          data: { sessionId },
        })
      } catch (error) {
        const err = error as Error
        if (!aborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              sessionId,
              code: classifyError(err.message),
              message: err.message || "未知错误",
            }),
          })
        }
      } finally {
        stream.close()
      }
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
      const agent = await getProviderAsync(provider)
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