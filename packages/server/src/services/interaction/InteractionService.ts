// packages/server/src/services/interaction/InteractionService.ts
//
// InteractionService — manages interaction node conversations within workflows.
// Replaces ChatBridge for session management, handles SSE streaming via the
// Claude SDK provider, stores messages in interaction_messages table.

import { randomUUID } from "crypto"
import type { IAgentProvider, MessageChunk, TokenUsage } from "@octopus/providers"
import { getProvider } from "@octopus/providers"
import { extractInteractionCompletion } from "@octopus/engine"
import type Database from "better-sqlite3"
import { InteractionMessageDAO } from "../../db/dao/interaction-message-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import type { InteractionMessageRow, AgentEventRow } from "../../db/types"
import { SSEService } from "../sse"
import { getAgentDir } from "../agent/paths"
import { INTERACTION_SYSTEM_PROMPT } from "./prompts"

/** In-memory tracking for an active interaction session. */
interface InteractionSessionInfo {
  sessionId: string
  executionId: string
  nodeId: string
  workspaceId: string
  display: "modal" | "panel"
  maxRounds: number
  currentRound: number
  providerSessionId?: string
  nodeExecutionId: string
  startedAt: number
  timeout?: number
  initialPrompt?: string
}

/** SSE event shape emitted by sendMessage. */
export interface InteractionSSEEvent {
  type: string
  [key: string]: unknown
}

/** Start interaction parameters. */
interface StartParams {
  workspaceId: string
  executionId: string
  nodeId: string
  display?: "modal" | "panel"
  title?: string
  initialPrompt?: string
  maxRounds?: number
  timeout?: number
}

/**
 * InteractionService manages workflow interaction node conversations.
 *
 * Responsibilities:
 * - In-memory session tracking (replacing ChatBridge)
 * - SSE streaming via Claude SDK provider
 * - Message persistence to interaction_messages table
 * - Agent event recording for key interaction milestones
 * - Token/cost tracking to node_token_usages + llm_calls
 * - Completion detection and workflow resumption
 */
export class InteractionService {
  private sessions = new Map<string, InteractionSessionInfo>()

  constructor(
    private db: Database.Database,
    private messageDao: InteractionMessageDAO,
    private tokenDao: TokenUsageDAO,
    private execDao: ExecutionDAO,
    private sse: SSEService,
  ) {}

  /** Build session key from execution + node IDs. */
  private key(executionId: string, nodeId: string): string {
    return `${executionId}:${nodeId}`
  }

  /**
   * Start an interaction session.
   * Called when frontend receives execution_interaction_started SSE.
   * Idempotent — returns existing session if already active.
   */
  startInteraction(params: StartParams): { sessionId: string; initialPrompt?: string } {
    const k = this.key(params.executionId, params.nodeId)

    // Return existing session if already tracked (e.g., page refresh)
    const existing = this.sessions.get(k)
    if (existing) {
      return { sessionId: existing.sessionId, initialPrompt: existing.initialPrompt }
    }

    // Find the node execution row to get nodeExecutionId
    const nodeExecId = `${params.executionId}-${params.nodeId}`

    const session: InteractionSessionInfo = {
      sessionId: randomUUID(),
      executionId: params.executionId,
      nodeId: params.nodeId,
      workspaceId: params.workspaceId,
      display: params.display ?? "modal",
      maxRounds: params.maxRounds ?? 20,
      currentRound: 0,
      nodeExecutionId: nodeExecId,
      startedAt: Date.now(),
      timeout: params.timeout,
      initialPrompt: params.initialPrompt,
    }

    this.sessions.set(k, session)

    // Record interaction_started event
    this.insertAgentEvent(nodeExecId, "interaction_started", {
      display: session.display,
      maxRounds: session.maxRounds,
    })

    return { sessionId: session.sessionId, initialPrompt: params.initialPrompt }
  }

  /**
   * Send a user message and stream SSE response.
   * Yields SSE events for the frontend to consume.
   */
  async *sendMessage(params: {
    executionId: string
    nodeId: string
    content: string
    cwd: string
  }): AsyncGenerator<InteractionSSEEvent> {
    const k = this.key(params.executionId, params.nodeId)
    const session = this.sessions.get(k)
    if (!session) {
      yield { type: "error", code: "NO_SESSION", message: "No active interaction session" }
      return
    }

    // Check max rounds
    session.currentRound++
    if (session.currentRound > session.maxRounds) {
      yield { type: "error", code: "MAX_ROUNDS", message: "Maximum conversation rounds reached" }
      return
    }

    const now = new Date().toISOString()

    // Save user message
    this.messageDao.insertMessage({
      id: randomUUID(),
      execution_id: params.executionId,
      node_id: params.nodeId,
      role: "user",
      type: "text",
      content: params.content,
      metadata: JSON.stringify({ displayType: "user" }),
      created_at: now,
    })

    // Get the provider
    const agent: IAgentProvider = getProvider("claude")
    const agentDir = getAgentDir()

    // Build send options
    let fullText = ""
    let assistantMessageId = ""
    let thinkingContent = ""
    let thinkingMessageId = ""
    let thinkingStartTime = 0
    let currentTokens: TokenUsage | undefined
    let currentCostUsd: number | undefined
    const toolCallMap = new Map<string, { dbId: string; toolName: string; startTime: number }>()
    let completionDetected: { summary: string; vars_update?: Record<string, unknown> } | null = null

    // Create assistant message placeholder
    assistantMessageId = randomUUID()
    this.messageDao.insertMessage({
      id: assistantMessageId,
      execution_id: params.executionId,
      node_id: params.nodeId,
      role: "assistant",
      type: "text",
      content: "",
      metadata: null,
      created_at: new Date().toISOString(),
    })

    try {
      const chunkStream = agent.sendQuery(params.content, params.cwd, session.providerSessionId, {
        systemPrompt: { type: "preset", preset: "claude_code", append: INTERACTION_SYSTEM_PROMPT },
        interactionSession: true,
        plugins: [{ type: "local", path: agentDir }],
      })

      for await (const chunk of chunkStream) {
        const events = this.processChunk(chunk, {
          session,
          getFullText: () => fullText,
          setFullText: (v: string) => { fullText = v },
          getAssistantMessageId: () => assistantMessageId,
          getThinkingContent: () => thinkingContent,
          setThinkingContent: (v: string) => { thinkingContent = v },
          getThinkingMessageId: () => thinkingMessageId,
          setThinkingMessageId: (v: string) => { thinkingMessageId = v },
          getThinkingStartTime: () => thinkingStartTime,
          setThinkingStartTime: (v: number) => { thinkingStartTime = v },
          toolCallMap,
          setCompletion: (c: { summary: string; vars_update?: Record<string, unknown> }) => { completionDetected = c },
          setProviderSessionId: (id: string) => { session.providerSessionId = id },
          setTokens: (t: TokenUsage) => { currentTokens = t },
          setCost: (c: number) => { currentCostUsd = c },
        })

        for (const event of events) {
          yield event
        }
      }
    } catch (error) {
      yield {
        type: "error",
        code: "STREAM_ERROR",
        message: error instanceof Error ? error.message : String(error),
      }
      return
    }

    // Save final assistant text if non-empty
    if (fullText) {
      this.db.prepare(
        "UPDATE interaction_messages SET content = ?, metadata = ? WHERE id = ?"
      ).run(fullText, JSON.stringify({
        displayType: "text",
        tokens: currentTokens,
        costUsd: currentCostUsd,
      }), assistantMessageId)
    }

    // Write token usage
    if (currentTokens) {
      this.tokenDao.insert({
        id: randomUUID(),
        node_execution_id: session.nodeExecutionId,
        model: "claude-sonnet-4-20250514",
        input_tokens: currentTokens.input ?? 0,
        output_tokens: currentTokens.output ?? 0,
        cost_usd: currentCostUsd ?? null,
        cache_read_tokens: currentTokens.cacheRead ?? 0,
        cache_creation_tokens: currentTokens.cacheCreation ?? 0,
        created_at: new Date().toISOString(),
      })
    }

    // Yield final result event
    yield {
      type: "result",
      sessionId: session.sessionId,
      tokens: currentTokens,
      costUsd: currentCostUsd,
    }

    // Check for completion (tool call path or text fallback)
    if (completionDetected) {
      // Record interaction_completed event
      this.insertAgentEvent(session.nodeExecutionId, "interaction_completed", {
        summary: completionDetected.summary,
      })

      // Trigger workflow completion
      yield { type: "interaction_complete", summary: completionDetected.summary, vars_update: completionDetected.vars_update }

      // Clean up session
      this.sessions.delete(k)

      // Call ExecutionLifecycle.completeInteraction via SSE to trigger engine resume
      // The route handler will catch this and call the lifecycle method
    } else if (fullText) {
      // Fallback: try to extract completion from text
      const extracted = extractInteractionCompletion(fullText)
      if (extracted) {
        this.insertAgentEvent(session.nodeExecutionId, "interaction_completed", {
          summary: extracted.summary,
        })
        yield { type: "interaction_complete", summary: extracted.summary, vars_update: extracted.vars_update }
        this.sessions.delete(k)
      }
    }
  }

  /**
   * Process a single MessageChunk into SSE events and side effects.
   */
  private processChunk(
    chunk: MessageChunk,
    ctx: {
      session: InteractionSessionInfo
      getFullText: () => string
      setFullText: (v: string) => void
      getAssistantMessageId: () => string
      getThinkingContent: () => string
      setThinkingContent: (v: string) => void
      getThinkingMessageId: () => string
      setThinkingMessageId: (v: string) => void
      getThinkingStartTime: () => number
      setThinkingStartTime: (v: number) => void
      toolCallMap: Map<string, { dbId: string; toolName: string; startTime: number }>
      setCompletion: (c: { summary: string; vars_update?: Record<string, unknown> }) => void
      setProviderSessionId: (id: string) => void
      setTokens: (t: TokenUsage) => void
      setCost: (c: number) => void
    },
  ): InteractionSSEEvent[] {
    const events: InteractionSSEEvent[] = []
    const { session } = ctx

    switch (chunk.type) {
      case "text_delta":
        ctx.setFullText(ctx.getFullText() + chunk.content)
        events.push({ type: "text_delta", content: chunk.content, sessionId: session.sessionId })
        break

      case "message_start":
        events.push({ type: "message_start", messageId: chunk.messageId, sessionId: session.sessionId })
        break

      case "thinking_start":
        ctx.setThinkingStartTime(Date.now())
        ctx.setThinkingMessageId(randomUUID())
        // Save thinking message placeholder
        this.messageDao.insertMessage({
          id: ctx.getThinkingMessageId(),
          execution_id: session.executionId,
          node_id: session.nodeId,
          role: "assistant",
          type: "thinking",
          content: "",
          metadata: null,
          created_at: new Date().toISOString(),
        })
        events.push({ type: "thinking_start", sessionId: session.sessionId })
        break

      case "thinking":
        ctx.setThinkingContent(ctx.getThinkingContent() + chunk.content)
        events.push({ type: "thinking", content: chunk.content, sessionId: session.sessionId })
        break

      case "thinking_done": {
        const duration = chunk.thinkingDuration ?? `${Date.now() - ctx.getThinkingStartTime()}ms`
        if (ctx.getThinkingMessageId() && ctx.getThinkingContent()) {
          this.db.prepare(
            "UPDATE interaction_messages SET content = ?, metadata = ? WHERE id = ?"
          ).run(ctx.getThinkingContent(), JSON.stringify({ thinkingDuration: duration }), ctx.getThinkingMessageId())
        }
        events.push({ type: "thinking_done", thinkingDuration: duration, sessionId: session.sessionId })
        break
      }

      case "tool_call_start": {
        const toolDbId = randomUUID()
        ctx.toolCallMap.set(chunk.toolCallId, { dbId: toolDbId, toolName: chunk.toolName, startTime: Date.now() })
        this.messageDao.insertMessage({
          id: toolDbId,
          execution_id: session.executionId,
          node_id: session.nodeId,
          role: "assistant",
          type: "tool_call",
          content: chunk.toolName,
          metadata: JSON.stringify({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            toolStatus: "running",
            displayType: "tool_call",
          }),
          created_at: new Date().toISOString(),
        })
        events.push({ type: "tool_call_start", toolCallId: chunk.toolCallId, toolName: chunk.toolName, sessionId: session.sessionId })
        break
      }

      case "tool_call": {
        const info = ctx.toolCallMap.get(chunk.toolCallId)
        if (info) {
          const existing = this.messageDao.findMessageById(info.dbId)
          if (existing) {
            const meta = JSON.parse(existing.metadata ?? "{}")
            meta.toolInput = chunk.toolInput
            this.messageDao.updateMessageMetadata(info.dbId, JSON.stringify(meta))
          }
        }
        events.push({ type: "tool_call", toolCallId: chunk.toolCallId, toolInput: chunk.toolInput, sessionId: session.sessionId })
        break
      }

      case "tool_result": {
        const info = ctx.toolCallMap.get(chunk.toolCallId)
        if (info) {
          const existing = this.messageDao.findMessageById(info.dbId)
          if (existing) {
            const meta = JSON.parse(existing.metadata ?? "{}")
            meta.toolStatus = chunk.isError ? "error" : "done"
            meta.toolResult = chunk.result
            meta.toolDuration = `${Date.now() - info.startTime}ms`
            this.messageDao.updateMessageMetadata(info.dbId, JSON.stringify(meta))
          }
        }
        events.push({ type: "tool_result", toolCallId: chunk.toolCallId, result: chunk.result, isError: chunk.isError, sessionId: session.sessionId })
        break
      }

      case "ask_user_question": {
        // Update the tool_call message with question data
        const info = ctx.toolCallMap.get(chunk.toolCallId)
        if (info) {
          const existing = this.messageDao.findMessageById(info.dbId)
          if (existing) {
            const meta = JSON.parse(existing.metadata ?? "{}")
            meta.displayType = "ask_user_question"
            meta.questions = chunk.questions
            this.messageDao.updateMessageMetadata(info.dbId, JSON.stringify(meta))
          }
        }
        // Record event
        this.insertAgentEvent(session.nodeExecutionId, "interaction_ask_user_question", {
          questions: chunk.questions,
        })
        events.push({ type: "ask_user_question", toolCallId: chunk.toolCallId, questions: chunk.questions, sessionId: session.sessionId })
        break
      }

      case "complete_interaction": {
        ctx.setCompletion({
          summary: chunk.summary,
          vars_update: chunk.vars_update,
        })
        events.push({ type: "complete_interaction", summary: chunk.summary, sessionId: session.sessionId })
        break
      }

      case "result": {
        if (chunk.sessionId) ctx.setProviderSessionId(chunk.sessionId)
        if (chunk.tokens) ctx.setTokens(chunk.tokens)
        if (chunk.costUsd !== undefined) ctx.setCost(chunk.costUsd)
        // Don't yield result here — we yield it after the loop
        break
      }

      case "error":
        events.push({ type: "error", code: chunk.code, message: chunk.message, sessionId: session.sessionId })
        break

      case "local_command_output":
        ctx.setFullText(ctx.getFullText() + chunk.content + "\n")
        events.push({ type: "local_command_output", content: chunk.content, sessionId: session.sessionId })
        break

      default:
        // Pass through other chunk types
        events.push({ type: chunk.type, sessionId: session.sessionId, ...chunk } as InteractionSSEEvent)
        break
    }

    return events
  }

  /**
   * Get message history for an interaction.
   */
  getMessages(params: {
    executionId: string
    nodeId: string
    limit?: number
    before?: string
  }): InteractionMessageRow[] {
    return this.messageDao.findMessages(params.executionId, params.nodeId, {
      limit: params.limit,
      before: params.before,
    })
  }

  /**
   * Get interaction session status.
   */
  getSessionStatus(executionId: string, nodeId: string): InteractionSessionInfo | null {
    return this.sessions.get(this.key(executionId, nodeId)) ?? null
  }

  /**
   * Force complete an interaction (admin/timeout).
   */
  forceComplete(params: {
    executionId: string
    nodeId: string
    summary: string
    varsUpdate?: Record<string, unknown>
  }): { ok: boolean } {
    const k = this.key(params.executionId, params.nodeId)
    this.sessions.delete(k)
    return { ok: true }
  }

  /**
   * Clean up a session (called after completion is processed by the route).
   */
  cleanupSession(executionId: string, nodeId: string): void {
    this.sessions.delete(this.key(executionId, nodeId))
  }

  /** Helper: insert an agent event for interaction milestones. */
  private insertAgentEvent(nodeExecutionId: string, eventType: string, content: unknown): void {
    try {
      const row: AgentEventRow = {
        node_execution_id: nodeExecutionId,
        event_order: Date.now(),
        turn_index: 0,
        event_type: eventType,
        timestamp: Date.now(),
        content: JSON.stringify(content),
        content_length: JSON.stringify(content).length,
        tool_call_id: null,
        tool_name: null,
        tool_input: null,
        tool_result: null,
        tool_is_error: 0,
        tool_duration_ms: null,
        status_value: null,
        error_code: null,
        error_message: null,
      }
      this.execDao.insertAgentEvent(row)
    } catch {
      // Non-fatal — agent events are supplementary
    }
  }
}
