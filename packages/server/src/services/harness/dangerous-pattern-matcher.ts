// packages/server/src/services/harness/dangerous-pattern-matcher.ts
//
// Extracted pattern matching logic from ProcessConflictDetector.
// Used by both the existing detector (bash/python nodes) and
// the new ToolInterceptor (agent node bash tool calls).

export interface DangerousPatternConfig {
  hostPid: string
  hostPorts: string[]
}

export interface DangerousPatternMatch {
  subtype: string // "pid_conflict" | "port_conflict"
  description: string
  snippet: string
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

    // Generic OCTOPUS_HOST_PID in kill context
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

    // Server binding patterns
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

/**
 * Reusable dangerous pattern matcher.
 * Extracted from ProcessConflictDetector to be shared between
 * the static detector (bash/python nodes) and the tool interceptor (agent nodes).
 */
export class DangerousPatternMatcher {
  private pidPatterns: Array<{ pattern: RegExp; description: string }>
  private portPatterns: Array<{ pattern: RegExp; description: string }>

  constructor(config: DangerousPatternConfig) {
    this.pidPatterns = buildPidPatterns(config.hostPid)
    this.portPatterns = buildPortPatterns(config.hostPorts)
  }

  /**
   * Check a command string against dangerous patterns.
   * Returns match info if dangerous, null if safe.
   */
  match(command: string): DangerousPatternMatch | null {
    if (!command) return null

    // Check PID patterns
    for (const { pattern, description } of this.pidPatterns) {
      if (pattern.test(command)) {
        return {
          subtype: "pid_conflict",
          description,
          snippet: command.substring(0, 200),
        }
      }
    }

    // Check indirect PID references: VAR=$OCTOPUS_HOST_PID then kill $VAR
    const indirectMatch = this.checkIndirectPidReference(command)
    if (indirectMatch) {
      return {
        subtype: "pid_conflict",
        description: indirectMatch,
        snippet: command.substring(0, 200),
      }
    }

    // Check port patterns
    for (const { pattern, description } of this.portPatterns) {
      if (pattern.test(command)) {
        return {
          subtype: "port_conflict",
          description,
          snippet: command.substring(0, 200),
        }
      }
    }

    return null
  }

  /**
   * Detect indirect PID references: a variable assigned from $OCTOPUS_HOST_PID
   * and then used in a kill command.
   */
  private checkIndirectPidReference(command: string): string | null {
    const assignRegex = /\b(\w+)\s*=\s*\$\{?OCTOPUS_HOST_PID\}?/g
    const taintedVars = new Set<string>()

    let match: RegExpExecArray | null
    while ((match = assignRegex.exec(command)) !== null) {
      taintedVars.add(match[1])
    }

    if (taintedVars.size === 0) return null

    for (const varName of taintedVars) {
      const killPattern = new RegExp(
        `(?:kill|taskkill|pkill)\\b[^\\n]*\\$${varName}\\b`,
        "i",
      )
      if (killPattern.test(command)) {
        return `kill targeting $${varName} (assigned from $OCTOPUS_HOST_PID)`
      }
    }

    return null
  }
}
