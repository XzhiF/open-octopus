/**
 * Process Isolation — shared utilities for BashExecutor and PythonExecutor.
 *
 * Provides:
 * - Host environment variable injection (OCTOPUS_HOST_PID, OCTOPUS_HOST_PORTS)
 * - Harness safety wrapper script (bash functions that block host process killing)
 * - Process tree kill utilities (platform-aware, with SIGTERM → SIGKILL chain)
 */

import { execSync } from "child_process"

// ============================================================
// Environment injection
// ============================================================

/**
 * Build child process environment with host isolation variables.
 * - Copies process.env (string values only)
 * - Removes OCTOPUS_DB_PATH (sensitive)
 * - Injects OCTOPUS_HOST_PID (host Node.js PID)
 * - Injects OCTOPUS_HOST_PORTS (serverPort,webPort)
 */
export function buildHostEnv(): Record<string, string> {
  const serverPort = parseInt(process.env.PORT ?? "3001", 10)
  const webPort = serverPort - 1

  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      childEnv[key] = value
    }
  }

  // Remove sensitive env
  delete childEnv.OCTOPUS_DB_PATH

  // Inject isolation vars
  childEnv.OCTOPUS_HOST_PID = String(process.pid)
  childEnv.OCTOPUS_HOST_PORTS = `${serverPort},${webPort}`

  return childEnv
}

// ============================================================
// Harness safety wrapper (bash)
// ============================================================

/**
 * Bash wrapper script prepended to every user script.
 * Defines safe_kill / safe_pkill functions and aliases them
 * over the built-in kill / pkill commands.
 *
 * Note: `shopt -s expand_aliases` is required because bash -c
 * runs in non-interactive mode where aliases are disabled by default.
 */
export const HARNESS_WRAPPER = `# --- HARNESS SAFETY WRAPPER ---
shopt -s expand_aliases
OCTOPUS_HOST_PID=\${OCTOPUS_HOST_PID:-0}

safe_kill() {
  local target="$1"
  shift
  if [ "$target" = "$OCTOPUS_HOST_PID" ] || [ "$target" = "-$OCTOPUS_HOST_PID" ]; then
    echo "[HARNESS] BLOCKED: Cannot kill host process (PID: $OCTOPUS_HOST_PID)" >&2
    return 1
  fi
  command kill "$target" "$@"
}

safe_pkill() {
  echo "[HARNESS] pkill is restricted" >&2
  return 1
}

# Override dangerous commands
alias kill='safe_kill'
alias pkill='safe_pkill'
# --- END HARNESS WRAPPER ---
`

/**
 * Prepend the harness safety wrapper to a user bash script.
 */
export function prependWrapper(script: string): string {
  return HARNESS_WRAPPER + "\n" + script
}

// ============================================================
// Process tree kill utilities
// ============================================================

/**
 * Kill a process tree using platform-appropriate method.
 * - Unix: process group kill via `process.kill(-pid, signal)`
 * - Windows: `taskkill /PID pid /T /F`
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" })
    } catch {
      // Process may already be dead
    }
  } else {
    try {
      process.kill(-pid, signal)
    } catch {
      // Fallback: kill just the PID (process group may not exist)
      try {
        process.kill(pid, signal)
      } catch {
        // Process may already be dead
      }
    }
  }
}

/**
 * Graceful force kill chain: SIGTERM → wait graceMs → SIGKILL.
 * Fires SIGTERM immediately, then schedules SIGKILL after the grace period.
 * Returns a cleanup function that cancels the pending SIGKILL timer.
 */
export function startForceKillChain(pid: number, graceMs = 5000): { cancel: () => void } {
  killProcessTree(pid, "SIGTERM")

  const forceKillTimer = setTimeout(() => {
    killProcessTree(pid, "SIGKILL")
  }, graceMs)

  // Don't let the timer keep the Node.js process alive
  if (forceKillTimer.unref) {
    forceKillTimer.unref()
  }

  return {
    cancel() {
      clearTimeout(forceKillTimer)
    },
  }
}
