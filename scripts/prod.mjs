#!/usr/bin/env node
/**
 * Production startup script — runs Octopus from a stable build copy.
 *
 * Usage:
 *   pnpm prod                    # build → copy to stable dir → run
 *   pnpm prod --skip-build       # skip build, use existing stable copy
 *
 * Port allocation (fully isolated from dev):
 *   dev (main):     Server 3001, Web 3000, DB octopus.db
 *   dev (worktree): Server 3100-3598 (hash), Web +1, DB octopus-{branch}.db
 *   prod:           Server 3099, Web 3098, DB octopus-prod.db
 *
 * Resilience:
 *   - Server/web auto-restart on unexpected exit (up to MAX_RESTARTS in window)
 *   - PID lock file prevents multiple prod.mjs instances
 *   - Detailed exit logging (code, signal) for debugging crashes
 *
 * How it works:
 *   1. pnpm build (compile all packages)
 *   2. Copy dist/ outputs to ~/.octopus/prod/{package}/dist/
 *   3. Start server from stable copy with OCTOPUS_DB_PATH=octopus-prod.db
 *   4. Start web-app pointing to prod server
 *   Source code changes won't affect the running instance.
 */

import { spawn, execSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

const repoRoot = process.cwd()
const PROD_DIR = path.join(os.homedir(), ".octopus", "prod")

// prod 独占端口，完全独立于 dev (3001/3000) 和 worktree (3100-3598)
const SERVER_PORT = 3099
const WEB_PORT = 3098
const DB_PATH = path.join(os.homedir(), ".octopus", "db", "octopus-prod.db")

// PID lock file — prevents multiple prod.mjs instances
const PID_FILE = path.join(PROD_DIR, "prod.pid")

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

// ─── Copy to stable directory ────────────────────────────────────

function copyDist() {
  console.log("[prod] Copying to stable directory...")

  const packages = ["shared", "providers", "engine", "server", "cli", "web-app", "core-pack"]

  for (const pkg of packages) {
    const srcDist = path.join(repoRoot, "packages", pkg, "dist")
    const destDist = path.join(PROD_DIR, "packages", pkg, "dist")

    if (!fs.existsSync(srcDist)) {
      console.log(`[prod]   skip ${pkg} (no dist/)`)
      continue
    }

    fs.rmSync(destDist, { recursive: true, force: true })
    fs.mkdirSync(destDist, { recursive: true })
    copyDirSync(srcDist, destDist)
    console.log(`[prod]   copied ${pkg}/dist/`)
  }

  // Symlink root node_modules
  const srcNodeModules = path.join(repoRoot, "node_modules")
  const destNodeModules = path.join(PROD_DIR, "node_modules")
  if (fs.existsSync(srcNodeModules)) {
    fs.rmSync(destNodeModules, { recursive: true, force: true })
    fs.symlinkSync(srcNodeModules, destNodeModules, "junction")
    console.log("[prod]   linked node_modules/")
  }

  // Symlink each package's node_modules (pnpm puts deps here, not just root)
  for (const pkg of packages) {
    const srcNm = path.join(repoRoot, "packages", pkg, "node_modules")
    const destNm = path.join(PROD_DIR, "packages", pkg, "node_modules")
    if (fs.existsSync(srcNm)) {
      fs.rmSync(destNm, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(destNm), { recursive: true })
      fs.symlinkSync(srcNm, destNm, "junction")
      console.log(`[prod]   linked packages/${pkg}/node_modules/`)
    }
  }

  // Copy package.json files (needed for module resolution)
  fs.copyFileSync(
    path.join(repoRoot, "package.json"),
    path.join(PROD_DIR, "package.json")
  )
  for (const pkg of packages) {
    const srcPkg = path.join(repoRoot, "packages", pkg, "package.json")
    const destPkg = path.join(PROD_DIR, "packages", pkg, "package.json")
    if (fs.existsSync(srcPkg)) {
      fs.mkdirSync(path.dirname(destPkg), { recursive: true })
      fs.copyFileSync(srcPkg, destPkg)
    }
  }

  // Copy core-pack data directories
  const corePackSrc = path.join(repoRoot, "packages", "core-pack")
  const corePackDest = path.join(PROD_DIR, "packages", "core-pack")
  for (const dir of ["skills", "agents", "presets", "config", "templates"]) {
    const src = path.join(corePackSrc, dir)
    const dest = path.join(corePackDest, dir)
    if (fs.existsSync(src)) {
      fs.rmSync(dest, { recursive: true, force: true })
      copyDirSync(src, dest)
      console.log(`[prod]   copied core-pack/${dir}/`)
    }
  }

  // Copy web-app .next build output (for `next start`, skip dev cache)
  const webAppNextSrc = path.join(repoRoot, "packages", "web-app", ".next")
  const webAppNextDest = path.join(PROD_DIR, "packages", "web-app", ".next")
  if (fs.existsSync(webAppNextSrc)) {
    fs.rmSync(webAppNextDest, { recursive: true, force: true })
    fs.mkdirSync(webAppNextDest, { recursive: true })
    // Only copy production files (skip dev cache, trace, lock files, node_modules)
    const skipDirs = new Set(["dev", "trace", "cache", "node_modules"])
    const entries = fs.readdirSync(webAppNextSrc, { withFileTypes: true })
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue
      const src = path.join(webAppNextSrc, entry.name)
      const dest = path.join(webAppNextDest, entry.name)
      if (entry.isDirectory()) {
        copyDirSync(src, dest)
      } else {
        fs.copyFileSync(src, dest)
      }
    }
    console.log(`[prod]   copied web-app/.next/ (production build)`)
  }

  console.log(`[prod] Stable copy ready at ${PROD_DIR}`)
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ─── Kill stale processes ────────────────────────────────────────

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
      if (label === "server") killPort(SERVER_PORT)
      if (label === "web") killPort(WEB_PORT)

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

      if (label === "server") {
        waitForServer(SERVER_PORT).then((health) => {
          if (health) {
            console.log(`[prod] ✓ server recovered (PID: ${health.pid})`)
          } else {
            console.error(`[prod] ✗ server failed to recover within 15s`)
          }
        })
      }
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

  console.log("[prod] ═══════════════════════════════════════")
  console.log("[prod] Octopus Production Mode")
  console.log("[prod] ═══════════════════════════════════════")
  console.log(`[prod] Stable dir: ${PROD_DIR}`)
  console.log(`[prod] Server:     http://localhost:${SERVER_PORT}`)
  console.log(`[prod] Web:        http://localhost:${WEB_PORT}`)
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

  // Step 2: Copy to stable directory
  copyDist()

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

  // Step 4: Kill stale processes on prod ports only
  killPort(SERVER_PORT)
  killPort(WEB_PORT)

  // Step 5: Start server from stable copy
  const serverDistPath = path.join(PROD_DIR, "packages", "server", "dist", "index.js")
  if (!fs.existsSync(serverDistPath)) {
    console.error(`[prod] Server not found at ${serverDistPath}`)
    process.exit(1)
  }

  const serverEnv = {
    PORT: String(SERVER_PORT),
    OCTOPUS_DB_PATH: DB_PATH,
    OCTOPUS_BRANCH: "prod",
  }

  console.log("\n[prod] Starting server from stable copy...")
  startProcess(
    process.execPath,
    [serverDistPath],
    serverEnv,
    "server",
    PROD_DIR
  )

  // Step 6: Wait for server health
  const health = await waitForServer(SERVER_PORT)
  if (!health) {
    console.error("[prod] Server failed to start within 15s")
    cleanup(1)
    return
  }

  // Step 7: Start web-app with `next start` (production mode, no dev lock conflict)
  console.log("[prod] Starting web-app (production mode)...")
  const prodWebAppDir = path.join(PROD_DIR, "packages", "web-app")
  const nextBin = path.join(prodWebAppDir, "node_modules", "next", "dist", "bin", "next")
  const webEnv = {
    SERVER_URL: `http://localhost:${SERVER_PORT}`,
  }
  startProcess(
    process.execPath,
    [nextBin, "start", "-p", String(WEB_PORT)],
    webEnv,
    "web",
    prodWebAppDir
  )

  console.log(`\n[prod] ✓ server: http://localhost:${SERVER_PORT} (PID: ${health.pid})`)
  console.log(`[prod] ✓ web:    http://localhost:${WEB_PORT}`)
  console.log(`[prod] ✓ db:     ${DB_PATH}`)
  console.log(`\n[prod] Source code changes will NOT affect the running server.`)
  console.log(`[prod] If server crashes, it will auto-restart (up to ${MAX_RESTARTS} times).`)
  console.log(`[prod] To update: Ctrl+C → pnpm prod`)
  console.log(`[prod] Ready. Press Ctrl+C to stop.\n`)
}

main().catch((err) => {
  console.error(`[prod] Fatal: ${err.message}`)
  cleanup(1)
})
