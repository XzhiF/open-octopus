// Hard guards — code-only safety rails.
//
// These are NOT policy: they never ask an agent, never read a Skill, and cannot
// be disabled by configuration. They run before incident routing. When one
// fires, the runtime applies the action synchronously and records a resolved
// incident with resolution_source = 'policy' (audit only).

import type { DiagnosisReport } from "@octopus/shared"

export type HardGuardAction = "block" | "abort"

export interface HardGuardVerdict {
  action: HardGuardAction
  reason: string
  /** Incident kind, e.g. `process_conflict`. */
  kind: string
  /** Whether downstream nodes may continue (block only). */
  continueSubsequent?: boolean
}

export interface HardGuard {
  evaluate(report: DiagnosisReport): HardGuardVerdict | null
}

/**
 * Process/port conflict: a script tries to kill the host PID or bind a host
 * port. Block the node — never let an LLM talk us out of this one.
 */
export class ProcessConflictGuard implements HardGuard {
  evaluate(report: DiagnosisReport): HardGuardVerdict | null {
    if (report.detector !== "process_conflict") return null
    if (report.severity !== "critical") return null
    return {
      action: "block",
      reason: "检测到进程/端口冲突，已由硬护栏阻断以保护宿主进程",
      kind: "process_conflict",
      continueSubsequent: false,
    }
  }
}

/**
 * Dangerous tool command (kill host PID / bind host port) intercepted inside an
 * agent turn.
 */
export class DangerousToolGuard implements HardGuard {
  evaluate(report: DiagnosisReport): HardGuardVerdict | null {
    if (report.detector !== "tool_interceptor") return null
    if (report.severity !== "critical") return null
    return {
      action: "block",
      reason: "Agent 尝试执行危险命令，已被硬护栏拦截",
      kind: "dangerous_tool",
      continueSubsequent: true,
    }
  }
}

export function createDefaultHardGuards(): HardGuard[] {
  return [new ProcessConflictGuard(), new DangerousToolGuard()]
}

export function evaluateHardGuards(
  guards: HardGuard[],
  report: DiagnosisReport,
): HardGuardVerdict | null {
  for (const guard of guards) {
    const verdict = guard.evaluate(report)
    if (verdict) return verdict
  }
  return null
}
