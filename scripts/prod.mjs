#!/usr/bin/env node
/**
 * Production startup script — build once, then run from the repo's own dist/.
 *
 * Usage:
 *   pnpm prod                   # build → start (built SPA served same-origin)
 *   pnpm prod --skip-build      # start without rebuilding (reuse existing dist/)
 *   pnpm prod --port 3000       # override the server port
 *   pnpm prod --port 3098,3099  # legacy "<web>,<server>" pair; UI follows <server>
 *   pnpm prod -k                # force-kill whatever holds the port
 *
 * Port:
 *   prod uses dev's UI port (3000) and hosts the built SPA + API on it
 *   (OCTOPUS_WEB_DIR), so UI + API share one port. Dev instead runs Vite on
 *   3000 + server on 3001, so dev and prod cannot run at the same time.
 *
 * Nothing is copied into ~/.octopus anymore — the server runs straight out of
 * packages/ * /dist. Only the DB stays there:
 *   ~/.octopus/db/octopus-prod.db (kept apart from dev's octopus.db)
 *
 * Resilience:
 *   - Server auto-restarts on unexpected exit (up to MAX_RESTARTS in window)
 *   - PID lock file prevents multiple prod.mjs instances
 *   - Detailed exit logging (code, signal) for debugging crashes
 */

import { spawn, execSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import net from "net"
import { parsePortPair } from "./port-arg.mjs"

const repoRoot = process.cwd()

// Same port as dev's UI (3000) — the built SPA is same-origin, so one port serves both.
// Override with --port.
let SERVER_PORT = 3000
const DB_PATH = path.join(os.homedir(), ".octopus", "db", "octopus-prod.db")

// PID lock file — prevents multiple prod.mjs instances
const PID_FILE = path.join(os.homedir(), ".octopus", "prod.pid")

// Auto-restart configuration
const MAX_RESTARTS = 5          // max restarts within the window
const RESTART_WINDOW_MS = 300_000 // 5 minutes
const RESTART_DELAY_MS = 2000    // delay before restarting (let port free up)

const children = new Map()  // label → { child, env, cwd, args, cmd, restartTimes: number[] }
let shuttingDown = false

// ─── PID Lock ────────────────────────────────────────────────────

function acquirePidLock() {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true })
  if (fs.existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10)
      // Check if old process is still alive
      try {
        process.kill(oldPid, 0) // signal 0 = check existence, doesn't kill
        console.error(`[prod] Another prod instance is running (PID: ${oldPid})`)
        console.error(`[prod] Kill it first: taskkill /PID ${oldPid} /F`)
        console.error(`[prod] Or delete lock: rm ${PID_FILE}`)
        process.exit(1)
      } catch {
        // Old process is dead, stale lock file — overwrite
        console.log(`[prod] Stale PID lock (PID ${oldPid} not running), taking over`)
      }
    } catch {
      // Malformed lock file — overwrite
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8")
}

function releasePidLock() {
  try { fs.unlinkSync(PID_FILE) } catch {}
}

// ─── Build ───────────────────────────────────────────────────────

function buildProject() {
  console.log("[prod] Building project...")
  try {
    execSync("pnpm build", { cwd: repoRoot, stdio: "inherit", timeout: 120000 })
    console.log("[prod] Build complete.")
  } catch {
    console.error("[prod] Build failed!")
    process.exit(1)
  }
}

// ─── Port helpers ────────────────────────────────────────────────

function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(true))
    server.once("listening", () => server.close(() => resolve(false)))
    server.listen(port)
  })
}

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
        // Don't kill our own process tree
        if (pid === process.pid) continue
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore", timeout: 5000 }) } catch {}
      }
      if (pids.size > 0) console.log(`[prod] Killed ${pids.size} stale process(es) on port ${port}`)
    } else {
      const output = execSync(`lsof -ti :${port}`, { encoding: "utf8", timeout: 5000 })
      const pids = output.trim().split("\n").map(Number).filter(n => !isNaN(n) && n > 0 && n !== process.pid)
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL") } catch {}
      }
      if (pids.length > 0) console.log(`[prod] Killed ${pids.length} stale process(es) on port ${port}`)
    }
  } catch {}
}

async function waitForPortFree(port, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

// ─── Process management with auto-restart ────────────────────────

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

  child.on("error", (err) => {
    console.error(`[prod] ${label} spawn error: ${err.message}`)
  })

  child.on("exit", (code, signal) => {
    const entry = children.get(label)
    if (shuttingDown) {
      console.log(`[${label}] exited during shutdown (code=${code}, signal=${signal})`)
      return
    }

    const reason = signal ? `signal ${signal}` : `code ${code}`
    console.log(`\n[prod] ⚠ ${label} exited unexpectedly (${reason}) at ${new Date().toISOString()}`)

    // Check restart budget
    const now = Date.now()
    const restartTimes = (entry?.restartTimes ?? []).filter(t => now - t < RESTART_WINDOW_MS)

    if (restartTimes.length >= MAX_RESTARTS) {
      console.error(`[prod] ✗ ${label} crashed ${restartTimes.length} times in ${RESTART_WINDOW_MS / 1000}s — giving up`)
      cleanup(code ?? 1)
      return
    }

    // Auto-restart with delay
    restartTimes.push(now)
    console.log(`[prod] ↻ Restarting ${label} in ${RESTART_DELAY_MS / 1000}s... (restart ${restartTimes.length}/${MAX_RESTARTS} in window)`)

    setTimeout(() => {
      if (shuttingDown) return

      // Kill stale process on the port before restarting
      killPort(SERVER_PORT)

      const newChild = startProcess(
        entry?.cmd ?? cmd,
        entry?.args ?? args,
        entry?.env ?? env,
        label,
        entry?.cwd ?? cwd,
      )
      // Update restart times on the new entry
      const newEntry = children.get(label)
      if (newEntry) newEntry.restartTimes = restartTimes

      waitForServer(SERVER_PORT).then((health) => {
        if (health) {
          console.log(`[prod] ✓ server recovered (PID: ${health.pid})`)
        } else {
          console.error(`[prod] ✗ server failed to recover within 15s`)
        }
      })
    }, RESTART_DELAY_MS)
  })

  children.set(label, { child, cmd, args, env, cwd, restartTimes: children.get(label)?.restartTimes ?? [] })
  return child
}

function cleanup(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log("\n[prod] Shutting down...")

  for (const [label, { child }] of children) {
    if (child.killed || child.exitCode !== null) continue
    if (process.platform === "win32") {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore", timeout: 5000 })
        console.log(`[${label}] killed (PID: ${child.pid})`)
      } catch {
        console.log(`[${label}] kill failed (PID: ${child.pid}, may already be dead)`)
      }
    } else {
      child.kill("SIGTERM")
      console.log(`[${label}] SIGTERM sent (PID: ${child.pid})`)
    }
  }

  releasePidLock()
  setTimeout(() => process.exit(exitCode), 1500)
}

process.on("SIGINT", () => cleanup(0))
process.on("SIGTERM", () => cleanup(0))
process.on("exit", () => releasePidLock())

// ─── Health check ────────────────────────────────────────────────

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/actuator/health`)
      if (res.ok) {
        const data = await res.json()
        const server = data.components?.server?.details ?? {}
        return { mode: server.mode, pid: server.pid, status: data.status }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const skipBuild = process.argv.includes("--skip-build")
  const killExisting = process.argv.includes("--kill") || process.argv.includes("-k")

  // --port <N> or --port <web>,<server> (legacy pair, UI follows <server>)
  const portIdx = process.argv.indexOf("--port")
  if (portIdx !== -1) {
    const portArg = process.argv[portIdx + 1]
    const pair = parsePortPair(portArg)
    const single = typeof portArg === "string" && /^\d+$/.test(portArg) ? Number(portArg) : null
    if (pair) {
      SERVER_PORT = pair.server
    } else if (single !== null && single >= 1 && single <= 65535) {
      SERVER_PORT = single
    } else {
      console.error(`[prod] --port expects "<N>" or "<web>,<server>" (e.g. --port 3000), got "${portArg ?? ""}"`)
      process.exit(1)
    }
  }

  const getLocalIP = () => {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address
      }
    }
    return 'localhost'
  }
  const localIP = getLocalIP()

  console.log("[prod] ═══════════════════════════════════════")
  console.log("[prod] Octopus Production Mode")
  console.log("[prod] ═══════════════════════════════════════")
  console.log(`[prod] UI + API:   http://localhost:${SERVER_PORT} (LAN: http://${localIP}:${SERVER_PORT})`)
  console.log(`[prod] DB:         ${DB_PATH}`)
  console.log(`[prod] PID:        ${process.pid}`)
  console.log(`[prod] Auto-restart: up to ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 1000}s`)
  console.log("")

  // Step 0: Acquire PID lock
  acquirePidLock()

  // Step 1: Build
  if (!skipBuild) {
    buildProject()
  } else {
    console.log("[prod] Skipping build (--skip-build)")
  }

  // Step 2: Verify build outputs in the repo
  const serverEntry = path.join(repoRoot, "packages", "server", "dist", "index.js")
  if (!fs.existsSync(serverEntry)) {
    console.error(`[prod] Server build not found at ${serverEntry} — run pnpm build first`)
    cleanup(1)
    return
  }
  const webDistPath = path.join(repoRoot, "packages", "web-app", "dist")
  if (!fs.existsSync(path.join(webDistPath, "index.html"))) {
    console.error(`[prod] Web build not found at ${webDistPath}/index.html — run pnpm build first`)
    cleanup(1)
    return
  }

  // Step 3: Ensure prod DB exists (copy from main DB if first time)
  const dbDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
  if (!fs.existsSync(DB_PATH)) {
    const mainDb = path.join(dbDir, "octopus.db")
    if (fs.existsSync(mainDb)) {
      fs.copyFileSync(mainDb, DB_PATH)
      console.log(`[prod] DB: copied octopus.db → octopus-prod.db`)
    } else {
      console.log(`[prod] DB: octopus-prod.db will be created fresh`)
    }
  } else {
    console.log(`[prod] DB: reusing octopus-prod.db`)
  }

  // Step 4: Free the port — dev uses the same one, so never kill it implicitly
  if (await isPortInUse(SERVER_PORT)) {
    if (killExisting) {
      killPort(SERVER_PORT)
      if (!(await waitForPortFree(SERVER_PORT))) {
        console.error(`[prod] Port ${SERVER_PORT} is still in use after kill`)
        cleanup(1)
        return
      }
    } else {
      console.error(`[prod] ✗ Port ${SERVER_PORT} is already in use (dev running?).`)
      console.error(`[prod]   Stop it first, or run \`pnpm prod -k\` to force-kill it.`)
      cleanup(1)
      return
    }
  }

  // Step 5: Start server from the repo — it hosts the Vite SPA too
  const serverEnv = {
    PORT: String(SERVER_PORT),
    OCTOPUS_DB_PATH: DB_PATH,
    OCTOPUS_BRANCH: "prod",
    OCTOPUS_WEB_DIR: webDistPath,
  }

  console.log("\n[prod] Starting server (UI + API)...")
  startProcess(
    process.execPath,
    [serverEntry],
    serverEnv,
    "server",
    repoRoot
  )

  // Step 6: Wait for server health
  const health = await waitForServer(SERVER_PORT)
  if (!health) {
    console.error("[prod] Server failed to start within 15s")
    cleanup(1)
    return
  }

  console.log(`\n[prod] ✓ UI/API: http://${localIP}:${SERVER_PORT} (PID: ${health.pid})`)
  console.log(`[prod] ✓ db:     ${DB_PATH}`)
  console.log(`\n[prod] Running from ${path.join(repoRoot, "packages")} — no stable copy, nothing written to ~/.octopus/prod.`)
  console.log(`[prod] If server crashes, it will auto-restart (up to ${MAX_RESTARTS} times).`)
  console.log(`[prod] To update: Ctrl+C → pnpm prod`)
  console.log(`[prod] Ready. Press Ctrl+C to stop.\n`)
}

main().catch((err) => {
  console.error(`[prod] Fatal: ${err.message}`)
  cleanup(1)
})
