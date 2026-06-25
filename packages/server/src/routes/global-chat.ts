import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { ChatService } from "../services/chat"
import { SSEService } from "../services/sse"
import { getProvider, type TokenUsage } from "@octopus/providers"
import fs from "fs"
import path from "path"

// ── System prompt: loaded from octo-scheduler SKILL.md ─────────────

const SKILL_SEARCH_PATHS = [
  // Dev mode: monorepo root
  path.resolve(process.cwd(), 'packages/core-pack/skills/octo-scheduler/SKILL.md'),
  // Prod mode: ~/.octopus/prod/
  path.resolve(process.cwd(), 'packages/core-pack/skills/octo-scheduler/SKILL.md'),
  // Absolute fallback: look in __dirname (server dist might be in ~/.octopus/prod/packages/server/dist)
  path.resolve(__dirname, '../../core-pack/skills/octo-scheduler/SKILL.md'),
  path.resolve(__dirname, '../../../core-pack/skills/octo-scheduler/SKILL.md'),
]

function loadSchedulerSystemPrompt(): string {
  for (const skillPath of SKILL_SEARCH_PATHS) {
    try {
      const content = fs.readFileSync(skillPath, 'utf-8')
      // Strip YAML frontmatter
      return content.replace(/^---[\s\S]*?---\n/, '').trim()
    } catch {
      // Try next path
    }
  }
  // Hardcoded fallback if Skill file is not found
  return [
    '你是 Octopus Scheduler 助手。',
    '通过 curl 调用 http://localhost:3001/api/scheduler/ 的 REST API 管理调度任务。',
    '支持 workflow 和 agent 两种 Job 类型。',
    '所有 PUT 请求必须带 If-Match header（乐观锁）。',
    '创建前先用 POST /cron/parse 验证 Cron 表达式。',
  ].join('\n')
}

const SYSTEM_PROMPT = loadSchedulerSystemPrompt()

/** Convention-based workspace_id for global scheduler chat sessions. */
const GLOBAL_SCOPE_ID = 'global-scheduler-chat'

// ── Route factory ──────────────────────────────────────────────────

export function globalChatRoutes(sseService: SSEService, chatService: ChatService): Hono {
  const router = new Hono()

  function classifyError(error: string): 'auth' | 'rate_limit' | 'timeout' | 'unknown' {
    const lower = String(error).toLowerCase()
    if (['unauthorized', 'credit balance', '401', '403', 'invalid api key', 'authentication', 'auth'].some(p => lower.includes(p))) return 'auth'
    if (['rate limit', 'too many requests', '429', 'overloaded'].some(p => lower.includes(p))) return 'rate_limit'
    if (['timeout', 'produced no output'].some(p => lower.includes(p))) return 'timeout'
    return 'unknown'
  }

  // ── Session CRUD ────────────────────────────────────────────────

  router.post('/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: string }
    const session = chatService.createSession(GLOBAL_SCOPE_ID, body.title)
    return c.json(session, 201)
  })

  router.get('/sessions', (c) => {
    const sessions = chatService.listSessions(GLOBAL_SCOPE_ID)
    return c.json(sessions)
  })

  router.get('/sessions/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId')
    const limit = parseInt(c.req.query('limit') ?? '100', 10)
    const before = c.req.query('before')
    const session = chatService.getSession(sessionId, limit, before ?? undefined)
    if (!session) return c.json({ error: 'Session not found' }, 404)
    return c.json(session)
  })

  router.delete('/sessions/:sessionId', (c) => {
    chatService.deleteSession(c.req.param('sessionId'))
    return c.json({ success: true })
  })

  router.patch('/sessions/:sessionId', async (c) => {
    const { title } = await c.req.json() as { title: string }
    chatService.updateSessionTitle(c.req.param('sessionId'), title)
    return c.json({ success: true })
  })

  // ── Send message + SSE streaming (replicates workspace chat logic) ──

  router.post('/sessions/:sessionId/messages', async (c) => {
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json<{ content: string }>()

    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: 'session not found' }, 404)

    // Global scope: cwd is process.cwd() (scheduler API is localhost)
    const cwd = process.cwd()

    // Store user message
    chatService.addMessage(sessionId, {
      role: 'user',
      content: body.content,
      metadata: JSON.stringify({ displayType: 'user' }),
    })

    const provider = session.provider ?? 'claude'
    const agent = getProvider(provider)

    let fullText = ''
    let sdkMessageId = ''
    let currentTokens: TokenUsage | undefined
    let currentCostUsd: number | undefined
    let thinkingContent = ''
    let thinkingMessageId = ''
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
        // Key: use claude_code preset + append scheduler skill content.
        // Previously passed raw string which REPLACED the entire preset,
        // causing the agent to lose all built-in tool instructions
        // (Bash, Read, Write, etc.) — it knew the API spec but couldn't act.
        const chunkStream = agent.sendQuery(body.content, cwd, session.providerSessionId ?? undefined, {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT },
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
            thinkingContent = ''
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
                role: 'assistant',
                type: 'thinking',
                content: '',
                metadata: JSON.stringify({
                  displayType: 'thinking',
                  thinkingContent,
                  thinkingDone: true,
                  thinkingDuration,
                }),
              })
            }
            thinkingContent = ''
            thinkingMessageId = ''
            thinkingStartTime = 0
          }

          if (chunk.type === 'tool_call_start') {
            toolCallMap.set(chunk.toolCallId, {
              dbMessageId: '',
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              toolInput: undefined,
              toolStatus: 'running',
              startTime: Date.now(),
            })
          }

          if (chunk.type === 'tool_call') {
            const entry = toolCallMap.get(chunk.toolCallId)
            if (entry) {
              entry.toolInput = chunk.toolInput
              const msg = chatService.addMessage(sessionId, {
                role: 'assistant',
                type: 'tool_call',
                content: '',
                metadata: JSON.stringify({
                  displayType: 'tool_call',
                  toolCallId: chunk.toolCallId,
                  toolName: chunk.toolName,
                  toolInput: chunk.toolInput,
                  toolStatus: 'running',
                }),
              })
              entry.dbMessageId = msg.id
            }
          }

          if (chunk.type === 'tool_result') {
            const entry = toolCallMap.get(chunk.toolCallId)
            if (entry && entry.dbMessageId) {
              const durationMs = Date.now() - entry.startTime
              entry.toolStatus = chunk.isError ? 'error' : 'done'
              chatService.updateMessageMetadata(entry.dbMessageId, JSON.stringify({
                displayType: 'tool_call',
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
              entry.toolStatus = 'done'
              chatService.updateMessageMetadata(entry.dbMessageId, JSON.stringify({
                displayType: 'ask_user_question',
                toolCallId: entry.toolCallId,
                toolName: entry.toolName,
                toolInput: (chunk as { questions: unknown }).questions ?? entry.toolInput,
                toolStatus: 'done',
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
            role: 'assistant',
            content: fullText,
            type: 'text',
            metadata: JSON.stringify({
              displayType: 'text',
              tokens: currentTokens,
              costUsd: currentCostUsd,
            }),
          })
        }

        // Note: no workspace-level SSE notification for global scope.
        // (Global chat is single-tab use; no cross-tab sync needed.)
      } catch (error) {
        const err = error as Error
        if (!aborted) {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              sessionId,
              code: classifyError(err.message),
              message: err.message || '未知错误',
            }),
          })
        }
      } finally {
        stream.close()
      }
    })
  })

  // ── Generate title (AI-powered, same as workspace chat) ───────────

  router.post('/sessions/:sessionId/generate-title', async (c) => {
    const sessionId = c.req.param('sessionId')
    const session = chatService.getSession(sessionId)
    if (!session) return c.json({ error: 'session not found' }, 404)

    if (session.title) return c.json({ title: session.title })

    const userMsg = session.messages.find(m => m.role === 'user')
    const assistantMsg = session.messages.find(m => m.role === 'assistant')
    if (!userMsg || !assistantMsg) return c.json({ title: null })

    try {
      const provider = session.provider ?? 'claude'
      const agent = getProvider(provider)
      const prompt = `Generate a short Chinese title (≤20 characters) for this conversation. Only output the title, no extra text.\n\nUser: ${userMsg.content.slice(0, 200)}\nAssistant: ${assistantMsg.content.slice(0, 200)}`
      const stream = agent.sendQuery(prompt, process.cwd())
      let title = ''
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

  return router
}
