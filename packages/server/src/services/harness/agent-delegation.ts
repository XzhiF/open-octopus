// packages/server/src/services/harness/agent-delegation.ts
//
// AgentDelegationService — Layer 3 of the Harness.
// When the StrategyEngine cannot handle a DiagnosisReport (no strategy match
// or delegate_to_agent: true), this service delegates to an Octopus built-in
// Agent session for deep analysis and correction.
//
// The delegation is a one-shot call: create session, send prompt, parse
// response, record tokens, destroy session. No multi-turn conversation.
// 5-minute timeout protects against runaway agent calls.

import type { DiagnosisReport, HarnessEvent } from "@octopus/shared"
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
 * Result of an agent delegation call.
 */
export interface DelegationResult {
  /** Whether the delegation succeeded in producing a valid intervention. */
  success: boolean
  /** The type of intervention the agent recommends. */
  interventionType: "inject" | "varpool" | "definition" | "takeover" | null
  /** Action-specific data for the intervention. */
  interventionData: any
  /** Token usage statistics for the delegation call. */
  tokenUsage: { input: number; output: number; model: string }
  /** The agent's analysis / reasoning. */
  reasoning: string
}

/**
 * Function signature for the LLM call used by the delegation service.
 * Accepts a prompt string and returns the response text plus optional token info.
 */
export type DelegationLLMCall = (prompt: string) => Promise<{
  text: string
  tokenUsage?: { input: number; output: number; model: string }
}>

// ─── Valid intervention types ───────────────────────────────────────────────

const VALID_INTERVENTION_TYPES = new Set([
  "inject",
  "varpool",
  "definition",
  "takeover",
])

// ─── Prompt Construction ────────────────────────────────────────────────────

/**
 * Build the delegation prompt from a DiagnosisReport and context.
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

  return `你是 Octopus WorkflowEngine 的 Harness Agent 分身。你的任务是分析工作流异常并生成干预方案。

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
分析根因，然后从以下干预方式中选择最合适的：
1. inject: 注入指令给节点 (适用于 agent 节点)
2. varpool: 修改变量值 (适用于变量值错误)
3. definition: 修改工作流定义 (适用于配置错误)
4. takeover: 直接接管执行 (适用于复杂脚本问题)

输出 JSON:
{
  "interventionType": "inject|varpool|definition|takeover",
  "data": { ... action-specific data ... },
  "reasoning": "你的分析过程"
}`
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Parse the agent's text response into a DelegationResult.
 * Handles JSON embedded in markdown code blocks or surrounding text.
 * Exported for testing.
 */
export function parseDelegationResponse(rawText: string): DelegationResult {
  const failureResult = (reason: string): DelegationResult => ({
    success: false,
    interventionType: null,
    interventionData: null,
    tokenUsage: { input: 0, output: 0, model: "unknown" },
    reasoning: reason,
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

  // Validate required fields
  if (!parsed.interventionType) {
    return failureResult(
      "Failed to parse agent response: missing 'interventionType' field",
    )
  }

  if (!VALID_INTERVENTION_TYPES.has(parsed.interventionType)) {
    return failureResult(
      `Failed to parse agent response: invalid interventionType '${parsed.interventionType}' — must be one of: ${[...VALID_INTERVENTION_TYPES].join(", ")}`,
    )
  }

  return {
    success: true,
    interventionType: parsed.interventionType,
    interventionData: parsed.data ?? null,
    tokenUsage: { input: 0, output: 0, model: "unknown" },
    reasoning: parsed.reasoning ?? "",
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export interface AgentDelegationServiceDeps {
  dao: HarnessDAO
  sse: SSEService
  workspaceId: string
  /** LLM call function. If not provided, uses the claude provider. */
  llmCall?: DelegationLLMCall
  /** Timeout in milliseconds. Default: 300000 (5 minutes). */
  timeoutMs?: number
}

/**
 * AgentDelegationService — stateless service that delegates DiagnosisReports
 * to an LLM agent for deep analysis and intervention generation.
 */
export class AgentDelegationService {
  private dao: HarnessDAO
  private sse: SSEService
  private workspaceId: string
  private llmCall?: DelegationLLMCall
  private timeoutMs: number

  constructor(deps: AgentDelegationServiceDeps) {
    this.dao = deps.dao
    this.sse = deps.sse
    this.workspaceId = deps.workspaceId
    this.llmCall = deps.llmCall
    this.timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000 // 5 minutes default
  }

  /**
   * Delegate a DiagnosisReport to the agent for analysis and intervention.
   *
   * Flow:
   * 1. Emit SSE harness_delegation start event
   * 2. Build delegation prompt from report + context
   * 3. Call the LLM (with timeout protection)
   * 4. Parse the response into a DelegationResult
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

    // Execute the LLM call with timeout
    let responseText: string
    let tokenInfo: { input: number; output: number; model: string } | undefined

    try {
      const result = await this.callWithTimeout(prompt)
      responseText = result.text
      tokenInfo = result.tokenUsage
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err)
      const failResult: DelegationResult = {
        success: false,
        interventionType: null,
        interventionData: null,
        tokenUsage: { input: 0, output: 0, model: "unknown" },
        reasoning: reason,
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

    // Attach token usage info from the LLM call
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
   * Call the LLM with a timeout wrapper.
   */
  private async callWithTimeout(
    prompt: string,
  ): Promise<{ text: string; tokenUsage?: { input: number; output: number; model: string } }> {
    const llmCall = this.llmCall ?? this.getDefaultLLMCall()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Agent delegation timeout after ${this.timeoutMs}ms — aborting`,
          ),
        )
      }, this.timeoutMs)

      llmCall(prompt)
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
   * Get the default LLM call using the claude provider.
   * Falls back to a no-op if the provider is unavailable.
   */
  private getDefaultLLMCall(): DelegationLLMCall {
    return async (prompt: string) => {
      try {
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
            "You are a workflow debugging agent. Analyze errors and propose fixes in the requested JSON format.",
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

        return { text, tokenUsage }
      } catch (err) {
        throw new Error(
          `LLM provider call failed: ${err instanceof Error ? err.message : String(err)}`,
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
