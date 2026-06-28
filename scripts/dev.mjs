#!/usr/bin/env node
/**
 * One-click dev startup script with multi-instance isolation.
 *
 * Usage:
 *   pnpm dev                          # auto-detect mode, build first
 *   pnpm dev --skip-build             # skip build (if dist/ already exists)
 *   pnpm dev --isolated               # force hash ports + unique DB (any repo)
 *   pnpm dev --port 4001              # custom server port (web = port+1)
 *   pnpm dev --isolated --no-kill     # don't kill existing processes on target ports
 *   node scripts/dev.mjs              # same as above
 *
 * Modes:
 *   default   — main repo (.git is directory), ports 3001/3000, shared DB
 *   isolated  — worktree (.git is file) OR --isolated flag, hash ports, branch DB
 *   custom    — --port flag, exact ports, no auto-kill of defaults
 *
 * Build safety:
 *   Building only writes to packages/.../dist/ in the source tree.
 *   Prod instances run from ~/.octopus/prod/ (stable copy), so dev builds
 *   never affect running prod services.
 *
 * Bypasses pnpm predev hooks by directly spawning node/next processes.
 */

import { spawn, execSync } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import path from "path"
import os from "os"
import net from "net"

const repoRoot = process.cwd()

// ─── Mode Detection ───────────────────────────────────────────────

function isWorktree() {
  try {
    return fs.statSync(path.join(repoRoot, ".git")).isFile()
  } catch {
    return false
  }
}

function getBranchName() {
  try {
    const gitPath = path.join(repoRoot, ".git")
    const stat = fs.statSync(gitPath)

    let headPath
    if (stat.isFile()) {
      // Git worktree: .git is a file with "gitdir: <path>"
      const gitContent = fs.readFileSync(gitPath, "utf8").trim()
      const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/)
      if (gitdirMatch) {
        headPath = path.join(gitdirMatch[1], "HEAD")
      }
    } else if (stat.isDirectory()) {
      // Normal repo: .git is a directory
      headPath = path.join(gitPath, "HEAD")
    }

    if (headPath) {
      const headContent = fs.readFileSync(headPath, "utf8").trim()
      const match = headContent.match(/ref: refs\/heads\/(.+)/)
      if (match) return match[1]
    }
  } catch {}
  return path.basename(repoRoot)
}

function safeName(branch) {
  return branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
}

// ─── Port Allocation ─────────────────────────────────────────────

const PORTS_DIR = path.join(os.homedir(), ".octopus", "ports")
const PORT_RANGE_START = 3100
const PORT_PAIRS = 250

function hashPortOffset(branch) {
  const hash = createHash("sha1").update(branch).digest()
  return hash.readUInt16BE(0) % PORT_PAIRS
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(true))
    server.once("listening", () => server.close(() => resolve(false)))
    server.listen(port)
  })
}

function readPortFile(safe) {
  const file = path.join(PORTS_DIR, `${safe}.json`)
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return null }
}

function writePortFile(safe, data) {
  fs.mkdirSync(PORTS_DIR, { recursive: true })
  fs.writeFileSync(path.join(PORTS_DIR, `${safe}.json`), JSON.stringify(data, null, 2))
}

async function allocatePorts(branch) {
  const safe = safeName(branch)

  // Check persisted
  const persisted = readPortFile(safe)
  if (persisted) {
    if (!(await isPortInUse(persisted.server)) && !(await isPortInUse(persisted.web))) {
      return { server: persisted.server, web: persisted.web }
    }
  }

  // Hash + scan
  const baseOffset = hashPortOffset(branch)

  for (let i = 0; i < PORT_PAIRS; i++) {
    const offset = (baseOffset + i) % PORT_PAIRS
    const server = PORT_RANGE_START + offset * 2
    const web = server + 1
    if (!(await isPortInUse(server)) && !(await isPortInUse(web))) {
      writePortFile(safe, { branch, server, web, allocatedAt: new Date().toISOString() })
      return { server, web }
    }
  }
  throw new Error("No available port pairs in range 3100-3599")
}

// ─── Process Cleanup ─────────────────────────────────────────────

function killPort(port) {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: "utf8", timeout: 5000 })
      const pids = new Set()
      for (const line of output.split("\n")) {
        const parts = line.trim().split(/\s+/)
        const pid = parseInt(parts[parts.length - 1])
        if (!isNaN(pid) && pid > 0) pids.add(pid)
      }
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore", timeout: 5000 }) } catch {}
      }
    } else {
      const output = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 5000 })
      const pids = output.trim().split("\n").map(Number).filter(n => !isNaN(n) && n > 0)
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL") } catch {}
      }
    }
  } catch {
    // Port is free
  }
}

// ─── DB Initialization ───────────────────────────────────────────

function initBranchDb(branch) {
  const safe = safeName(branch)
  const dbDir = path.join(os.homedir(), ".octopus", "db")
  const mainDb = path.join(dbDir, "octopus.db")
  const branchDb = path.join(dbDir, `octopus-${safe}.db`)

  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })

  if (!fs.existsSync(branchDb)) {
    if (fs.existsSync(mainDb)) {
      fs.copyFileSync(mainDb, branchDb)
      console.log(`[dev] db:   copied octopus.db → octopus-${safe}.db`)
    } else {
      console.log(`[dev] db:   octopus-${safe}.db will be created fresh`)
    }
  } else {
    console.log(`[dev] db:   reusing octopus-${safe}.db`)
  }

  return branchDb
}

// ─── Health Check ────────────────────────────────────────────────

async function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/actuator/health`)
      if (res.ok) {
        const data = await res.json()
        // Map actuator response to legacy shape for dev script compatibility
        const server = data.components?.server?.details ?? {}
        return { mode: server.mode, pid: server.pid, status: data.status }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}

// ─── Main ────────────────────────────────────────────────────────

let children = []
let shuttingDown = false

function cleanup(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log("\n[dev] Shutting down...")

  for (const { child, label } of children) {
    if (child.killed || child.exitCode !== null) continue
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 5000 })
        console.log(`[${label}] killed`)
      } catch {}
    } else {
      child.kill("SIGTERM")
      console.log(`[${label}] SIGTERM sent`)
    }
  }

  setTimeout(() => process.exit(exitCode), 1500)
}

process.on("SIGINT", () => cleanup(0))
process.on("SIGTERM", () => cleanup(0))

function startProcess(cmd, args, env, label, cwd) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
    cwd: cwd || repoRoot,
  })

  child.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.log(`[${label}] ${line}`)
    }
  })
  child.stderr.on("data", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim()) console.error(`[${label}] ${line}`)
    }
  })

  child.on("exit", (code, signal) => {
    if (shuttingDown) return

    // 被外部信号杀死（pkill / kill 等）→ 只告警，不 cascade
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      children = children.filter(c => c.child !== child)
      console.error(`\n⚠️  [${label}] (PID ${child.pid}) 被信号 ${signal} 杀死`)
      if (children.length === 0) {
        console.error(`\n[dev] 所有子进程已退出，自动清理...\n`)
        process.exit(1)
      }
      console.error(`   其余服务继续运行。按 Ctrl+C 全部退出。\n`)
      return
    }

    // 正常/异常退出（exit code）→ cascade
    console.log(`[${label}] exited with code ${code}`)
    cleanup(code ?? 1)
  })

  children.push({ child, label })
  return child
}

// ─── Build ───────────────────────────────────────────────────────

function buildProject() {
  console.log("[dev] Building project...")
  try {
    execSync("pnpm build", { cwd: repoRoot, stdio: "inherit", timeout: 120000 })
    console.log("[dev] Build complete.")
  } catch {
    console.error("[dev] Build failed!")
    process.exit(1)
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const skipBuild = process.argv.includes("--skip-build")
  const forceIsolated = process.argv.includes("--isolated")
  const noKill = process.argv.includes("--no-kill")

  // --port <N> — custom server port (web = N+1)
  const portIdx = process.argv.indexOf("--port")
  const customPort = portIdx !== -1 ? parseInt(process.argv[portIdx + 1]) : null

  const worktree = isWorktree()
  let serverPort, webPort, dbPath, branch

  if (customPort) {
    // Custom port mode: exact ports, no auto-detection
    serverPort = customPort
    webPort = customPort + 1
    branch = getBranchName()
    dbPath = path.join(os.homedir(), ".octopus", "db", `octopus-${safeName(branch || "custom")}.db`)
    console.log(`[dev] mode:   custom (port=${customPort})`)
    if (!noKill) {
      killPort(serverPort)
      killPort(webPort)
    }
  } else if (worktree || forceIsolated) {
    branch = getBranchName()
    const safe = safeName(branch)
    const modeLabel = isWorktree() ? "isolated (worktree)" : "isolated (--isolated flag)"
    console.log(`[dev] mode:   ${modeLabel}`)
    console.log(`[dev] branch: ${branch}`)

    const ports = await allocatePorts(branch)
    serverPort = ports.server
    webPort = ports.web
    dbPath = initBranchDb(branch)

    // Clean stale processes on allocated ports only
    if (!noKill) {
      killPort(serverPort)
      killPort(webPort)
    }
  } else {
    console.log(`[dev] mode:   default (main repo)`)
    serverPort = 3001
    webPort = 3000
    dbPath = path.join(os.homedir(), ".octopus", "db", "octopus.db")

    // Clean stale processes on default ports
    if (!noKill) {
      killPort(serverPort)
      killPort(webPort)
    }
  }

  console.log(`[dev] port:   server=${serverPort}  web=${webPort}`)

  // Build before starting (safe: doesn't affect running prod instances)
  if (!skipBuild) {
    buildProject()
  } else {
    console.log("[dev] Skipping build (--skip-build)")
  }

  // Get local IP address
  const getLocalIP = () => {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address
        }
      }
    }
    return 'localhost'
  }
  const localIP = getLocalIP()

  // Start Server
  const serverEnv = {
    PORT: String(serverPort),
    OCTOPUS_DB_PATH: dbPath,
  }
  if (branch) serverEnv.OCTOPUS_BRANCH = branch

  startProcess(
    process.execPath,
    [path.join("packages", "server", "dist", "index.js")],
    serverEnv,
    "server"
  )

  // Wait for server health
  const health = await waitForServer(serverPort)
  if (!health) {
    console.error(`[dev] Server failed to start within 15s`)
    cleanup(1)
    return
  }

  // Start Web-app
  const webAppDir = path.join(repoRoot, "packages", "web-app")
  const nextBin = path.join(webAppDir, "node_modules", "next", "dist", "bin", "next")
  startProcess(
    process.execPath,
    [nextBin, "dev", "-p", String(webPort)],
    {
      SERVER_URL: `http://${localIP}:${serverPort}`,
    },
    "web",
    webAppDir
  )

  console.log(`\n[dev] ✓ server: http://${localIP}:${serverPort}`)
  console.log(`[dev] ✓ web:    http://${localIP}:${webPort}`)
  console.log(`[dev] ✓ health: mode=${health.mode}, pid=${health.pid}`)
  console.log(`\n[dev] Ready. Press Ctrl+C to stop.\n`)
}

main().catch((err) => {
  console.error(`[dev] Fatal: ${err.message}`)
  cleanup(1)
})
