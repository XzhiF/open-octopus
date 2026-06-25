#!/usr/bin/env node
/**
 * Kill any process occupying a TCP port. Cross-platform (Windows / macOS / Linux).
 *
 * Usage:  node scripts/kill-port.mjs <port>
 * Exit:   0 if port is now free, 1 on unexpected error
 *
 * Integrated into dev workflow via pnpm predev hooks — runs automatically
 * before `pnpm dev:server` and `pnpm dev:web` so stale processes never block startup.
 */

import { execSync } from "node:child_process"
import { platform } from "node:os"

const port = process.argv[2]
if (!port) {
  console.error("Usage: node scripts/kill-port.mjs <port>")
  process.exit(1)
}

const isWindows = platform() === "win32"

function findAndKill() {
  if (isWindows) {
    let output
    try {
      output = execSync(
        `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
        { encoding: "utf8", timeout: 5000 }
      )
    } catch {
      // findstr returns exit code 1 when no lines match — port is free
      return false
    }

    const pids = new Set()
    for (const line of output.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parts = trimmed.split(/\s+/)
      const pid = parseInt(parts[parts.length - 1])
      if (!isNaN(pid) && pid > 0) pids.add(pid)
    }

    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore", timeout: 5000 })
        console.log(`[kill-port] Killed PID ${pid} on port ${port}`)
      } catch {
        // Process may have already exited
      }
    }
    return pids.size > 0
  }

  // macOS / Linux
  let output
  try {
    output = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 5000 })
  } catch {
    return false
  }

  const pids = output.trim().split("\n").map(Number).filter(n => !isNaN(n) && n > 0)
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
      console.log(`[kill-port] Killed PID ${pid} on port ${port}`)
    } catch {
      // Process may have already exited
    }
  }
  return pids.length > 0
}

const killed = findAndKill()
if (!killed) {
  // Silent when port was already free — normal case, not an error
  process.exit(0)
}
