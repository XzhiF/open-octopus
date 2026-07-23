import { streamSSE } from "hono/streaming"
import type { Context } from "hono"
import { ChatService } from "../services/chat"
import { getProvider, type TokenUsage, type MessageChunk, type SendQueryOptions } from "@octopus/providers"

export interface StreamHandlerConfig {
  sessionId: string
  content: string
  cwd: string
  providerSessionId?: string
  systemPrompt: SendQueryOptions["systemPrompt"]
  provider?: string
}

export interface StreamHandlerCallbacks {
  onComplete?: (sessionId: string, fullText: string) => void
  onError?: (sessionId: string, error: Error) => void
}

export class ChatStreamHandler {
  constructor(
    private chatService: ChatService,
    private callbacks: StreamHandlerCallbacks = {}
  ) {}

  async handleStream(c: Context, config: StreamHandlerConfig) {
    const { sessionId, content, cwd, providerSessionId, systemPrompt, provider = "claude" } = config

    const agent = getProvider(provider)

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
        const chunkStream = agent.sendQuery(content, cwd, providerSessionId, {
          systemPrompt,
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
              this.chatService.addMessage(sessionId, {
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
              const msg = this.chatService.addMessage(sessionId, {
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
              this.chatService.updateMessageMetadata(entry.dbMessageId, JSON.stringify({
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
              this.chatService.updateMessageMetadata(entry.dbMessageId, JSON.stringify({
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
              this.chatService.updateProviderSession(sessionId, chunk.sessionId)
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

        if (!aborted) {
          this.chatService.addMessage(sessionId, {
            role: "assistant",
            content: fullText,
            type: "text",
            metadata: JSON.stringify({
              displayType: 'text',
              tokens: currentTokens,
              costUsd: currentCostUsd,
            }),
          })

          if (this.callbacks.onComplete) {
            this.callbacks.onComplete(sessionId, fullText)
          }
        }
      } catch (error) {
        const err = error as Error
        if (!aborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              sessionId,
              code: this.classifyError(err.message),
              message: err.message || "未知错误",
            }),
          })
        }

        if (this.callbacks.onError) {
          this.callbacks.onError(sessionId, err)
        }
      } finally {
        stream.close()
      }
    })
  }

  private classifyError(error: string): 'auth' | 'rate_limit' | 'timeout' | 'unknown' {
    const lower = String(error).toLowerCase()
    if (['unauthorized', 'credit balance', '401', '403', 'invalid api key', 'authentication', 'auth'].some(p => lower.includes(p))) return 'auth'
    if (['rate limit', 'too many requests', '429', 'overloaded'].some(p => lower.includes(p))) return 'rate_limit'
    if (['timeout', 'produced no output'].some(p => lower.includes(p))) return 'timeout'
    return 'unknown'
  }
}
