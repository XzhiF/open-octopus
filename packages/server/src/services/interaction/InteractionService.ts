// packages/server/src/services/interaction/InteractionService.ts
//
// InteractionService — manages interaction node conversations within workflows.
// Replaces ChatBridge for session management, handles SSE streaming via the
// Claude SDK provider, stores messages in interaction_messages table.

import { randomUUID } from "crypto"
import type { IAgentProvider, MessageChunk, TokenUsage } from "@octopus/providers"
import { getProvider } from "@octopus/providers"
import { extractInteractionCompletion } from "@octopus/engine"
import { InteractionMessageDAO } from "../../db/dao/interaction-message-dao"
import { TokenUsageDAO } from "../../db/dao/token-usage-dao"
import { ExecutionDAO } from "../../db/dao/execution-dao"
import type { InteractionMessageRow, AgentEventRow, LlmCallRow } from "../../db/types"
import { SSEService } from "../sse"
import { getAgentDir } from "../agent/paths"
import { INTERACTION_SYSTEM_PROMPT } from "./prompts"

/** Callback to trigger workflow completion via ExecutionLifecycle. */
export type CompleteInteractionFn = (
  workspaceId: string,
  executionId: string,
  nodeId: string,
  summary: string,
  varsUpdate?: Record<string, unknown>,
) => Promise<void>

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

/** Accumulator for stream processing state. */
class StreamAccumulator {
  fullText = ""
  assistantMessageId: string
  thinkingContent = ""
  thinkingMessageId = ""
  thinkingStartTime = 0
  tokens?: TokenUsage
  costUsd?: number
  completionDetected: { summary: string; vars_update?: Record<string, unknown> } | null = null
  llmCallStartTime = Date.now()
  toolCallMap = new Map<string, { dbId: string; toolName: string; startTime: number }>()

  constructor() {
    this.assistantMessageId = randomUUID()
  }
}

/** Merge JSON metadata updates into an existing metadata string. */
function mergeMetadata(existing: string | null, updates: Record<string, unknown>): string {
  const meta = JSON.parse(existing ?? "{}")
  return JSON.stringify({ ...meta, ...updates })
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
    private messageDao: InteractionMessageDAO,
    private tokenDao: TokenUsageDAO,
    private execDao: ExecutionDAO,
    private sse: SSEService,
    private onCompleteInteraction: CompleteInteractionFn,
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

    // Look up the real node execution ID from DB
    const nodeExecRow = this.execDao.findNodeExecution(params.executionId, params.nodeId)
    const nodeExecId = nodeExecRow?.id ?? `${params.executionId}-${params.nodeId}`

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

    // Check max round
    session.currentRound++
    if (session.currentRound > session.maxRounds) {
      yield { type: "error", code: "MAX_ROUNDS", message: "Maximum conversation rounds reached" }
      return
    }

    // Save user message
    this.messageDao.insertMessage({
      id: randomUUID(),
      execution_id: params.executionId,
      node_id: params.nodeId,
      role: "user",
      type: "text",
      content: params.content,
      metadata: JSON.stringify({ displayType: "user" }),
      created_at: new Date().toISOString(),
    })

    const acc = new StreamAccumulator()

    // Create assistant message placeholder
    this.messageDao.insertMessage({
      id: acc.assistantMessageId,
      execution_id: params.executionId,
      node_id: params.nodeId,
      role: "assistant",
      type: "text",
      content: "",
      metadata: null,
      created_at: new Date().toISOString(),
    })

    // Get the provider and start streaming
    const agent: IAgentProvider = getProvider("claude")
    const agentDir = getAgentDir()

    try {
      const chunkStream = agent.sendQuery(params.content, params.cwd, session.providerSessionId, {
        systemPrompt: { type: "preset", preset: "claude_code", append: INTERACTION_SYSTEM_PROMPT },
        interactionSession: true,
        plugins: [{ type: "local", path: agentDir }],
      })

      for await (const chunk of chunkStream) {
        const events = this.processChunk(chunk, session, acc)
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

    // Finalize: save assistant text, write token usage + llm_calls
    this.finalizeAssistantMessage(acc, session)
    this.writeTokenUsage(acc, session)
    this.writeLlmCall(acc, session)

    // Yield final result event
    yield {
      type: "result",
      sessionId: session.sessionId,
      tokens: acc.tokens,
      costUsd: acc.costUsd,
    }

    // Check for completion (tool call path or text fallback)
    const completion = acc.completionDetected ?? this.tryExtractCompletion(acc.fullText)
    if (completion) {
      // Record interaction_completed event
      this.insertAgentEvent(session.nodeExecutionId, "interaction_completed", {
        summary: completion.summary,
      })

      yield { type: "interaction_complete", summary: completion.summary, vars_update: completion.vars_update }

      // Clean up session
      this.sessions.delete(k)

      // Call ExecutionLifecycle.completeInteraction via the injected callback
      try {
        await this.onCompleteInteraction(
          session.workspaceId,
          session.executionId,
          session.nodeId,
          completion.summary,
          completion.vars_update,
        )
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[interaction] completeInteraction failed:", err)
      }
    }
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
   * Persists a completion message, writes an agent event, and returns
   * completion data for the route handler to call completeInteraction.
   */
  forceComplete(params: {
    executionId: string
    nodeId: string
    summary: string
    varsUpdate?: Record<string, unknown>
  }): { ok: boolean; summary: string; vars_update?: Record<string, unknown> } {
    const k = this.key(params.executionId, params.nodeId)
    const session = this.sessions.get(k)
    const nodeExecId = session?.nodeExecutionId ?? `${params.executionId}-${params.nodeId}`

    // Persist completion message to interaction_messages
    this.messageDao.insertMessage({
      id: randomUUID(),
      execution_id: params.executionId,
      node_id: params.nodeId,
      role: "system",
      type: "text",
      content: params.summary,
      metadata: JSON.stringify({ displayType: "force_complete", vars_update: params.varsUpdate }),
      created_at: new Date().toISOString(),
    })

    // Write agent event for the completion
    this.insertAgentEvent(nodeExecId, "interaction_completed", {
      summary: params.summary,
      vars_update: params.varsUpdate,
      source: "force_complete",
    })

    // Clean up in-memory session
    this.sessions.delete(k)

    return { ok: true, summary: params.summary, vars_update: params.varsUpdate }
  }

  /**
   * Clean up a session (called after completion is processed by the route).
   */
  cleanupSession(executionId: string, nodeId: string): void {
    this.sessions.delete(this.key(executionId, nodeId))
  }

  // ── Private: Stream chunk dispatch ────────────────────────────────

  /**
   * Process a single MessageChunk into SSE events and side effects.
   * Dispatches to type-specific handler methods.
   */
  private processChunk(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    switch (chunk.type) {
      case "text_delta":       return this.handleTextDelta(chunk, session, acc)
      case "message_start":    return this.handleMessageStart(chunk, session)
      case "thinking_start":   return this.handleThinkingStart(chunk, session, acc)
      case "thinking":         return this.handleThinking(chunk, session, acc)
      case "thinking_done":    return this.handleThinkingDone(chunk, session, acc)
      case "tool_call_start":  return this.handleToolCallStart(chunk, session, acc)
      case "tool_call":        return this.handleToolCall(chunk, session, acc)
      case "tool_result":      return this.handleToolResult(chunk, session, acc)
      case "ask_user_question": return this.handleAskUserQuestion(chunk, session, acc)
      case "complete_interaction": return this.handleCompleteInteraction(chunk, session, acc)
      case "result":           return this.handleResult(chunk, session, acc)
      case "error":            return this.handleError(chunk, session)
      case "local_command_output": return this.handleLocalCommandOutput(chunk, session, acc)
      default:                 return this.handleDefault(chunk, session)
    }
  }

  // ── Private: Chunk type handlers ──────────────────────────────────

  private handleTextDelta(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    acc.fullText += chunk.content
    return [{ type: "text_delta", content: chunk.content, sessionId: session.sessionId }]
  }

  private handleMessageStart(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
  ): InteractionSSEEvent[] {
    return [{ type: "message_start", messageId: chunk.messageId, sessionId: session.sessionId }]
  }

  private handleThinkingStart(
    _chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    acc.thinkingStartTime = Date.now()
    acc.thinkingMessageId = randomUUID()
    this.messageDao.insertMessage({
      id: acc.thinkingMessageId,
      execution_id: session.executionId,
      node_id: session.nodeId,
      role: "assistant",
      type: "thinking",
      content: "",
      metadata: null,
      created_at: new Date().toISOString(),
    })
    return [{ type: "thinking_start", sessionId: session.sessionId }]
  }

  private handleThinking(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    acc.thinkingContent += chunk.content
    return [{ type: "thinking", content: chunk.content, sessionId: session.sessionId }]
  }

  private handleThinkingDone(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    const duration = chunk.thinkingDuration ?? `${Date.now() - acc.thinkingStartTime}ms`
    if (acc.thinkingMessageId && acc.thinkingContent) {
      this.messageDao.updateMessageContentAndMetadata(
        acc.thinkingMessageId,
        acc.thinkingContent,
        JSON.stringify({ thinkingDuration: duration }),
      )
    }
    return [{ type: "thinking_done", thinkingDuration: duration, sessionId: session.sessionId }]
  }

  private handleToolCallStart(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    const toolDbId = randomUUID()
    acc.toolCallMap.set(chunk.toolCallId, { dbId: toolDbId, toolName: chunk.toolName, startTime: Date.now() })
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
    return [{ type: "tool_call_start", toolCallId: chunk.toolCallId, toolName: chunk.toolName, sessionId: session.sessionId }]
  }

  private handleToolCall(
    chunk: MessageChunk,
    _session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    const info = acc.toolCallMap.get(chunk.toolCallId)
    if (info) {
      const existing = this.messageDao.findMessageById(info.dbId)
      if (existing) {
        this.messageDao.updateMessageMetadata(
          info.dbId,
          mergeMetadata(existing.metadata, { toolInput: chunk.toolInput }),
        )
      }
    }
    return [{ type: "tool_call", toolCallId: chunk.toolCallId, toolInput: chunk.toolInput, sessionId: _session.sessionId }]
  }

  private handleToolResult(
    chunk: MessageChunk,
    _session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    const info = acc.toolCallMap.get(chunk.toolCallId)
    if (info) {
      const existing = this.messageDao.findMessageById(info.dbId)
      if (existing) {
        this.messageDao.updateMessageMetadata(
          info.dbId,
          mergeMetadata(existing.metadata, {
            toolStatus: chunk.isError ? "error" : "done",
            toolResult: chunk.result,
            toolDuration: `${Date.now() - info.startTime}ms`,
          }),
        )
      }
    }
    return [{ type: "tool_result", toolCallId: chunk.toolCallId, result: chunk.result, isError: chunk.isError, sessionId: _session.sessionId }]
  }

  private handleAskUserQuestion(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    const info = acc.toolCallMap.get(chunk.toolCallId)
    if (info) {
      const existing = this.messageDao.findMessageById(info.dbId)
      if (existing) {
        this.messageDao.updateMessageMetadata(
          info.dbId,
          mergeMetadata(existing.metadata, {
            displayType: "ask_user_question",
            questions: chunk.questions,
          }),
        )
      }
    }
    this.insertAgentEvent(session.nodeExecutionId, "interaction_ask_user_question", {
      questions: chunk.questions,
    })
    return [{ type: "ask_user_question", toolCallId: chunk.toolCallId, questions: chunk.questions, sessionId: session.sessionId }]
  }

  private handleCompleteInteraction(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    acc.completionDetected = {
      summary: chunk.summary,
      vars_update: chunk.vars_update,
    }
    return [{ type: "complete_interaction", summary: chunk.summary, sessionId: session.sessionId }]
  }

  private handleResult(
    chunk: MessageChunk,
    _session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    if (chunk.sessionId) _session.providerSessionId = chunk.sessionId
    if (chunk.tokens) acc.tokens = chunk.tokens
    if (chunk.costUsd !== undefined) acc.costUsd = chunk.costUsd
    // Don't yield result here — we yield it after the loop in sendMessage
    return []
  }

  private handleError(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
  ): InteractionSSEEvent[] {
    return [{ type: "error", code: chunk.code, message: chunk.message, sessionId: session.sessionId }]
  }

  private handleLocalCommandOutput(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
    acc: StreamAccumulator,
  ): InteractionSSEEvent[] {
    acc.fullText += chunk.content + "\n"
    return [{ type: "local_command_output", content: chunk.content, sessionId: session.sessionId }]
  }

  private handleDefault(
    chunk: MessageChunk,
    session: InteractionSessionInfo,
  ): InteractionSSEEvent[] {
    return [{ type: chunk.type, sessionId: session.sessionId, ...chunk } as InteractionSSEEvent]
  }

  // ── Private: Finalization helpers ─────────────────────────────────

  /** Save the final assistant text if non-empty. */
  private finalizeAssistantMessage(acc: StreamAccumulator, _session: InteractionSessionInfo): void {
    if (acc.fullText) {
      this.messageDao.updateMessageContentAndMetadata(
        acc.assistantMessageId,
        acc.fullText,
        JSON.stringify({
          displayType: "text",
          tokens: acc.tokens,
          costUsd: acc.costUsd,
        }),
      )
    }
  }

  /** Write aggregated token usage to node_token_usages. */
  private writeTokenUsage(acc: StreamAccumulator, session: InteractionSessionInfo): void {
    if (!acc.tokens) return
    this.tokenDao.insert({
      id: randomUUID(),
      node_execution_id: session.nodeExecutionId,
      model: "claude-sonnet-4-20250514",
      input_tokens: acc.tokens.input ?? 0,
      output_tokens: acc.tokens.output ?? 0,
      cost_usd: acc.costUsd ?? null,
      cache_read_tokens: acc.tokens.cacheRead ?? 0,
      cache_creation_tokens: acc.tokens.cacheCreation ?? 0,
      created_at: new Date().toISOString(),
    })
  }

  /** Write per-call details to llm_calls table. */
  private writeLlmCall(acc: StreamAccumulator, session: InteractionSessionInfo): void {
    if (!acc.tokens) return
    const now = Date.now()
    const llmCallRow: LlmCallRow = {
      id: randomUUID(),
      node_execution_id: session.nodeExecutionId,
      execution_id: session.executionId,
      turn_index: session.currentRound,
      call_index: 0,
      message_id: acc.assistantMessageId,
      model: "claude-sonnet-4-20250514",
      stop_reason: acc.completionDetected ? "end_turn" : null,
      timestamp: acc.llmCallStartTime,
      duration_ms: now - acc.llmCallStartTime,
      ttft_ms: null,
      input_tokens: acc.tokens.input ?? 0,
      output_tokens: acc.tokens.output ?? 0,
      cache_read_tokens: acc.tokens.cacheRead ?? 0,
      cache_creation_tokens: acc.tokens.cacheCreation ?? 0,
      cost_usd: acc.costUsd ?? null,
      org: null,
      workspace_id: session.workspaceId,
      workflow_ref: null,
      node_id: session.nodeId,
      session_id: session.providerSessionId ?? null,
      instance_id: null,
    }
    this.tokenDao.insertLlmCall(llmCallRow)
  }

  /** Try to extract completion from full text as a fallback. */
  private tryExtractCompletion(fullText: string): { summary: string; vars_update?: Record<string, unknown> } | null {
    if (!fullText) return null
    return extractInteractionCompletion(fullText) ?? null
  }

  // ── Private: Agent event helper ───────────────────────────────────

  /** Insert an agent event for interaction milestones. */
  private insertAgentEvent(nodeExecutionId: string, eventType: string, content: unknown): void {
    try {
      const contentStr = JSON.stringify(content)
      const row: AgentEventRow = {
        node_execution_id: nodeExecutionId,
        event_order: Date.now(),
        turn_index: 0,
        event_type: eventType,
        timestamp: Date.now(),
        content: contentStr,
        content_length: contentStr.length,
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
