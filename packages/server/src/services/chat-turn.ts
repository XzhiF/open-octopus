// packages/server/src/services/chat-turn.ts
//
// The workspace-chat turn engine, extracted from routes/chat.ts so the task-level
// doer chat (taskboard-modal-v2 票01, routes/task-chat.ts) can relay through the
// SAME protocol instead of forking it — 「不新建聊天协议」. Behavior is byte-for-byte
// what chat.ts's POST /sessions/:id/messages handler did before: store the user
// message, stream provider chunks as SSE (thinking / tool cards persisted
// alongside), thread the provider session id, persist the final assistant text,
// emit session_updated, classify errors into one SSE error event.
//

import { SSEService } from "./sse"
import { ChatService } from "./chat"
import { getProvider } from "@octopus/providers"
import type { TokenUsage } from "@octopus/shared"
import { getAgentDir } from "./agent/paths"

/** The slice of hono's SSEStreamingApi the turn engine needs (streamSSE's
 *  callback argument structurally satisfies it). */
export interface ChatTurnStream {
  writeSSE(message: { event: string; data: string }): Promise<void>
  onAbort(cb: () => void): void
  close(): void
}

export interface ChatTurnParams {
  stream: ChatTurnStream
  chatService: ChatService
  sseService: SSEService
  sessionId: string
  /** channel the session_updated notify goes out on (ws-chat: the workspace id). */
  notifyChannel: string
  content: string
  cwd: string
  provider?: string
  providerSessionId?: string | null
  /** preset 'claude_code' + this append (persona / memory / task context). */
  systemPromptAppend?: string
  /**
   * Called once at the very end of the turn — after persistence, BEFORE the
   * stream closes, so the caller can still push trailing SSE frames (the doer
   * chat uses this for the [quick-edit] auto-commit announcement, 票01).
   * Runs on abort and on provider error too: a half-landed edit is still an
   * edit; the engine must not swallow现场 facts on those paths.
   */
  onTurnComplete?: (info: { aborted: boolean; hadError: boolean; fullText: string }) => Promise<void>
}

export interface ChatTurnOutcome {
  /** the accumulated reply text ("" when aborted mid-stream) */
  fullText: string
  aborted: boolean
}

function classifyError(error: string): "auth" | "rate_limit" | "timeout" | "unknown" {
  const lower = String(error).toLowerCase()
  if (["unauthorized", "credit balance", "401", "403", "invalid api key", "authentication", "auth"].some((p) => lower.includes(p))) return "auth"
  if (["rate limit", "too many requests", "429", "overloaded"].some((p) => lower.includes(p))) return "rate_limit"
  if (["timeout", "produced no output"].some((p) => lower.includes(p))) return "timeout"
  return "unknown"
}

export async function runChatTurn(params: ChatTurnParams): Promise<ChatTurnOutcome> {
  const { stream, chatService, sseService, sessionId, notifyChannel, content, cwd } = params

  // Store user message
  chatService.addMessage(sessionId, {
    role: "user",
    content,
    metadata: JSON.stringify({ displayType: "user" }),
  })

  const provider = params.provider ?? "claude"
  const agent = getProvider(provider)

  let fullText = ""
  let currentTokens: TokenUsage | undefined
  let currentCostUsd: number | undefined
  let thinkingContent = ""
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

  let aborted = false
  let hadError = false

  const abortController = new AbortController()
  stream.onAbort(() => {
    aborted = true
    abortController.abort()
  })

  try {
    const chunkStream = agent.sendQuery(content, cwd, params.providerSessionId ?? undefined, {
      systemPrompt: { type: "preset", preset: "claude_code", append: params.systemPromptAppend },
      abortSignal: abortController.signal,
      plugins: [{ type: "local", path: getAgentDir() }],
    })

    for await (const chunk of chunkStream) {
      if (aborted) break

      if (chunk.type === "local_command_output") {
        fullText += chunk.content
      }

      if (chunk.type === "text_delta") {
        fullText += chunk.content
      }

      if (chunk.type === "result" && chunk.content && !fullText) {
        fullText = chunk.content
      }

      if (chunk.type === "thinking_start") {
        thinkingContent = ""
        thinkingStartTime = Date.now()
      }

      if (chunk.type === "thinking") {
        thinkingContent += chunk.content
      }

      if (chunk.type === "thinking_done") {
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
        thinkingStartTime = 0
      }

      if (chunk.type === "tool_call_start") {
        toolCallMap.set(chunk.toolCallId, {
          dbMessageId: "",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          toolInput: undefined,
          toolStatus: "running",
          startTime: Date.now(),
        })
      }

      if (chunk.type === "tool_call") {
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

      if (chunk.type === "tool_result") {
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

      if (chunk.type === "result") {
        if (chunk.sessionId) {
          chatService.updateProviderSession(sessionId, chunk.sessionId)
        }
        currentTokens = chunk.usage
        currentCostUsd = chunk.costUsd
      }

      const sseExtras: Record<string, unknown> = {}
      if (chunk.type === "tool_result") {
        const entry = toolCallMap.get(chunk.toolCallId)
        if (entry?.startTime) {
          sseExtras.toolDuration = `${((Date.now() - entry.startTime) / 1000).toFixed(1)}s`
        }
      }
      if (chunk.type === "thinking_done") {
        sseExtras.thinkingDuration = thinkingDurationValue
      }

      const sseData: Record<string, unknown> = {
        sessionId,
        ...chunk,
        ...sseExtras,
      }
      // For result events with empty/undefined content, fallback to accumulated fullText
      // (ensures slash command output like /context reaches the frontend)
      if (chunk.type === "result" && !chunk.content && fullText) {
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
          displayType: "text",
          usage: currentTokens,
          costUsd: currentCostUsd,
        }),
      })
    }

    // Notify other tabs session updated
    sseService.emit(notifyChannel, {
      event: "session_updated",
      data: { sessionId },
    })
  } catch (error) {
    hadError = true
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
    // trailing-frame window (see onTurnComplete): runs before close so the
    // caller's last events still ride this stream; its own failure must not
    // mask the turn outcome.
    if (params.onTurnComplete) {
      try {
        await params.onTurnComplete({ aborted, hadError, fullText })
      } catch {
        // hook is best-effort by contract
      }
    }
    stream.close()
  }

  return { fullText, aborted }
}
