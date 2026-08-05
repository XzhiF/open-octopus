// packages/server/src/services/harness/detectors/process-conflict.ts
//
// ProcessConflictDetector — static scan of bash/python scripts for dangerous patterns:
// - kill/taskkill/pkill targeting host PID
// - Binding to host ports
// - os.kill in Python

import type { DiagnosisReport } from "@octopus/shared"
import { BaseDetector } from "../base-detector"
import type { HarnessCallbackEvent } from "../base-detector"

export interface ProcessConflictConfig {
  hostPid: string
  hostPorts: string[]
}

/**
 * Build regex patterns for PID-based conflict detection.
 */
function buildPidPatterns(hostPid: string): Array<{ pattern: RegExp; description: string }> {
  const patterns: Array<{ pattern: RegExp; description: string }> = []

  if (hostPid) {
    // Direct PID references
    patterns.push({
      pattern: new RegExp(`(?:kill|taskkill|pkill)\\b.*\\b${escapeRegex(hostPid)}\\b`, "i"),
      description: `kill targeting host PID ${hostPid}`,
    })

    // Variable references to OCTOPUS_HOST_PID in kill commands
    patterns.push({
      pattern: /(?:kill|taskkill|pkill)\b.*\$OCTOPUS_HOST_PID/i,
      description: "kill targeting $OCTOPUS_HOST_PID",
    })

    // Generic OCTOPUS_HOST_PID in kill context (also catches kill -9 $OCTOPUS_HOST_PID etc.)
    patterns.push({
      pattern: /kill\b.*OCTOPUS_HOST_PID/i,
      description: "kill referencing OCTOPUS_HOST_PID",
    })

    // Python os.kill with host PID
    patterns.push({
      pattern: new RegExp(`os\\.kill\\s*\\(\\s*${escapeRegex(hostPid)}`, "i"),
      description: `os.kill targeting host PID ${hostPid}`,
    })
  }

  // Python os.kill with OCTOPUS_HOST_PID variable
  patterns.push({
    pattern: /os\.kill\s*\(.*OCTOPUS_HOST_PID/i,
    description: "os.kill targeting OCTOPUS_HOST_PID",
  })

  // taskkill /PID with host PID reference
  if (hostPid) {
    patterns.push({
      pattern: new RegExp(`taskkill\\b.*\\/PID\\s+${escapeRegex(hostPid)}\\b`, "i"),
      description: "taskkill targeting host PID",
    })
  }

  return patterns
}

/**
 * Build regex patterns for port-based conflict detection.
 */
function buildPortPatterns(hostPorts: string[]): Array<{ pattern: RegExp; description: string }> {
  const patterns: Array<{ pattern: RegExp; description: string }> = []

  for (const port of hostPorts) {
    if (!port) continue

    // Server binding patterns: `server.listen(PORT)`, `-m http.server PORT`, `--port PORT`
    patterns.push({
      pattern: new RegExp(
        `(?:listen|serve|server|http\\.server|--port|--p|-p)\\b[^\\n]*\\b${escapeRegex(port)}\\b`,
        "i",
      ),
      description: `binding to host port ${port}`,
    })

    // netcat/socat on host port
    patterns.push({
      pattern: new RegExp(`(?:nc|ncat|socat)\\b[^\\n]*\\b${escapeRegex(port)}\\b`, "i"),
      description: `nc/socat on host port ${port}`,
    })
  }

  return patterns
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export class ProcessConflictDetector extends BaseDetector {
  readonly name = "process_conflict"
  private pidPatterns: Array<{ pattern: RegExp; description: string }>
  private portPatterns: Array<{ pattern: RegExp; description: string }>

  constructor(config: ProcessConflictConfig) {
    super()
    this.pidPatterns = buildPidPatterns(config.hostPid)
    this.portPatterns = buildPortPatterns(config.hostPorts)
  }

  observe(event: HarnessCallbackEvent): DiagnosisReport | null {
    if (event.type !== "beforeNode") return null

    const { nodeId, nodeType, nodeConfig } = event

    // Only scan bash and python nodes
    if (nodeType !== "bash" && nodeType !== "python") return null

    // Get script content
    const script =
      nodeConfig.bash ?? nodeConfig.python ?? nodeConfig.script ?? ""

    if (!script) return null

    // Check PID patterns
    for (const { pattern, description } of this.pidPatterns) {
      if (pattern.test(script)) {
        return this.buildReport(nodeId, nodeType, "pid_conflict", description, script)
      }
    }

    // Check port patterns
    for (const { pattern, description } of this.portPatterns) {
      if (pattern.test(script)) {
        return this.buildReport(nodeId, nodeType, "port_conflict", description, script)
      }
    }

    return null
  }

  private buildReport(
    nodeId: string,
    nodeType: string,
    subtype: string,
    description: string,
    script: string,
  ): DiagnosisReport {
    return {
      id: `diagnosis-process_conflict-${nodeId}-${Date.now()}`,
      timestamp: Date.now(),
      detector: "process_conflict",
      severity: "critical",
      executionId: "",  // filled by pipeline
      nodeId,
      nodeType,
      pattern: `process_conflict:${subtype}`,
      evidence: [
        {
          errorMessage: description,
          scriptSnippet: script.substring(0, 200),
        },
      ],
      context: {
        retryCount: 0,
        nodeDurationMs: 0,
        workflowProgress: 0,
      },
    }
  }
}
