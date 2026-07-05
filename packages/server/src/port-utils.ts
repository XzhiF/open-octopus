import net from "net"
import { execFileSync } from "child_process"

/**
 * Check if a TCP port is currently in use.
 */
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(true))
    server.once("listening", () => server.close(() => resolve(false)))
    server.listen(port)
  })
}

/**
 * Find the PID(s) listening on a given port.
 * Returns empty array if no process found or detection fails.
 *
 * B-01 fix: Use execFileSync (no shell interpolation) instead of execSync.
 * The port parameter is always a number, but we still avoid spawning a shell
 * to keep a consistent security posture across the codebase.
 */
export function findPidOnPort(port: number): number[] {
  try {
    if (process.platform === "win32") {
      // B-01 fix: Use netstat directly via execFileSync; parse output in JS instead of piping to findstr.
      const output = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 5000 })
      const pids: number[] = []
      const portStr = `:${port}`
      for (const line of output.split("\n")) {
        if (!line.includes("LISTENING")) continue
        const trimmed = line.trim()
        if (!trimmed.includes(portStr)) continue
        const parts = trimmed.split(/\s+/)
        const pid = parseInt(parts[parts.length - 1], 10)
        if (!isNaN(pid) && pid > 0 && !pids.includes(pid)) {
          pids.push(pid)
        }
      }
      return pids
    } else {
      const output = execFileSync("lsof", ["-ti", `:${port}`], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      return output
        .trim()
        .split("\n")
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n) && n > 0)
    }
  } catch {
    return []
  }
}

/**
 * Kill a process by PID. Returns true if successful.
 *
 * B-01 fix: Use process.kill (Unix) or execFileSync (Windows) — no shell interpolation.
 */
export function killPid(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], {
        stdio: "ignore",
        timeout: 5000,
      })
    } else {
      process.kill(pid, "SIGKILL")
    }
    return true
  } catch {
    return false
  }
}

/**
 * Wait for a port to become available, polling up to timeoutMs.
 */
export function waitForPort(port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      isPortInUse(port).then((inUse) => {
        if (!inUse) { resolve(true); return }
        if (Date.now() >= deadline) { resolve(false); return }
        setTimeout(check, 200)
      })
    }
    check()
  })
}
