import path from 'path'
import fs from 'fs'

// ── Dangerous command patterns ──────────────────────────────────

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+\/(\s|$)/, description: 'Recursive force delete from root' },
  { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\s+\/(\s|$)/, description: 'Force recursive delete from root' },
  { pattern: /\brm\s+-rf\s+\/(\s|$)/, description: 'rm -rf /' },
  { pattern: /\bgit\s+push\s+.*--force\b/, description: 'Force push' },
  { pattern: /\bgit\s+push\s+-f\b/, description: 'Force push (short flag)' },
  { pattern: /\bgit\s+reset\s+--hard\b/, description: 'Hard reset' },
  { pattern: /\bchmod\s+777\b/, description: 'World-writable permissions' },
  { pattern: /\bdd\s+if=/, description: 'Raw disk write' },
  { pattern: /\bmkfs\b/, description: 'Filesystem format' },
  { pattern: /\bshutdown\b/, description: 'System shutdown' },
  { pattern: /\breboot\b/, description: 'System reboot' },
  { pattern: /\binit\s+0\b/, description: 'System halt' },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/, description: 'Fork bomb' },
  { pattern: /\bcurl\b.*\|\s*(bash|sh)\b/, description: 'Pipe curl to shell' },
  { pattern: /\bwget\b.*\|\s*(bash|sh)\b/, description: 'Pipe wget to shell' },
]

// ── Boundary check: sensitive paths ────────────────────────────

const SENSITIVE_PATHS = [
  '/etc/passwd',
  '/etc/shadow',
  '/etc/hosts',
  '/etc/sudoers',
  '.ssh/',
  '.gnupg/',
  '.aws/credentials',
  '.env',
]

// ── Types ──────────────────────────────────────────────────────

export type SafetyAction = 'allow' | 'block' | 'intercept'

export interface SafetyCheckResult {
  action: SafetyAction
  reason?: string
  pattern?: string
}

// ── SafetyInterceptor ─────────────────────────────────────────

export class SafetyInterceptor {
  /**
   * Check if a command is dangerous.
   */
  isDangerousCommand(command: string): boolean {
    for (const { pattern } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) return true
    }
    return false
  }

  /**
   * Get the reason a command is dangerous.
   */
  getDangerReason(command: string): string | null {
    for (const { pattern, description } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) return description
    }
    return null
  }

  /**
   * Check if a file path escapes the workspace boundary.
   */
  isPathOutsideWorkspace(filePath: string, workspacePath: string): boolean {
    try {
      const resolved = path.resolve(filePath)
      const workspaceReal = fs.existsSync(workspacePath)
        ? fs.realpathSync(workspacePath)
        : path.resolve(workspacePath)

      // Check for symlink escape
      if (fs.existsSync(filePath)) {
        const fileReal = fs.realpathSync(filePath)
        if (!fileReal.startsWith(workspaceReal)) return true
      }

      // Check for path traversal
      const relative = path.relative(workspaceReal, resolved)
      if (relative.startsWith('..') || path.isAbsolute(relative)) return true

      // Check for sensitive paths
      for (const sensitive of SENSITIVE_PATHS) {
        if (resolved.includes(sensitive)) return true
      }

      return false
    } catch {
      // If we can't resolve, block by default
      return true
    }
  }

  /**
   * Full check: command + workspace boundary.
   */
  checkAndIntercept(
    command: string,
    workspacePath?: string,
    filePath?: string,
  ): SafetyCheckResult {
    // 1. Check dangerous command
    if (this.isDangerousCommand(command)) {
      return {
        action: 'block',
        reason: `Dangerous command: ${this.getDangerReason(command)}`,
        pattern: command,
      }
    }

    // 2. Check workspace boundary
    if (workspacePath && filePath && this.isPathOutsideWorkspace(filePath, workspacePath)) {
      return {
        action: 'block',
        reason: `Path escapes workspace boundary: ${filePath}`,
        pattern: filePath,
      }
    }

    return { action: 'allow' }
  }

  /**
   * Get all dangerous patterns for documentation.
   */
  getDangerousPatterns(): Array<{ pattern: string; description: string }> {
    return DANGEROUS_PATTERNS.map(({ pattern, description }) => ({
      pattern: pattern.source,
      description,
    }))
  }
}

// Singleton
let instance: SafetyInterceptor | null = null

export function getSafetyInterceptor(): SafetyInterceptor {
  if (!instance) {
    instance = new SafetyInterceptor()
  }
  return instance
}
