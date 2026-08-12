// packages/server/src/services/harness/harness-agent-session.ts
//
// HarnessAgentSession — manages the per-execution agent session lifecycle (ticket 10).
//
// Each workflow execution gets one HarnessAgentSession that:
// - Stores workflow context (YAML, node list, dependency graph, varpool snapshot)
// - Accumulates conversation history across multiple interventions
// - Records intervention decisions for summary generation
// - Produces a summary on execution end for persistence to executions.harness_summary
//
// This implements the "session per execution" model from spec §11.

import type { DiagnosisReport, DelegationResult, HarnessDecisionType } from "@octopus/shared"

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Initial context for a harness agent session.
 * Provides the agent with workflow-level information.
 */
export interface HarnessSessionContext {
  /** Full workflow YAML content. */
  workflowContent: string
  /** List of nodes in the workflow. */
  nodeList: Array<{ id: string; type: string }>
  /** Dependency graph: nodeId → list of dependency nodeIds. */
  dependencyGraph: Record<string, string[]>
  /** Initial variable pool snapshot. */
  varpoolSnapshot: Record<string, any>
  /** The execution ID this session belongs to. */
  executionId: string
}

/**
 * State captured at the time of an intervention.
 */
export interface InterventionState {
  /** Current variable pool snapshot at intervention time. */
  varpoolSnapshot: Record<string, any>
}

/**
 * A recorded intervention in the session history.
 */
export interface SessionIntervention {
  /** The node that was intervened on. */
  nodeId: string
  /** The diagnosis report that triggered the intervention. */
  report: DiagnosisReport
  /** The decision made by the harness agent. */
  decision: HarnessDecisionType
  /** The reasoning behind the decision. */
  reason: string
  /** Timestamp of the intervention. */
  timestamp: number
}

/**
 * Summary produced when a session is closed.
 * Written to executions.harness_summary.
 */
export interface HarnessSessionSummary {
  /** Total number of interventions in this execution. */
  totalInterventions: number
  /** List of decisions made during the execution. */
  decisions: Array<{
    node: string
    decision: string
    reason: string
  }>
  /** The overall harness status for this execution. */
  harnessStatus: "intervened" | "blocked" | "delegated"
}

/**
 * A message in the conversation history.
 */
export interface ConversationMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/**
 * Options for creating a HarnessAgentSession.
 */
export interface HarnessAgentSessionOptions {
  /** Timeout for individual interventions in milliseconds. Default: 5 minutes. */
  timeoutMs?: number
}

// ─── Session Class ──────────────────────────────────────────────────────────

/**
 * HarnessAgentSession — manages conversation state for a single execution.
 *
 * Lifecycle:
 * 1. Created in HarnessController.onExecutionStart() with workflow context
 * 2. Interventions appended via appendIntervention() + recordDecision()
 * 3. Closed in HarnessController.onExecutionEnd() to produce summary
 */
export class HarnessAgentSession {
  private context: HarnessSessionContext
  private messages: ConversationMessage[] = []
  private interventions: SessionIntervention[] = []
  /** Pending reports keyed by nodeId — populated by appendIntervention, consumed by recordDecision. */
  private pendingReports = new Map<string, DiagnosisReport>()
  private closed: boolean = false
  private _timeoutMs: number

  constructor(context: HarnessSessionContext, options?: HarnessAgentSessionOptions) {
    this.context = context
    this._timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000 // 5 minutes default

    // Initialize conversation with system message containing workflow context
    this.messages.push({
      role: "system",
      content: this.buildInitialContextMessage(),
    })
  }

  /**
   * Get the execution ID this session belongs to.
   */
  get executionId(): string {
    return this.context.executionId
  }

  /**
   * Check if the session is closed.
   */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Get the timeout for individual interventions.
   */
  get timeoutMs(): number {
    return this._timeoutMs
  }

  /**
   * Get the initial context (for testing).
   */
  getInitialContext(): HarnessSessionContext {
    return this.context
  }

  /**
   * Get all conversation messages (for testing and prompt construction).
   */
  getMessages(): ConversationMessage[] {
    return [...this.messages]
  }

  /**
   * Get the conversation history as a read-only array.
   */
  get conversationHistory(): ReadonlyArray<ConversationMessage> {
    return this.messages
  }

  /**
   * Get all recorded interventions.
   */
  getInterventions(): SessionIntervention[] {
    return [...this.interventions]
  }

  /**
   * Append a new intervention to the session.
   * Adds the DiagnosisReport and current state as a user message.
   *
   * @throws Error if the session is closed
   */
  appendIntervention(report: DiagnosisReport, state: InterventionState): void {
    if (this.closed) {
      throw new Error(`Cannot append to closed session for execution ${this.executionId}`)
    }

    // Store the report so recordDecision can retrieve it (ticket 03)
    this.pendingReports.set(report.nodeId, report)

    const message = this.buildInterventionMessage(report, state)
    this.messages.push({
      role: "user",
      content: message,
    })
  }

  /**
   * Record a decision made by the harness agent.
   * Called after appendIntervention() and after the agent responds.
   */
  recordDecision(nodeId: string, decision: DelegationResult): void {
    // Retrieve the stored report, or fall back to search (ticket 03)
    const report = this.pendingReports.get(nodeId) ?? this.findLastReportForNode(nodeId)

    // Clean up pending report after recording
    this.pendingReports.delete(nodeId)

    this.interventions.push({
      nodeId,
      report,
      decision: decision.decision,
      reason: decision.reasoning,
      timestamp: Date.now(),
    })
  }

  /**
   * Append the assistant's response to the conversation.
   * Called after the agent produces a decision.
   */
  appendAssistantResponse(response: string): void {
    if (this.closed) {
      throw new Error(`Cannot append to closed session for execution ${this.executionId}`)
    }

    this.messages.push({
      role: "assistant",
      content: response,
    })
  }

  /**
   * Close the session and produce a summary.
   * Called by HarnessController.onExecutionEnd().
   */
  close(): void {
    this.closed = true
  }

  /**
   * Get the session summary for persistence to executions.harness_summary.
   * Returns null if no interventions occurred.
   */
  getSummary(): HarnessSessionSummary | null {
    if (this.interventions.length === 0) {
      return null
    }

    return {
      totalInterventions: this.interventions.length,
      decisions: this.interventions.map((i) => ({
        node: i.nodeId,
        decision: i.decision,
        reason: i.reason,
      })),
      harnessStatus: this.computeHarnessStatus(),
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Build the initial system message with workflow context.
   */
  private buildInitialContextMessage(): string {
    const nodeListStr = this.context.nodeList
      .map((n) => `- ${n.id} (${n.type})`)
      .join("\n")

    const depGraphStr = Object.entries(this.context.dependencyGraph)
      .map(([node, deps]) => {
        if (deps.length === 0) return `- ${node}: (no dependencies)`
        return `- ${node}: depends on [${deps.join(", ")}]`
      })
      .join("\n")

    const varpoolStr = Object.entries(this.context.varpoolSnapshot)
      .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n")

    return `你是 Octopus 工作流安全守护 Agent。你正在监控以下工作流执行：

## 工作流定义
${this.context.workflowContent}

## 节点列表
${nodeListStr}

## 依赖关系图
${depGraphStr}

## 初始变量池
${varpoolStr || "(empty)"}

你的任务是分析执行过程中出现的异常，并生成结构化干预决策。每次干预时，你将收到一个诊断报告 (DiagnosisReport) 和当前状态。你需要从 5 种决策中选择最合适的：
1. fix_and_retry: 修改变量/配置，然后重试
2. guide_and_retry: 注入指导到 agent 对话，让它换方法
3. reconfigure_and_retry: 切换模型/修改配置后重试
4. agent_takeover: 你直接完成节点的目标任务
5. block_node: 阻断节点，分析后续节点依赖`
  }

  /**
   * Build a user message for an intervention.
   */
  private buildInterventionMessage(report: DiagnosisReport, state: InterventionState): string {
    const evidenceLines = report.evidence.map((e, i) => {
      const parts: string[] = []
      if (e.attempt !== undefined) parts.push(`attempt ${e.attempt}`)
      if (e.errorCode) parts.push(`code: ${e.errorCode}`)
      if (e.errorMessage) parts.push(`error: ${e.errorMessage}`)
      if (e.errorHash) parts.push(`hash: ${e.errorHash}`)
      return `- ${parts.join(", ") || JSON.stringify(e)}`
    })

    const varpoolLines = Object.entries(state.varpoolSnapshot)
      .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join("\n")

    const progressPercent = Math.round(
      (report.context.workflowProgress ?? 0) * 100,
    )

    return `## 新的诊断报告

- 检测器: ${report.detector}
- 严重度: ${report.severity}
- 节点: ${report.nodeId} (${report.nodeType})
- 模式: ${report.pattern}

### 证据
${evidenceLines.join("\n")}

### 执行上下文
- 重试次数: ${report.context.retryCount}
- 节点执行时间: ${report.context.nodeDurationMs}ms
- 工作流进度: ${progressPercent}%

### 当前变量池
${varpoolLines || "(empty)"}

请分析这个异常并生成结构化决策。`
  }

  /**
   * Find the last report for a given node.
   * Used when recording decisions.
   */
  private findLastReportForNode(nodeId: string): DiagnosisReport {
    // Search backwards through messages to find the last user message for this node
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]
      if (msg.role === "user" && msg.content.includes(`节点: ${nodeId}`)) {
        // This is a simplified approach - in practice we'd store the report object
        // For now, return a placeholder
        return {
          id: "placeholder",
          timestamp: Date.now(),
          detector: "unknown",
          severity: "info",
          executionId: this.executionId,
          nodeId,
          nodeType: "unknown",
          pattern: "unknown",
          evidence: [],
          context: { retryCount: 0, nodeDurationMs: 0, workflowProgress: 0 },
        }
      }
    }

    // Fallback
    return {
      id: "fallback",
      timestamp: Date.now(),
      detector: "unknown",
      severity: "info",
      executionId: this.executionId,
      nodeId,
      nodeType: "unknown",
      pattern: "unknown",
      evidence: [],
      context: { retryCount: 0, nodeDurationMs: 0, workflowProgress: 0 },
    }
  }

  /**
   * Compute the overall harness status from the interventions.
   * Priority: blocked > delegated > intervened
   */
  private computeHarnessStatus(): "intervened" | "blocked" | "delegated" {
    const hasBlock = this.interventions.some((i) => i.decision === "block_node")
    if (hasBlock) return "blocked"

    const hasTakeover = this.interventions.some((i) => i.decision === "agent_takeover")
    if (hasTakeover) return "delegated"

    return "intervened"
  }
}
