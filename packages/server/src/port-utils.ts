import net from "net"
import { execSync } from "child_process"

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
 */
export function findPidOnPort(port: number): number[] {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: "utf8" })
      const pids: number[] = []
      for (const line of output.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const parts = trimmed.split(/\s+/)
        const pid = parseInt(parts[parts.length - 1])
        if (!isNaN(pid) && pid > 0 && !pids.includes(pid)) {
          pids.push(pid)
        }
      }
      return pids
    } else {
      const output = execSync(`lsof -ti :${port}`, { encoding: "utf8" })
      return output.trim().split("\n").map(Number).filter(n => !isNaN(n) && n > 0)
    }
  } catch {
    return []
  }
}

/**
 * Kill a process by PID. Returns true if successful.
 */
export function killPid(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" })
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
