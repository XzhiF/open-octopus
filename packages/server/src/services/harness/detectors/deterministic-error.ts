// packages/server/src/services/harness/detectors/deterministic-error.ts
//
// DeterministicErrorDetector — detects bash/python node failures caused by
// deterministic errors (syntax, missing imports, command not found, etc.)
// that will never self-resolve through retries.
// Fires at attempt 1 to avoid wasting retry attempts.

import type { DiagnosisReport } from "@octopus/shared"
import { BaseDetector } from "../base-detector"
import type { HarnessCallbackEvent } from "../base-detector"

// ─── Deterministic error patterns ─────────────────────────────────────────

interface ErrorPattern {
  pattern: RegExp
  label: string
  severity: "info" | "warning" | "critical"
}

/**
 * Bash error patterns that indicate deterministic failures.
 * These errors will never self-resolve through retries.
 */
const BASH_DETERMINISTIC_PATTERNS: ErrorPattern[] = [
  // Command not found
  { pattern: /command not found/i, label: "command_not_found", severity: "critical" },
  { pattern: /:\s*\w+:\s*not found/i, label: "command_not_found", severity: "critical" },
  { pattern: /No such file or directory/i, label: "file_not_found", severity: "warning" },

  // Bash syntax errors
  { pattern: /syntax error/i, label: "syntax_error", severity: "critical" },
  { pattern: /unexpected (?:token|EOF|end of file)/i, label: "syntax_error", severity: "critical" },
  { pattern: /unterminated (?:string|quote)/i, label: "syntax_error", severity: "critical" },

  // Permission / access
  { pattern: /Permission denied/i, label: "permission_denied", severity: "warning" },
  { pattern: /cannot execute/i, label: "permission_denied", severity: "warning" },

  // Missing tools / packages (apt, brew, etc.)
  { pattern: /Unable to locate package/i, label: "missing_package", severity: "critical" },
  { pattern: /E: Unable to/i, label: "missing_package", severity: "critical" },
]

/**
 * Python error patterns that indicate deterministic failures.
 */
const PYTHON_DETERMINISTIC_PATTERNS: ErrorPattern[] = [
  // Import errors
  { pattern: /ModuleNotFoundError/i, label: "missing_module", severity: "critical" },
  { pattern: /ImportError/i, label: "import_error", severity: "warning" },

  // Syntax errors
  { pattern: /SyntaxError/i, label: "syntax_error", severity: "critical" },
  { pattern: /IndentationError/i, label: "syntax_error", severity: "critical" },
  { pattern: /TabError/i, label: "syntax_error", severity: "critical" },

  // Name / attribute errors
  { pattern: /NameError:.*not defined/i, label: "undefined_reference", severity: "warning" },
  { pattern: /AttributeError:.*has no attribute/i, label: "undefined_reference", severity: "warning" },

  // Type errors (code bugs)
  { pattern: /TypeError:/i, label: "type_error", severity: "warning" },
  { pattern: /ValueError:/i, label: "type_error", severity: "warning" },
  { pattern: /KeyError:/i, label: "type_error", severity: "warning" },

  // File not found
  { pattern: /FileNotFoundError/i, label: "file_not_found", severity: "warning" },

  // Permission errors
  { pattern: /PermissionError/i, label: "permission_denied", severity: "warning" },
]

/**
 * Patterns that indicate TRANSIENT errors (should NOT trigger detector).
 * These take priority over deterministic patterns.
 * Checked against result.error ONLY (not logLines) — see design Q5 rationale.
 */
const TRANSIENT_OVERRIDE_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /network is unreachable/i,
  /Connection refused/i,
  /Connection reset/i,
  /timed?\s*out/i,
  /timeout/i,
  /5\d{2}\s/,
  /rate.?limit/i,
  /too many requests/i,
  /service unavailable/i,
  /temporarily unavailable/i,
  /resource temporarily unavailable/i,
]

// ─── Detector class ───────────────────────────────────────────────────────

export interface DeterministicErrorConfig {
  /** Whether to also capture script content from beforeNode events. Default: true. */
  captureScriptSnippet?: boolean
}

export class DeterministicErrorDetector extends BaseDetector {
  readonly name = "deterministic_error"

  /** nodeId → nodeType map, populated from nodeStart events. */
  private nodeTypeMap = new Map<string, string>()

  /** nodeId → script content, populated from beforeNode events. */
  private scriptMap = new Map<string, string>()

  /** Whether to capture script snippets for evidence. */
  private captureScriptSnippet: boolean

  constructor(config?: DeterministicErrorConfig) {
    super()
    this.captureScriptSnippet = config?.captureScriptSnippet ?? true
  }

  observe(event: HarnessCallbackEvent): DiagnosisReport | null {
    // Track nodeType from nodeStart events
    if (event.type === "nodeStart") {
      this.nodeTypeMap.set(event.nodeId, event.nodeType)
      return null
    }

    // Track script content from beforeNode events (optional enrichment)
    if (event.type === "beforeNode" && this.captureScriptSnippet) {
      const script = event.nodeConfig.bash
        ?? event.nodeConfig.python
        ?? event.nodeConfig.script
        ?? ""
      if (script) {
        this.scriptMap.set(event.nodeId, script)
      }
      return null
    }

    // Only react to nodeRetry events
    if (event.type !== "nodeRetry") return null

    const { nodeId, attempt, result } = event

    // Only fire on attempt 1 (first failure)
    if (attempt !== 1) return null

    if (!result) return null

    // Look up nodeType — must be known
    const nodeType = this.nodeTypeMap.get(nodeId)
    if (!nodeType) return null

    // Only for bash/python nodes — agents can self-correct
    if (nodeType !== "bash" && nodeType !== "python") return null

    // Check transient override patterns against result.error ONLY (Q5)
    const errorField = result.error ?? ""
    if (errorField) {
      for (const transientPattern of TRANSIENT_OVERRIDE_PATTERNS) {
        if (transientPattern.test(errorField)) return null
      }
    }

    // Combine error text for deterministic pattern matching
    const allErrorText = [
      errorField,
      ...(result.logLines ?? []),
    ].join("\n")

    if (!allErrorText.trim()) return null

    // Select primary pattern set based on nodeType, then check secondary
    const primaryPatterns = nodeType === "python"
      ? PYTHON_DETERMINISTIC_PATTERNS
      : BASH_DETERMINISTIC_PATTERNS

    const secondaryPatterns = nodeType === "python"
      ? BASH_DETERMINISTIC_PATTERNS
      : PYTHON_DETERMINISTIC_PATTERNS

    // Check primary patterns first (higher confidence match)
    for (const { pattern, label, severity } of primaryPatterns) {
      if (pattern.test(allErrorText)) {
        return this.buildReport(nodeId, nodeType, label, severity, allErrorText, attempt)
      }
    }

    // Then secondary patterns (cross-language: python-in-bash or bash-in-python)
    for (const { pattern, label, severity } of secondaryPatterns) {
      if (pattern.test(allErrorText)) {
        return this.buildReport(nodeId, nodeType, label, severity, allErrorText, attempt)
      }
    }

    // No deterministic pattern matched — let StupidRetryDetector handle at attempt 2+
    return null
  }

  private buildReport(
    nodeId: string,
    nodeType: string,
    label: string,
    severity: "info" | "warning" | "critical",
    errorText: string,
    attempt: number,
  ): DiagnosisReport {
    // Extract the most relevant error lines for evidence
    const relevantLines = errorText
      .split("\n")
      .filter(line => line.trim().length > 0)
      .slice(-10)

    // Include script snippet if available
    const script = this.scriptMap.get(nodeId)

    const evidence: Record<string, any> = {
      errorMessage: relevantLines.join("\n"),
      errorPattern: label,
      attempt,
    }
    if (script) {
      evidence.scriptSnippet = script.substring(0, 500)
    }

    return {
      id: `diagnosis-deterministic_error-${nodeId}-${Date.now()}`,
      timestamp: Date.now(),
      detector: "deterministic_error",
      severity,
      executionId: "",  // filled by pipeline
      nodeId,
      nodeType,
      pattern: `deterministic_error:${label}`,
      evidence: [evidence],
      context: {
        retryCount: 1,
        nodeDurationMs: 0,
        workflowProgress: 0,
        errorLabel: label,
      },
    }
  }

  override reset(): void {
    this.nodeTypeMap.clear()
    this.scriptMap.clear()
  }

  override destroy(): void {
    this.nodeTypeMap.clear()
    this.scriptMap.clear()
  }
}
