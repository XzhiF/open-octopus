// packages/server/src/services/chat-bridge.ts
//
// Chat Bridge — connects WorkflowEngine execution context with ChatService sessions.
// Responsible for creating interaction sessions, monitoring completion signals,
// and constructing NodeExecutionResult when interaction completes.
//
// NOTE: ChatBridge uses ChatDAO directly for interaction-specific operations,
// keeping ChatService untouched (separation of concerns).

import type { ChatDAO } from "../db/dao/chat-dao"
import type { ChatSessionRow } from "../db/types"
import { randomUUID } from "crypto"

/** Tool definition for complete_interaction, registered with the Agent SDK. */
export const COMPLETE_INTERACTION_TOOL = {
  name: "complete_interaction",
  description: "当你认为已收集到足够信息时调用此工具结束交互。调用后交互节点将完成，工作流继续下一步。",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string",
        description: "交互结果摘要，概述收集到的关键信息",
      },
      vars_update: {
        type: "object",
        description: "要写入 VarPool 的变量键值对（可选）",
      },
    },
    required: ["summary"],
  },
}

/** Completion data extracted from a complete_interaction tool call. */
export interface InteractionCompletionData {
  summary: string
  vars_update?: Record<string, any>
}

/** Options for creating an interaction session. */
export interface CreateInteractionOptions {
  workspaceId: string
  executionId: string
  nodeId: string
  display?: "modal" | "panel"
  title?: string
  /** Initial prompt to send as the first message in the chat session. */
  initialPrompt?: string
}

/**
 * ChatBridge manages the lifecycle of interaction sessions.
 * It creates sessions, tracks their state, and detects completion signals.
 * Uses ChatDAO directly — does NOT modify ChatService.
 */
export class ChatBridge {
  private activeSessions = new Map<string, {
    sessionId: string
    executionId: string
    nodeId: string
    display: "modal" | "panel"
    maxRounds: number
    currentRound: number
    exitWhen?: string
    timeout?: number
    startedAt: number
  }>()

  constructor(
    private dao: ChatDAO,
  ) {}

  /**
   * Create a new interaction session linked to a workflow execution.
   * Uses ChatDAO directly to avoid modifying ChatService.
   */
  createInteractionSession(opts: CreateInteractionOptions): ChatSessionRow {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.dao.insertSession({
      id,
      workspace_id: opts.workspaceId,
      title: opts.title ?? `Interaction: ${opts.nodeId}`,
      created_at: now,
      updated_at: now,
      linked_execution_id: opts.executionId,
      linked_node_id: opts.nodeId,
      interaction_mode: opts.display ?? "modal",
      interaction_status: "active",
    })

    return this.dao.findSessionById(id)!
  }

  /**
   * Find an active interaction session by execution and node.
   */
  findActiveSession(executionId: string, nodeId: string): ChatSessionRow | null {
    return this.dao.findInteractionSession(executionId, nodeId)
  }

  /**
   * Register an active interaction session for tracking.
   * Called when the engine enters pending_interaction state.
   */
  trackSession(params: {
    sessionId: string
    executionId: string
    nodeId: string
    display: "modal" | "panel"
    maxRounds?: number
    exitWhen?: string
    timeout?: number
  }): void {
    this.activeSessions.set(params.sessionId, {
      sessionId: params.sessionId,
      executionId: params.executionId,
      nodeId: params.nodeId,
      display: params.display,
      maxRounds: params.maxRounds ?? 20,
      currentRound: 0,
      exitWhen: params.exitWhen,
      timeout: params.timeout,
      startedAt: Date.now(),
    })
  }

  /**
   * Record a new round of conversation in the tracked session.
   * Returns true if max_rounds has been reached.
   */
  recordRound(sessionId: string): boolean {
    const tracked = this.activeSessions.get(sessionId)
    if (!tracked) return false
    tracked.currentRound++
    return tracked.currentRound >= tracked.maxRounds
  }

  /**
   * Get the current round count for a tracked session.
   */
  getCurrentRound(sessionId: string): number {
    return this.activeSessions.get(sessionId)?.currentRound ?? 0
  }

  /**
   * Check if a session has timed out.
   */
  isTimedOut(sessionId: string): boolean {
    const tracked = this.activeSessions.get(sessionId)
    if (!tracked || !tracked.timeout) return false
    const elapsed = (Date.now() - tracked.startedAt) / 1000
    return elapsed >= tracked.timeout
  }

  /**
   * Mark an interaction session as complete.
   */
  completeSession(sessionId: string, status: "completed" | "timeout" = "completed"): void {
    this.dao.updateInteractionStatus(sessionId, status)
    this.dao.updateSession(sessionId, { is_active: 0 })
    this.activeSessions.delete(sessionId)
  }

  /**
   * Get tracked session info.
   */
  getTrackedSession(sessionId: string) {
    return this.activeSessions.get(sessionId)
  }

  /**
   * Force complete an interaction session (admin/timeout intervention).
   */
  forceComplete(
    executionId: string,
    nodeId: string,
    summary: string,
    varsUpdate?: Record<string, any>,
  ): InteractionCompletionData {
    const session = this.dao.findInteractionSession(executionId, nodeId)
    if (session) {
      this.completeSession(session.id)
    }
    return { summary, vars_update: varsUpdate }
  }
}
