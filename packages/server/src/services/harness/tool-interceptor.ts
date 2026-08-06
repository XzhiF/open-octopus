// packages/server/src/services/harness/tool-interceptor.ts
//
// ToolInterceptor — intercepts shell tool calls (Bash, PowerShell) in agent nodes,
// scans commands for dangerous patterns (kill/pkill/port binding),
// blocks execution and generates DiagnosisReport on match.
//
// This implements the "Tool Interceptor" domain (路径 4) from the spec:
//   tool_call → scan command → block → pause session → guidance → resume

import type { DiagnosisReport } from "@octopus/shared"
import { DangerousPatternMatcher } from "./dangerous-pattern-matcher"
import type { DangerousPatternMatch } from "./dangerous-pattern-matcher"

/** Tool names that execute shell commands and should be intercepted. */
const SHELL_TOOLS = new Set(["Bash", "PowerShell"])

export interface ToolInterceptorContext {
  executionId: string
  nodeId: string
  nodeType: string
}

export interface ToolBlockResult {
  blocked: true
  reason: string
  report: DiagnosisReport
  /** Guidance message to inject into the agent conversation. */
  guidance: string
}

/**
 * ToolInterceptor checks shell tool calls for dangerous patterns.
 *
 * AC1: Registered as an onBeforeToolCall hook in the agent executor.
 * AC2: Receives tool name + input (command string). Intercepts Bash and PowerShell.
 * AC3: Reuses DangerousPatternMatcher (extracted from ProcessConflictDetector).
 * AC4: Match → block tool execution + generate DiagnosisReport.
 * AC5: Block result includes guidance for injection into agent session.
 * AC6: Safe commands pass through (returns null).
 */
export class ToolInterceptor {
  /** Reports generated for blocked tool calls (collected during execution). */
  readonly blockedReports: DiagnosisReport[] = []

  constructor(
    private matcher: DangerousPatternMatcher,
    private context: ToolInterceptorContext,
  ) {}

  /**
   * Check a tool call for dangerous patterns.
   * Returns a block result if dangerous, null if safe.
   */
  checkToolCall(toolName: string, toolInput: unknown): ToolBlockResult | null {
    // AC2: intercept shell command tools (Bash, PowerShell)
    if (!SHELL_TOOLS.has(toolName)) return null

    // Extract command string from tool input
    const command = this.extractCommand(toolInput)
    if (!command) return null

    // AC3: Reuse pattern matching from ProcessConflictDetector
    const match = this.matcher.match(command)
    if (!match) return null

    // AC4: Block + generate DiagnosisReport
    const report = this.buildReport(match, command, toolName)

    // AC5: Generate guidance for injection
    const guidance = this.buildGuidance(match)

    return {
      blocked: true,
      reason: match.description,
      report,
      guidance,
    }
  }

  /**
   * Create an `onBeforeToolCall` callback compatible with SendQueryOptions.
   * This is the primary integration point — pass the returned callback to
   * AgentConfig.onBeforeToolCall or SendQueryOptions.onBeforeToolCall.
   *
   * The callback:
   * 1. Checks the tool call for dangerous patterns
   * 2. If blocked: records the DiagnosisReport and returns { allow: false, reason }
   * 3. If safe: returns { allow: true }
   */
  createHook(): (toolName: string, input: unknown) => Promise<{ allow: boolean; reason?: string } | undefined> {
    return async (toolName: string, input: unknown) => {
      const result = this.checkToolCall(toolName, input)
      if (result) {
        // AC4: Record the report for later retrieval by the harness pipeline
        this.blockedReports.push(result.report)
        // AC5: The reason is injected as the tool result the model sees
        return { allow: false, reason: result.guidance }
      }
      return { allow: true }
    }
  }

  /**
   * Extract the command string from a shell tool input.
   * Both Bash and PowerShell tools use { command: string } format.
   */
  private extractCommand(toolInput: unknown): string | null {
    if (!toolInput || typeof toolInput !== "object") return null
    const input = toolInput as Record<string, unknown>
    if (typeof input.command !== "string") return null
    if (!input.command.trim()) return null
    return input.command
  }

  /**
   * Build a DiagnosisReport for a blocked tool call.
   */
  private buildReport(match: DangerousPatternMatch, command: string, toolName: string): DiagnosisReport {
    return {
      id: `diagnosis-tool_interceptor-${this.context.nodeId}-${Date.now()}`,
      timestamp: Date.now(),
      detector: "tool_interceptor",
      severity: "critical",
      executionId: this.context.executionId,
      nodeId: this.context.nodeId,
      nodeType: this.context.nodeType,
      pattern: `process_conflict:${match.subtype}`,
      evidence: [
        {
          errorMessage: match.description,
          scriptSnippet: match.snippet,
          toolName,
          command: command.substring(0, 500),
        },
      ],
      context: {
        retryCount: 0,
        nodeDurationMs: 0,
        workflowProgress: 0,
        interceptionPoint: "tool_call",
      },
    }
  }

  /**
   * Build guidance message to inject into the agent conversation.
   * This is what the model will see as the tool result when blocked.
   */
  private buildGuidance(match: DangerousPatternMatch): string {
    return [
      `⛔ BLOCKED: ${match.description}`,
      "",
      "This command was blocked by the safety guard (process_conflict detector).",
      "You MUST NOT attempt this command or any variation of it.",
      "",
      "Instead, use one of these safe alternatives:",
      "- If you need to stop a process you started, use its PID from a background job you tracked.",
      "- If you need to free a port, check if YOU started a server on it and stop that specific process.",
      "- If you need to test connectivity, use a different port that is not protected.",
      "",
      "Continue with your task using safe commands only.",
    ].join("\n")
  }
}
