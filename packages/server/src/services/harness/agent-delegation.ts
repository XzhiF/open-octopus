// packages/server/src/services/harness/agent-delegation.ts
//
// AgentDelegationService — Layer 3 of the Harness.
// When the StrategyEngine cannot handle a DiagnosisReport (no strategy match
// or delegate_to_agent: true), this service delegates to the core-pack
// harness-agent for deep analysis and structured decision-making.
//
// The delegation flow:
// 1. Create an agent session (clone harness-agent) for visibility in agent mgmt
// 2. Build delegation prompt from DiagnosisReport + DelegationContext
// 3. Run the agent session with timeout protection (5 min default)
// 4. Parse structured decision (HarnessDecisionType) from agent output
// 5. Record token usage with source="harness"
// 6. Persist delegation event + emit SSE

import type {
  DiagnosisReport,
  HarnessEvent,
  HarnessDecisionType,
  DelegationResult,
} from "@octopus/shared"
import type { HarnessDAO } from "../../db/dao/harness-dao"
import type { SSEService } from "../sse"

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Context accompanying a delegation request.
 * Provides the agent with enough information to diagnose and fix the issue.
 */
export interface DelegationContext {
  /** Last 20 agent/engine events for context. */
  recentEvents: any[]
  /** Snapshot of the current variable pool. */
  varpoolSnapshot: Record<string, any>
  /** The failing node's configuration. */
  nodeConfig: any
  /** Full workflow YAML content. */
  workflowContent: string
}

/**
 * Result of running an agent session.
 * Returned by the AgentSessionRunner abstraction.
 */
export interface AgentSessionRunResult {
  /** The text output from the agent. */
  text: string
  /** Token usage statistics from the agent run. */
  tokenUsage?: { input: number; output: number; model: string }
  /** The agent session ID that was created. */
  sessionId?: string
}

/**
 * Abstraction for creating and running an agent session.
 * The default implementation creates a session via AgentService (clone harness-agent)
 * and runs the LLM call through the provider.
 *
 * This allows testing with mocks and alternative execution strategies.
 */
export type AgentSessionRunner = (params: {
  cloneName: string
  prompt: string
  executionId: string
  nodeId: string
}) => Promise<AgentSessionRunResult>

/**
 * Function signature for the LLM call used by the delegation service.
 * Accepts a prompt string and returns the response text plus optional token info.
 * @deprecated Use AgentSessionRunner instead. Kept for backward compat.
 */
export type DelegationLLMCall = (prompt: string) => Promise<{
  text: string
  tokenUsage?: { input: number; output: number; model: string }
}>

// Re-export DelegationResult from shared for convenience
export type { DelegationResult } from "@octopus/shared"

// ─── Valid decision types ───────────────────────────────────────────────────

const VALID_DECISION_TYPES: ReadonlySet<HarnessDecisionType> = new Set([
  "fix_and_retry",
  "guide_and_retry",
  "reconfigure_and_retry",
  "agent_takeover",
  "block_node",
])

/**
 * Check if a string is a valid HarnessDecisionType.
 * Exported for testing.
 */
export function isValidDecisionType(value: string): value is HarnessDecisionType {
  return VALID_DECISION_TYPES.has(value as HarnessDecisionType)
}

// ─── Backward Compatibility Mapping ─────────────────────────────────────────

/**
 * Map old interventionType values to new HarnessDecisionType.
 * Used when parsing responses from agents that still use the old format.
 *
 * Mapping:
 * - "inject"     → "guide_and_retry"
 * - "varpool"    → "fix_and_retry"
 * - "definition" → "fix_and_retry" (via varPool indirect effect)
 * - "takeover"   → "agent_takeover"
 */
export function mapInterventionTypeToDecision(
  interventionType: string,
): HarnessDecisionType | null {
  switch (interventionType) {
    case "inject":
      return "guide_and_retry"
    case "varpool":
      return "fix_and_retry"
    case "definition":
      return "fix_and_retry"
    case "takeover":
      return "agent_takeover"
    default:
      return null
  }
}

/**
 * Map new HarnessDecisionType back to old interventionType for backward compat.
 * Used when consumers still expect the old format.
 */
export function mapDecisionToInterventionType(
  decision: HarnessDecisionType,
): string {
  switch (decision) {
    case "fix_and_retry":
      return "varpool"
    case "guide_and_retry":
      return "inject"
    case "reconfigure_and_retry":
      return "definition"
    case "agent_takeover":
      return "takeover"
    case "block_node":
      return "inject" // closest old equivalent
  }
}

// ─── Prompt Construction ────────────────────────────────────────────────────

/**
 * Build the delegation prompt from a DiagnosisReport and context.
 * Uses the 5 structured decision types from the harness-agent definition.
 * Exported for testing.
 */
export function buildDelegationPrompt(
  report: DiagnosisReport,
  context: DelegationContext,
): string {
  const evidenceLines = report.evidence.map((e, i) => {
    const parts: string[] = []
    if (e.attempt !== undefined) parts.push(`attempt ${e.attempt}`)
    if (e.errorCode) parts.push(`code: ${e.errorCode}`)
    if (e.errorMessage) parts.push(`error: ${e.errorMessage}`)
    if (e.errorHash) parts.push(`hash: ${e.errorHash}`)
    return `- ${parts.join(", ") || JSON.stringify(e)}`
  })

  // Limit recent events to last 20
  const recentEvents = context.recentEvents.slice(-20)
  const eventsSummary =
    recentEvents.length > 0
      ? recentEvents.map((e) => `- ${JSON.stringify(e)}`).join("\n")
      : "(no recent events)"

  const varpoolLines = Object.entries(context.varpoolSnapshot)
    .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n")

  const progressPercent = Math.round(
    (report.context.workflowProgress ?? 0) * 100,
  )

  return `你是 Octopus 工作流安全守护 Agent。你的任务是分析工作流异常并生成结构化干预决策。

## 诊断报告
- 检测器: ${report.detector}
- 严重度: ${report.severity}
- 节点: ${report.nodeId} (${report.nodeType})
- 模式: ${report.pattern}

## 证据
${evidenceLines.join("\n")}

## 执行上下文
- 重试次数: ${report.context.retryCount}
- 节点执行时间: ${report.context.nodeDurationMs}ms
- 工作流进度: ${progressPercent}%

## 最近的 Agent 事件
${eventsSummary}

## 当前变量池
${varpoolLines || "(empty)"}

## 你需要做什么
分析根因，然后从以下 5 种决策中选择最合适的：

1. fix_and_retry: 修改变量/配置，然后重试（不能直接修改脚本，只能通过 varPool/hint 间接影响）
2. guide_and_retry: 注入指导到 agent 对话，让它换方法
3. reconfigure_and_retry: 切换模型/修改配置后重试
4. agent_takeover: 你直接完成节点的目标任务（用你的工具执行）
5. block_node: 阻断节点，分析后续节点依赖

输出 JSON:
{
  "decision": "fix_and_retry|guide_and_retry|reconfigure_and_retry|agent_takeover|block_node",
  "reasoning": "分析推理过程",
  "varPoolPatches": {},       // fix_and_retry 时使用
  "harnessHint": "",          // guide_and_retry 时使用
  "modelOverride": "",        // reconfigure_and_retry 时使用
  "takeoverOutput": "",       // agent_takeover 时使用
  "blockReason": "",          // block_node 时使用
  "continueSubsequent": true  // block_node 时：后续节点是否可继续
}`
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Parse the agent's text response into a DelegationResult.
 * Handles JSON embedded in markdown code blocks or surrounding text.
 *
 * Supports both new format (decision field) and old format (interventionType)
 * for backward compatibility.
 *
 * Exported for testing.
 */
export function parseDelegationResponse(rawText: string): DelegationResult {
  const failureResult = (reason: string): DelegationResult => ({
    success: false,
    decision: "block_node", // safe default for failures
    reasoning: reason,
    tokenUsage: { input: 0, output: 0, model: "unknown" },
  })

  // Try to extract JSON from the response
  let jsonStr: string | null = null

  // 1. Try markdown code block first
  const codeBlockMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim()
  }

  // 2. Try to find JSON object in the text
  if (!jsonStr) {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      jsonStr = jsonMatch[0]
    }
  }

  if (!jsonStr) {
    return failureResult(
      "Failed to parse agent response: no JSON found in response",
    )
  }

  // Parse the JSON
  let parsed: any
  try {
    parsed = JSON.parse(jsonStr)
  } catch (err) {
    return failureResult(
      `Failed to parse agent response: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // ── New format: decision field ──────────────────────────────────
  if (parsed.decision) {
    if (!isValidDecisionType(parsed.decision)) {
      return failureResult(
        `Failed to parse agent response: invalid decision '${parsed.decision}' — must be one of: ${[...VALID_DECISION_TYPES].join(", ")}`,
      )
    }

    return {
      success: true,
      decision: parsed.decision,
      varPoolPatches: parsed.varPoolPatches ?? undefined,
      harnessHint: parsed.harnessHint ?? undefined,
      modelOverride: parsed.modelOverride ?? undefined,
      takeoverOutput: parsed.takeoverOutput ?? undefined,
      takeoverExitCode: parsed.takeoverExitCode ?? undefined,
      blockReason: parsed.blockReason ?? undefined,
      continueSubsequent: parsed.continueSubsequent ?? undefined,
      reasoning: parsed.reasoning ?? "",
      tokenUsage: { input: 0, output: 0, model: "unknown" },
    }
  }

  // ── Old format: interventionType field (backward compat) ────────
  if (parsed.interventionType) {
    const mappedDecision = mapInterventionTypeToDecision(parsed.interventionType)
    if (!mappedDecision) {
      return failureResult(
        `Failed to parse agent response: invalid interventionType '${parsed.interventionType}' — cannot map to a valid decision type`,
      )
    }

    // Build the result from old-format fields
    const result: DelegationResult = {
      success: true,
      decision: mappedDecision,
      reasoning: parsed.reasoning ?? "",
      tokenUsage: { input: 0, output: 0, model: "unknown" },
    }

    // Map old data fields to new fields based on decision type
    if (parsed.data) {
      switch (mappedDecision) {
        case "guide_and_retry":
          result.harnessHint = parsed.data.message ?? parsed.data.hint ?? undefined
          break
        case "fix_and_retry":
          if (parsed.data.key && parsed.data.value !== undefined) {
            result.varPoolPatches = { [parsed.data.key]: String(parsed.data.value) }
          } else if (typeof parsed.data === "object") {
            result.varPoolPatches = parsed.data
          }
          break
        case "reconfigure_and_retry":
          result.modelOverride = parsed.data.model ?? parsed.data.field ?? undefined
          break
        case "agent_takeover":
          result.takeoverOutput = parsed.data.script ?? parsed.data.output ?? undefined
          break
      }
    }

    return result
  }

  // Neither decision nor interventionType found
  return failureResult(
    "Failed to parse agent response: missing 'decision' field (or legacy 'interventionType')",
  )
}

// ─── Service ────────────────────────────────────────────────────────────────

export interface AgentDelegationServiceDeps {
  dao: HarnessDAO
  sse: SSEService
  workspaceId: string
  /** Agent session runner. If provided, takes precedence over llmCall. */
  agentSessionRunner?: AgentSessionRunner
  /** @deprecated LLM call function. Use agentSessionRunner instead. */
  llmCall?: DelegationLLMCall
  /** Timeout in milliseconds. Default: 300000 (5 minutes). */
  timeoutMs?: number
}

/**
 * AgentDelegationService — stateless service that delegates DiagnosisReports
 * to the harness-agent for deep analysis and structured decision generation.
 *
 * The service creates an agent session (clone of harness-agent) for each
 * delegation, making the harness agent visible in the agent management UI.
 */
export class AgentDelegationService {
  private dao: HarnessDAO
  private sse: SSEService
  private workspaceId: string
  private agentSessionRunner?: AgentSessionRunner
  private llmCall?: DelegationLLMCall
  private timeoutMs: number

  constructor(deps: AgentDelegationServiceDeps) {
    this.dao = deps.dao
    this.sse = deps.sse
    this.workspaceId = deps.workspaceId
    this.agentSessionRunner = deps.agentSessionRunner
    this.llmCall = deps.llmCall
    this.timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000 // 5 minutes default
  }

  /**
   * Delegate a DiagnosisReport to the harness-agent for analysis and decision.
   *
   * Flow:
   * 1. Emit SSE harness_delegation start event
   * 2. Build delegation prompt from report + context
   * 3. Run agent session (or LLM call) with timeout protection
   * 4. Parse the response into a DelegationResult (5 decision types)
   * 5. Record token usage with source="harness"
   * 6. Persist delegation event to harness_events
   * 7. Emit SSE harness_delegation complete/fail event
   * 8. Return the result
   */
  async delegate(params: {
    executionId: string
    nodeId: string
    report: DiagnosisReport
    context: DelegationContext
  }): Promise<DelegationResult> {
    const { executionId, nodeId, report, context } = params
    const delegationId = `harness-${executionId}-${nodeId}-${Date.now()}`

    // Emit SSE start event
    this.emitDelegationSSE(executionId, nodeId, delegationId, "start")

    // Build the prompt
    const prompt = buildDelegationPrompt(report, context)

    // Execute the agent session / LLM call with timeout
    let responseText: string
    let tokenInfo: { input: number; output: number; model: string } | undefined
    let agentSessionId: string | undefined

    try {
      const result = await this.callWithTimeout(prompt, executionId, nodeId)
      responseText = result.text
      tokenInfo = result.tokenUsage
      agentSessionId = result.sessionId
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err)
      const failResult: DelegationResult = {
        success: false,
        decision: "block_node",
        reasoning: reason,
        tokenUsage: { input: 0, output: 0, model: "unknown" },
      }

      // Persist failure event
      this.persistDelegationEvent({
        id: delegationId,
        executionId,
        nodeId,
        report,
        result: failResult,
      })

      // Emit SSE fail event
      this.emitDelegationSSE(executionId, nodeId, delegationId, "fail")

      return failResult
    }

    // Parse the response
    const parsed = parseDelegationResponse(responseText)

    // Attach token usage info from the agent session / LLM call
    if (tokenInfo) {
      parsed.tokenUsage = tokenInfo
    }

    // Record token usage with source="harness"
    if (tokenInfo && tokenInfo.input + tokenInfo.output > 0) {
      this.recordTokenUsage(delegationId, executionId, nodeId, tokenInfo)
    }

    // Persist delegation event
    this.persistDelegationEvent({
      id: delegationId,
      executionId,
      nodeId,
      report,
      result: parsed,
    })

    // Emit SSE complete/fail event
    this.emitDelegationSSE(
      executionId,
      nodeId,
      delegationId,
      parsed.success ? "complete" : "fail",
    )

    return parsed
  }

  /**
   * Call the agent session runner (or LLM fallback) with a timeout wrapper.
   */
  private async callWithTimeout(
    prompt: string,
    executionId: string,
    nodeId: string,
  ): Promise<AgentSessionRunResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Agent delegation timeout after ${this.timeoutMs}ms — aborting`,
          ),
        )
      }, this.timeoutMs)

      this.executeCall(prompt, executionId, nodeId)
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((err) => {
          clearTimeout(timer)
          reject(err)
        })
    })
  }

  /**
   * Execute the actual agent session run or LLM call.
   * Prefers agentSessionRunner over llmCall over default provider.
   */
  private async executeCall(
    prompt: string,
    executionId: string,
    nodeId: string,
  ): Promise<AgentSessionRunResult> {
    // Priority 1: AgentSessionRunner (new pattern)
    if (this.agentSessionRunner) {
      return this.agentSessionRunner({
        cloneName: "harness-agent",
        prompt,
        executionId,
        nodeId,
      })
    }

    // Priority 2: Legacy LLM call (backward compat)
    if (this.llmCall) {
      const result = await this.llmCall(prompt)
      return { text: result.text, tokenUsage: result.tokenUsage }
    }

    // Priority 3: Default provider (fallback)
    return this.getDefaultAgentRunner()(prompt, executionId, nodeId)
  }

  /**
   * Get the default agent runner using the claude provider.
   * Creates an agent session for visibility, then runs the LLM call.
   */
  private getDefaultAgentRunner(): (
    prompt: string,
    executionId: string,
    nodeId: string,
  ) => Promise<AgentSessionRunResult> {
    return async (prompt: string, executionId: string, nodeId: string) => {
      try {
        // Create an agent session for visibility in agent management
        let sessionId: string | undefined
        try {
          const { getAgentService } = await import("../agent/agent-service")
          const agentService = getAgentService()
          const session = await agentService.createSession(this.workspaceId, {
            clone_name: "harness-agent",
          })
          sessionId = session.id
        } catch (err) {
          // Agent service may not be initialized — continue without session
          console.warn(
            "[AgentDelegationService] Could not create agent session:",
            err instanceof Error ? err.message : String(err),
          )
        }

        // Dynamic import to avoid hard dependency on providers package
        const { getProvider } = await import("@octopus/providers")
        const provider = getProvider("claude")

        let text = ""
        let tokenUsage:
          | { input: number; output: number; model: string }
          | undefined

        const stream = provider.sendQuery(prompt, process.cwd(), undefined, {
          model: "sonnet",
          systemPrompt:
            "You are the Octopus workflow security guardian (harness-agent). Analyse workflow anomalies and output structured JSON decisions.",
        })

        for await (const chunk of stream) {
          if (chunk.type === "text_delta") {
            text += chunk.content
          } else if (chunk.type === "result") {
            if (chunk.content) text = chunk.content
            if (chunk.tokens) {
              tokenUsage = {
                input: chunk.tokens.input,
                output: chunk.tokens.output,
                model: "claude-sonnet-4-20250514",
              }
            }
          }
        }

        return { text, tokenUsage, sessionId }
      } catch (err) {
        throw new Error(
          `Agent session call failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  /**
   * Record token usage for this delegation in the node_token_usages table.
   */
  private recordTokenUsage(
    delegationId: string,
    executionId: string,
    nodeId: string,
    tokenInfo: { input: number; output: number; model: string },
  ): void {
    try {
      const nodeExecId = `${executionId}-${nodeId}`
      const tokenId = `${delegationId}-token`

      this.dao.insertHarnessTokenUsage({
        id: tokenId,
        nodeExecutionId: nodeExecId,
        model: tokenInfo.model,
        inputTokens: tokenInfo.input,
        outputTokens: tokenInfo.output,
        costUsd: null, // Cost calculation deferred to billing layer
        createdAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error(
        "[AgentDelegationService] Failed to record token usage:",
        err,
      )
    }
  }

  /**
   * Persist a delegation event to the harness_events table.
   */
  private persistDelegationEvent(params: {
    id: string
    executionId: string
    nodeId: string
    report: DiagnosisReport
    result: DelegationResult
  }): void {
    const { id, executionId, nodeId, report, result } = params

    const row: HarnessEvent = {
      id,
      execution_id: executionId,
      node_id: nodeId,
      timestamp: Date.now(),
      event_type: "delegation",
      detector: report.detector,
      severity: report.severity,
      report_json: JSON.stringify(report),
      action_json: null,
      result_json: JSON.stringify(result),
      token_usage_json: JSON.stringify(result.tokenUsage),
      created_at: Math.floor(Date.now() / 1000),
    }

    try {
      this.dao.insertEvent(row)
    } catch (err) {
      console.error(
        "[AgentDelegationService] Failed to persist delegation event:",
        err,
      )
    }
  }

  /**
   * Emit an SSE harness_delegation event.
   */
  private emitDelegationSSE(
    executionId: string,
    nodeId: string,
    delegationId: string,
    status: string,
  ): void {
    try {
      this.sse.emit(this.workspaceId, {
        event: "harness_delegation",
        data: {
          executionId,
          nodeId,
          agentSessionId: delegationId,
          status,
        },
      })
    } catch (err) {
      console.error(
        "[AgentDelegationService] Failed to emit SSE event:",
        err,
      )
    }
  }
}
