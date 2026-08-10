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
import type { HarnessAgentSession } from "./harness-agent-session"
import yaml from "js-yaml"

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
  /** Captured message chunks (thinking, tool_call, tool_result) for detail display. */
  chunks?: Array<{ type: string; [key: string]: unknown }>
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
  const evidenceLines = report.evidence.map((e) => {
    const parts: string[] = []
    if (e.attempt !== undefined) parts.push(`attempt ${e.attempt}`)
    if (e.errorCode) parts.push(`code: ${e.errorCode}`)
    if (e.errorMessage) parts.push(`error: ${e.errorMessage}`)
    if (e.errorHash) parts.push(`hash: ${e.errorHash}`)
    if (e.errorPattern) parts.push(`pattern: ${e.errorPattern}`)
    if (e.determinism) parts.push(`determinism: ${e.determinism}`)
    if (e.scriptSnippet) parts.push(`script:\n${e.scriptSnippet}`)
    if (e.errorText) parts.push(`errorOutput:\n${e.errorText}`)
    return `- ${parts.join("\n  ") || JSON.stringify(e)}`
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

  // Include node config and workflow content if available
  const nodeConfigStr = context.nodeConfig
    ? JSON.stringify(context.nodeConfig, null, 2)
    : "(not available)"

  const workflowStr = context.workflowContent
    ? context.workflowContent.substring(0, 3000)
    : "(not available)"

  return `你是 Octopus 工作流 Harness Agent — 一个智能工作流守护者。

## 当前异常

- 检测器: ${report.detector}
- 严重度: ${report.severity}
- 节点: ${report.nodeId} (类型: ${report.nodeType})
- 模式: ${report.pattern}
- 重试次数: ${report.context.retryCount}
- 节点执行时间: ${report.context.nodeDurationMs}ms
- 工作流进度: ${progressPercent}%

## 错误证据
${evidenceLines.join("\n")}

## 当前变量池
${varpoolLines || "(empty)"}

## 节点配置
${nodeConfigStr}

## 工作流定义
${workflowStr}

## 最近执行事件
${eventsSummary}

---

## 你的任务

**第一步：分析根因。** 仔细阅读错误信息、脚本内容、变量池和工作流定义，搞清楚节点为什么会失败。

**第二步：选择最佳干预策略。** 根据根因分析，从以下 5 种决策中选择最合适的。每种决策都有多种工具可以组合使用，灵活运用：

### 1. fix_and_retry — 修复问题后重试
当你能确定根因并且知道怎么修复时选择这个。可用的修复工具（可组合）：
- **varPoolPatches**: 修补变量池。适用于变量缺失、变量值错误、条件表达式引用了错误的变量等场景。
- **scriptOverride**: 替换整个脚本内容。适用于 bash/python 脚本有语法错误、缺少依赖、命令拼写错误等脚本本身的问题。
- **harnessHint**: 注入提示。给执行节点一个方向性的建议。

### 2. guide_and_retry — 给 agent 节点注入指导后重试
仅适用于 agent 类型节点。通过 harnessHint 告诉 agent 换一种方法。

### 3. reconfigure_and_retry — 切换模型后重试
仅适用于 agent 类型节点。当模型能力不足时（如需要视觉能力），在 modelOverride 中指定新模型。

### 4. agent_takeover — 你直接完成节点任务
当你认为修复脚本不如直接执行任务更高效时选择这个。适用于：
- 脚本逻辑复杂，修复比重写更难
- 节点的目标任务你可以通过工具直接完成（bash命令、文件操作等）
- 确定性错误且修复需要大量改动
在 takeoverOutput 中提供执行结果。bash/python 节点也可以 takeover。

### 5. block_node — 阻断节点
当问题无法修复或修复风险太高时选择。在 blockReason 中说明原因。
设置 continueSubsequent: true 可以让下游节点继续执行（即使本节点被阻断）。

---

## 决策原则

- **先理解，再行动。** 不要看到 "syntax error" 就机械地修语法。想想：这个脚本想做什么？有没有更聪明的方式达成目标？
- **最小干预。** 能改一个变量就不改整个脚本。能修脚本就不 takeover。
- **但要务实。** 如果修复脚本需要理解大量上下文，而你直接执行任务更快，那就 takeover。
- **关注下游。** 如果这个节点修复后下游可以正常跑，优先修复。如果下游也会因为同样原因失败，考虑更根本的修复。
- **变量问题 vs 脚本问题。** 变量池里的值错误（路径、配置、条件变量）用 varPoolPatches。脚本本身的错误（语法、缺失import、命令拼写）用 scriptOverride。不确定时，两个都提供。

## 输出要求

你必须只输出一个 JSON 代码块。不要输出任何其他文字。

\`\`\`json
{
  "decision": "fix_and_retry",
  "reasoning": "详细的根因分析和修复思路",
  "varPoolPatches": {},
  "scriptOverride": "",
  "harnessHint": "",
  "modelOverride": "",
  "takeoverOutput": "",
  "blockReason": "",
  "continueSubsequent": true
}
\`\`\`

不使用的字段留空字符串 ""。不要使用 YAML。不要在 JSON 前后添加任何文字。`
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

  // Try to extract structured data from the response
  let jsonStr: string | null = null
  let parsed: any = null

  // 1. Try ```json code block first (explicit JSON marker)
  const jsonBlockMatch = rawText.match(/```json\s*\n?([\s\S]*?)\n?```/)
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim()
  }

  // 2. Try ```yaml / ```yml code blocks
  if (!jsonStr) {
    const yamlBlockMatch = rawText.match(/```(?:ya?ml)\s*\n?([\s\S]*?)\n?```/)
    if (yamlBlockMatch) {
      try {
        const yamlParsed = yaml.load(yamlBlockMatch[1].trim())
        if (yamlParsed && typeof yamlParsed === "object") {
          parsed = yamlParsed as Record<string, unknown>
        }
      } catch {
        // YAML parse failed, continue
      }
    }
  }

  // 3. Markdown fallback — extract decision from prose/markdown responses
  //    Do this BEFORE loose JSON object matching, because markdown often contains
  //    stray `{` characters (in tables, diagrams) that fool the JSON regex.
  if (!jsonStr && !parsed) {
    const decisionMatch = rawText.match(/(?:decision|决策)[：:\s]*`?([\w_]+)`?/i)
    if (decisionMatch) {
      const decisionCandidate = decisionMatch[1].toLowerCase().replace(/-/g, "_")
      if (isValidDecisionType(decisionCandidate as HarnessDecisionType)) {
        const reasoningMatch = rawText.match(/(?:理由|reasoning|reason|分析)[：:\s]*\*?\*?([\s\S]*?)(?=\n###|\n##|\n---|\n\||\n\d+\.|$)/i)
        const blockReasonMatch = rawText.match(/(?:阻断原因|block[_\s]?reason)[：:\s]*\*?\*?([^\n|]+)/i)
        parsed = {
          decision: decisionCandidate,
          reasoning: reasoningMatch?.[1]?.trim() ?? "",
          blockReason: blockReasonMatch?.[1]?.trim() ?? undefined,
        } as Record<string, unknown>
      }
    }
  }

  // 4. Try untagged code block that looks like JSON (starts with { or [)
  if (!jsonStr && !parsed) {
    const untaggedMatch = rawText.match(/```(?![a-zA-Z])\s*\n?([\s\S]*?)\n?```/)
    if (untaggedMatch && /^[\s]*[{[]/.test(untaggedMatch[1])) {
      jsonStr = untaggedMatch[1].trim()
    }
  }

  // 5. Try to find JSON object in the text (must start with {)
  if (!jsonStr && !parsed) {
    const jsonObjMatch = rawText.match(/\{[\s\S]*\}/)
    if (jsonObjMatch) {
      jsonStr = jsonObjMatch[0]
    }
  }

  if (!jsonStr && !parsed) {
    return failureResult(
      "Failed to parse agent response: no JSON, YAML, or recognizable decision found",
    )
  }

  // Parse the JSON (skip if already parsed via YAML fallback)
  if (!parsed && jsonStr) {
    try {
      parsed = JSON.parse(jsonStr)
    } catch (err) {
      // JSON parse failed — try YAML as last resort on the same string
      try {
        const yamlFallback = yaml.load(jsonStr)
        if (yamlFallback && typeof yamlFallback === "object") {
          parsed = yamlFallback as Record<string, unknown>
        }
      } catch {
        // YAML also failed
      }

      if (!parsed) {
        return failureResult(
          `Failed to parse agent response: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
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
      varPoolPatches: parsed.varPoolPatches ?? parsed.var_pool_patches ?? undefined,
      scriptOverride: parsed.scriptOverride ?? parsed.script_override ?? undefined,
      harnessHint: parsed.harnessHint ?? parsed.harness_hint ?? parsed.hint ?? undefined,
      modelOverride: parsed.modelOverride ?? parsed.model_override ?? parsed.model ?? undefined,
      takeoverOutput: parsed.takeoverOutput ?? parsed.takeover_output ?? undefined,
      takeoverExitCode: parsed.takeoverExitCode ?? parsed.takeover_exit_code ?? undefined,
      blockReason: parsed.blockReason ?? parsed.block_reason ?? parsed.reason ?? undefined,
      continueSubsequent: parsed.continueSubsequent ?? parsed.continue_subsequent ?? undefined,
      reasoning: parsed.reasoning ?? parsed.reason ?? parsed.analysis ?? "",
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
  /** Harness agent session for context accumulation across interventions (ticket 10). */
  session?: HarnessAgentSession
  /** Provider getter function — injected to avoid tsup bundling issues with dynamic import. */
  getProvider?: (id: string) => { sendQuery: (...args: any[]) => any }
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
  private session?: HarnessAgentSession
  private getProvider?: (id: string) => { sendQuery: (...args: any[]) => any }

  constructor(deps: AgentDelegationServiceDeps) {
    this.dao = deps.dao
    this.sse = deps.sse
    this.workspaceId = deps.workspaceId
    this.agentSessionRunner = deps.agentSessionRunner
    this.llmCall = deps.llmCall
    this.timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000 // 5 minutes default
    this.session = deps.session
    this.getProvider = deps.getProvider
  }

  /**
   * Delegate a DiagnosisReport to the harness-agent for analysis and decision.
   *
   * Flow:
   * 1. Append DiagnosisReport to session (if available) for context accumulation (AC3)
   * 2. Emit SSE harness_delegation start event
   * 3. Build delegation prompt from report + context (+ conversation history if session exists)
   * 4. Run agent session (or LLM call) with timeout protection
   * 5. Parse the response into a DelegationResult (5 decision types)
   * 6. Record decision to session and append assistant response (AC4)
   * 7. Record token usage with source="harness"
   * 8. Persist delegation event to harness_events
   * 9. Emit SSE harness_delegation complete/fail event
   * 10. Return the result
   */
  async delegate(params: {
    executionId: string
    nodeId: string
    report: DiagnosisReport
    context: DelegationContext
  }): Promise<DelegationResult> {
    const { executionId, nodeId, report, context } = params
    // Use displayNodeId for SSE/UI (targets the actual failing inner node)
    const displayNodeId = report.displayNodeId ?? nodeId
    const delegationId = `harness-${executionId}-${nodeId}-${Date.now()}`

    // Append DiagnosisReport to session for context accumulation (AC3)
    if (this.session && !this.session.isClosed) {
      this.session.appendIntervention(report, {
        varpoolSnapshot: context.varpoolSnapshot,
      })
    }

    // Emit SSE start event
    this.emitDelegationSSE(executionId, displayNodeId, delegationId, "start")

    // Build the prompt (includes conversation history if session exists)
    const prompt = this.buildPromptWithHistory(report, context)

    // Execute the agent session / LLM call with timeout
    let responseText: string
    let tokenInfo: { input: number; output: number; model: string } | undefined
    let agentSessionId: string | undefined
    let agentChunks: Array<{ type: string; [key: string]: unknown }> | undefined

    try {
      const result = await this.callWithTimeout(prompt, executionId, nodeId)
      responseText = result.text
      tokenInfo = result.tokenUsage
      agentSessionId = result.sessionId
      agentChunks = result.chunks
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
      this.emitDelegationSSE(executionId, displayNodeId, delegationId, "fail")

      return failResult
    }

    // Parse the response
    const parsed = parseDelegationResponse(responseText)

    // Attach token usage info from the agent session / LLM call
    if (tokenInfo) {
      parsed.tokenUsage = tokenInfo
    }
    if (agentChunks && agentChunks.length > 0) {
      parsed.chunks = agentChunks
    }

    // Record decision to session and append assistant response (AC4)
    if (this.session && !this.session.isClosed) {
      this.session.recordDecision(nodeId, parsed)
      this.session.appendAssistantResponse(responseText)
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

    // Emit SSE complete/fail event with result
    // Include both displayNodeId (inner node) and nodeId (loop container)
    // so the frontend can update harness status on both nodes.
    this.emitDelegationSSE(
      executionId,
      displayNodeId,
      delegationId,
      parsed.success ? "complete" : "fail",
      parsed,
      displayNodeId !== nodeId ? nodeId : undefined,
      (report as any).iteration,
    )

    return parsed
  }

  /**
   * Build the delegation prompt, incorporating conversation history from the session.
   * If a session exists, uses the accumulated messages to provide context across interventions.
   * Otherwise, falls back to the standard buildDelegationPrompt.
   */
  private buildPromptWithHistory(
    report: DiagnosisReport,
    context: DelegationContext,
  ): string {
    // If no session, use the standard prompt builder
    if (!this.session) {
      return buildDelegationPrompt(report, context)
    }

    // Get the conversation history from the session
    const messages = this.session.getMessages()

    // Build the prompt by concatenating all messages
    // The session already has:
    // - system message (initial workflow context)
    // - user messages (previous interventions)
    // - assistant messages (previous decisions)
    // - current user message (this intervention, just appended)
    //
    // We format them as a conversation for the LLM
    const promptParts = messages.map((msg) => {
      if (msg.role === "system") {
        return msg.content
      } else if (msg.role === "user") {
        return `\n\n用户: ${msg.content}`
      } else {
        return `\n\n助手: ${msg.content}`
      }
    })

    return promptParts.join("")
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
          console.warn(
            "[AgentDelegationService] Could not create agent session:",
            err instanceof Error ? err.message : String(err),
          )
        }

        const getProviderFn = this.getProvider
        if (!getProviderFn) {
          throw new Error("No provider getter configured in AgentDelegationService")
        }
        const provider = getProviderFn("claude")

        let text = ""
        let tokenUsage:
          | { input: number; output: number; model: string }
          | undefined
        // Capture all meaningful chunks for detail display
        const chunks: Array<{ type: string; [key: string]: unknown }> = []

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
          } else if (
            chunk.type === "thinking" || chunk.type === "thinking_start" || chunk.type === "thinking_done" ||
            chunk.type === "tool_call_start" || chunk.type === "tool_call" || chunk.type === "tool_result"
          ) {
            chunks.push(chunk as { type: string; [key: string]: unknown })
          }
        }

        return { text, tokenUsage, sessionId, chunks }
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
    result?: DelegationResult,
    containerNodeId?: string,
    iteration?: number,
  ): void {
    try {
      this.sse.emit(this.workspaceId, {
        event: "harness_delegation",
        data: {
          executionId,
          nodeId,
          agentSessionId: delegationId,
          status,
          ...(result ? { result } : {}),
          ...(containerNodeId ? { containerNodeId } : {}),
          ...(iteration != null ? { iteration } : {}),
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
