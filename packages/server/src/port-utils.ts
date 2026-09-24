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

/**
 * Parent PID of `pid` (1-hop), or null when unknown (dead pid / platform
 * tooling unavailable). Used by the instance-close safety gate to walk the
 * ancestry chain and refuse kills whose ancestors include the Octopus host.
 */
export function findParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null // never interpolate non-numeric input into the shell
  try {
    if (process.platform === "win32") {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`,
        { encoding: "utf8", timeout: 5000 },
      ).trim()
      const ppid = parseInt(out)
      return !isNaN(ppid) && ppid > 0 ? ppid : null
    }
    const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim()
    const ppid = parseInt(out)
    return !isNaN(ppid) && ppid > 0 ? ppid : null
  } catch {
    return null
  }
}

/** Walk up from `pid` collecting the ancestor chain (inclusive of pid,
 *  capped at `maxDepth` hops). Single platform call — per-hop PowerShell
 *  spawn was seconds-slow on Windows. */
export function processAncestry(pid: number, maxDepth = 10): number[] {
  if (!Number.isInteger(pid) || pid <= 0) return []
  try {
    if (process.platform === "win32") {
      const ps =
        `$p=${pid}; $chain=@($p); for($i=0;$i -lt ${maxDepth};$i++){ ` +
        `$q=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue; ` +
        `if(-not $q){break}; $p=$q.ParentProcessId; ` +
        `if($p -le 0 -or $chain -contains $p){break}; $chain+=$p }; $chain -join ','`
      const out = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
        encoding: "utf8",
        timeout: 15000,
      }).trim()
      return out.split(/[,\s]+/).map(Number).filter(n => Number.isInteger(n) && n > 0)
    }
    const sh =
      `p=${pid}; chain=$p; i=0; while [ $i -lt ${maxDepth} ]; do ` +
      `ppid=$(ps -o ppid= -p $p 2>/dev/null | tr -d ' '); ` +
      `case " $chain " in *" $ppid "*) break;; esac; ` +
      `[ -z "$ppid" ] && break; chain="$chain $ppid"; p=$ppid; i=$((i+1)); done; echo $chain`
    const out = execSync(sh, { encoding: "utf8", timeout: 15000 }).trim()
    return out.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0)
  } catch {
    return [pid]
  }
}

/** Extract the port from an http(s) URL; null when unparseable or defaultless. */
export function portFromUrl(url: string): number | null {
  try {
    const u = new URL(url)
    if (u.port) return parseInt(u.port)
    return u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : null
  } catch {
    return null
  }
}
