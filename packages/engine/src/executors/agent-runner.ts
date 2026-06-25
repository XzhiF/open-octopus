import type { IAgentProvider, TokenUsage, ModelUsageEntry, SystemPromptInput } from "@octopus/providers"
import type { AgentEvent, AgentRunResult } from "./agent-types"

const RESUME_PROMPT = "Your previous session was interrupted mid-execution. Do NOT restart from the beginning. Review what has already been done and continue from the exact point of interruption. If the task appears complete, output your final result."

/** Maximum seconds with no events before aborting the stream (20 minutes). */
const IDLE_TIMEOUT_MS = 20 * 60 * 1000

export class AgentNodeRunner {
  private lastActivityAt: number = 0

  constructor(
    private provider: IAgentProvider,
    private cwd: string,
    private onEvent?: (event: AgentEvent) => void,
  ) {}

  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  getCwd(): string {
    return this.cwd
  }

  async run(opts: {
    prompt: string
    agent?: string
    skills?: string[]
    model?: string
    context: "new" | "continue"
    previousSessionId?: string
    signal?: AbortSignal
    onActivity?: () => void
    agents?: Record<string, any>
    maxRetries?: number
    /** Optional external system prompt (assembled by AgentService).
     *  When provided, overrides the default preset system prompt.
     *  Enables scheduled agent jobs and clone delegation to inject
     *  their own persona + SKILL + memory context (M7 fix). */
    systemPrompt?: SystemPromptInput
  }): Promise<AgentRunResult> {
    const start = Date.now()
    const maxRetries = opts.maxRetries ?? 1
    const canResume = opts.context === "continue" && !!opts.previousSessionId

    const events: AgentEvent[] = []
    let textBuffer = ""
    let finalSessionId: string | undefined
    let finalTokens: TokenUsage | undefined
    let finalModelUsages: ModelUsageEntry[] | undefined
    let finalCostUsd: number | undefined

    const emit = (event: AgentEvent) => {
      events.push(event)
      this.onEvent?.(event)
    }

    const updateActivity = () => {
      this.lastActivityAt = Date.now()
      opts.onActivity?.()
    }

    // Track attempts: 0 = original, 1 = first resume
    let attempts = 0
    const maxAttempts = maxRetries + 1

    while (attempts < maxAttempts) {
      // Don't retry if already aborted (e.g. timeout during previous attempt)
      if (opts.signal?.aborted) break

      const isResume = attempts > 0
      const currentPrompt = isResume ? RESUME_PROMPT : opts.prompt
      const resumeSessionId = isResume
        ? opts.previousSessionId
        : (opts.context === "continue" ? opts.previousSessionId : undefined)

      // ★ Create a local AbortController that combines external signal + idle timeout.
      // If no events arrive within IDLE_TIMEOUT_MS, abort the stream to prevent
      // indefinite hanging (e.g. Claude SDK session state issues after pause/resume).
      const localAbort = new AbortController()
      let idleTimer: ReturnType<typeof setTimeout> | undefined

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          localAbort.abort()
        }, IDLE_TIMEOUT_MS)
      }

      // Forward external abort to local controller
      if (opts.signal) {
        if (opts.signal.aborted) {
          localAbort.abort()
        } else {
          opts.signal.addEventListener("abort", () => localAbort.abort(), { once: true })
        }
      }

      resetIdleTimer()

      let receivedResult = false
      let idleTimedOut = false

      try {
        const stream = this.provider.sendQuery(
          currentPrompt,
          this.cwd,
          resumeSessionId,
          {
            model: opts.model,
            agent: opts.agent,
            skills: opts.skills,
            agents: opts.agents,
            systemPrompt: opts.systemPrompt ?? { type: "preset", preset: "claude_code" },
            abortSignal: localAbort.signal,
          },
        )

        for await (const chunk of stream) {
          if (localAbort.signal.aborted) break
          const ts = Date.now()
          updateActivity()
          resetIdleTimer()

          switch (chunk.type) {
            case "thinking_start":
              emit({ type: "thinking_start", timestamp: ts })
              break
            case "thinking":
              emit({ type: "thinking", content: chunk.content, timestamp: ts })
              break
            case "thinking_done":
              emit({ type: "thinking_done", duration: chunk.thinkingDuration, timestamp: ts })
              break
            case "tool_call_start":
              emit({ type: "tool_start", toolCallId: chunk.toolCallId, toolName: chunk.toolName, timestamp: ts })
              break
            case "tool_call":
              emit({ type: "tool_input", toolCallId: chunk.toolCallId, toolName: chunk.toolName, input: chunk.toolInput, timestamp: ts })
              break
            case "tool_result":
              emit({ type: "tool_result", toolCallId: chunk.toolCallId, content: chunk.content, isError: chunk.isError, duration: chunk.toolDuration, timestamp: ts })
              break
            case "text_delta":
              textBuffer += chunk.content
              emit({ type: "text_delta", content: chunk.content, timestamp: ts })
              break
            case "status":
              emit({ type: "status", status: chunk.status, timestamp: ts })
              break
            case "result":
              receivedResult = true
              finalSessionId = chunk.sessionId
              finalTokens = chunk.tokens
              finalModelUsages = chunk.modelUsages
              finalCostUsd = chunk.costUsd
              break
            case "error":
              emit({ type: "error", code: chunk.code, message: chunk.message, timestamp: ts })
              throw new Error(`Agent error: ${chunk.code} - ${chunk.message}`)
          }
        }
      } catch (err: unknown) {
        // Distinguish idle timeout from other errors
        if (localAbort.signal.aborted && !opts.signal?.aborted) {
          idleTimedOut = true
          const ts = Date.now()
          emit({
            type: "error",
            code: "idle_timeout",
            message: `Agent stream idle for ${IDLE_TIMEOUT_MS / 1000}s with no events — aborted`,
            timestamp: ts,
          })
        } else {
          throw err
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }

      if (receivedResult) {
        return {
          finalText: textBuffer,
          sessionId: finalSessionId,
          tokens: finalTokens,
          modelUsages: finalModelUsages,
          costUsd: finalCostUsd,
          events,
          durationMs: Date.now() - start,
          llmCalls: this.provider.getLLMCalls?.() ?? [],
        }
      }

      // Idle timeout — don't retry, surface the error immediately
      if (idleTimedOut) {
        throw new Error(
          `Agent stream idle timeout (${IDLE_TIMEOUT_MS / 1000}s). ` +
          `Text length: ${textBuffer.length}, events: ${events.length}. ` +
          `The agent session may be in a broken state — try pausing and resuming with intervention.`
        )
      }

      // Stream fracture detected
      attempts++
      if (attempts < maxAttempts && canResume) {
        const ts = Date.now()
        emit({ type: "status", status: "resuming_after_crash", timestamp: ts })
      } else {
        break
      }
    }

    // All attempts exhausted
    throw new Error(
      `Agent stream ended without result event — possible stream fracture. ` +
      `Text length: ${textBuffer.length}, events: ${events.length}, attempts: ${attempts}`
    )
  }
}
