import type { IAgentProvider, SystemPromptInput, GoalTerminalReason } from "@octopus/providers"
import type { EffortLevel, TokenUsage, TokenUsageDelta, ModelUsage } from "@octopus/shared"
import { emptyTokenUsage, addTokenUsage } from "@octopus/shared"
import type { AgentEvent, AgentRunResult } from "./agent-types"

const RESUME_PROMPT = "Your previous session was interrupted mid-execution. Do NOT restart from the beginning. Review what has already been done and continue from the exact point of interruption. If the task appears complete, output your final result."

/** Maximum seconds with no events before aborting the stream (20 minutes). */
const IDLE_TIMEOUT_MS = 20 * 60 * 1000

export class AgentNodeRunner {
  private lastActivityAt: number = 0

  constructor(
    private provider: IAgentProvider,
    private cwd: string,
    readonly onEvent?: (event: AgentEvent) => void,
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
    effort?: EffortLevel
    /** Optional external system prompt (assembled by AgentService).
     *  When provided, overrides the default preset system prompt.
     *  Enables scheduled agent jobs and clone delegation to inject
     *  their own persona + SKILL + memory context (M7 fix). */
    systemPrompt?: SystemPromptInput
    /** Optional callback invoked before each tool call executes.
     *  Used by the Tool Interceptor to block dangerous bash commands.
     *  Return `{ allow: false, reason: string }` to block, or allow/undefined to pass. */
    onBeforeToolCall?: (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined>
    /** Tools to disallow for this agent. Non-interaction agents default to blocking
     *  AskUserQuestion + complete_interaction (interaction-session tools) so they
     *  cannot ask the user mid-execution (would hang or empty-answer). */
    disallowedTools?: string[]
    /** SDK hard fuse — assistant API round-trip cap (claude engine; other
     *  providers ignore the field). Terminal: error_max_turns. */
    maxTurns?: number
    /** SDK hard fuse — USD budget cap (claude engine; other providers ignore
     *  the field). Terminal: error_max_budget_usd. */
    maxBudgetUsd?: number
    /** Base tool set for this agent (SDK `tools`; claude engine only). */
    tools?: string[]
  }): Promise<AgentRunResult> {
    const start = Date.now()
    const maxRetries = opts.maxRetries ?? 1
    const canResume = opts.context === "continue" && !!opts.previousSessionId

    const events: AgentEvent[] = []
    let textBuffer = ""
    let finalSessionId: string | undefined
    let finalUsage: TokenUsage | undefined
    let finalModelUsages: ModelUsage[] | undefined
    let finalCostUsd: number | undefined
    /** SDK hard-fuse terminal detected on the stream (error_max_turns / error_max_budget_usd).
     *  NOT an exception — the run is authoritative and returns with evidence attached. */
    let terminal: { reason: GoalTerminalReason; numTurns?: number; costUsd?: number } | undefined

    // 实时 usage 跟踪：turn 按 message_start 计数，cumulative 跨 resume attempt 累计。
    // 权威终值仍以 result/node_end 为准，这里只服务运行中展示。
    let liveTurnCount = 0
    let liveTurnTotal: TokenUsage = emptyTokenUsage()

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
            effort: opts.effort,
            maxTurns: opts.maxTurns,
            maxBudgetUsd: opts.maxBudgetUsd,
            tools: opts.tools,
            systemPrompt: opts.systemPrompt ?? { type: "preset", preset: "claude_code" },
            abortSignal: localAbort.signal,
            onBeforeToolCall: opts.onBeforeToolCall,
            // Non-interaction agents must be autonomous: block interaction-session
            // tools so they cannot ask the user mid-execution (would hang/empty-answer).
            disallowedTools: ["AskUserQuestion", "complete_interaction", ...(opts.disallowedTools ?? [])],
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
              emit({ type: "tool_result", toolCallId: chunk.toolCallId, toolName: chunk.toolName, content: chunk.content, isError: chunk.isError, duration: chunk.toolDuration, timestamp: ts })
              break
            case "text_delta":
              textBuffer += chunk.content
              emit({ type: "text_delta", content: chunk.content, timestamp: ts })
              break
            case "status":
              emit({ type: "status", status: chunk.status, timestamp: ts })
              break
            case "active_goal":
              // Convergence evidence from the SDK /goal evaluator — passthrough
              // into the events pipeline (JSONL/SSE compaction passes unknown
              // agent_event subtypes through unchanged).
              emit({
                type: "active_goal",
                condition: chunk.condition,
                iterations: chunk.iterations,
                last_reason: chunk.last_reason,
                set_at: chunk.set_at,
                timestamp: ts,
              })
              break
            case "message_start":
              liveTurnCount++
              break
            case "message_delta": {
              const delta: TokenUsageDelta | undefined = chunk.usage
                ?? (typeof chunk.outputTokens === "number" ? { outputTokens: chunk.outputTokens } : undefined)
              if (!delta) break
              liveTurnTotal = addTokenUsage(liveTurnTotal, delta)
              emit({ type: "turn_usage", turn: Math.max(liveTurnCount, 1), delta, cumulative: liveTurnTotal, timestamp: ts })
              break
            }
            case "result":
              receivedResult = true
              finalSessionId = chunk.sessionId
              finalUsage = chunk.usage
              finalModelUsages = chunk.modelUsages
              finalCostUsd = chunk.costUsd
              break
            case "error":
              emit({ type: "error", code: chunk.code, message: chunk.message, timestamp: ts })
              // SDK hard-fuse terminals (error_max_turns / error_max_budget_usd)
              // are NORMAL terminal states, not exceptions: the run stopped by
              // policy and the caller maps it to a failed node with evidence.
              if (chunk.terminalReason) {
                terminal = {
                  reason: chunk.terminalReason,
                  numTurns: chunk.numTurns,
                  costUsd: chunk.costUsd,
                }
                if (chunk.sessionId) finalSessionId = chunk.sessionId
                break
              }
              throw new Error(`Agent error: ${chunk.code} - ${chunk.message}`)
          }

          if (terminal) break
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

      // SDK hard-fuse terminal — return the run with terminal metadata,
      // bypassing both the retry loop and the stream-fracture throw below.
      if (terminal) {
        return {
          finalText: textBuffer,
          sessionId: finalSessionId,
          usage: finalUsage,
          modelUsages: finalModelUsages,
          costUsd: terminal.costUsd ?? finalCostUsd,
          events,
          durationMs: Date.now() - start,
          llmCalls: this.provider.getLLMCalls?.() ?? [],
          terminalReason: terminal.reason,
          terminalMeta: { numTurns: terminal.numTurns, costUsd: terminal.costUsd },
        }
      }

      if (receivedResult) {
        return {
          finalText: textBuffer,
          sessionId: finalSessionId,
          usage: finalUsage,
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
