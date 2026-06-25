#!/usr/bin/env node
/**
 * Port allocation tool for multi-instance isolation.
 *
 * Usage:
 *   node scripts/branch-port.mjs            # human-readable output
 *   node scripts/branch-port.mjs --json     # JSON output for scripts
 *
 * Output:
 *   { mode, branch?, server, web, allocatedAt? }
 *
 * Algorithm:
 *   - Main repo (.git is directory) → server=3001, web=3000
 *   - Worktree (.git is file) → hash(branch) → even offset in 3100-3598
 *   - Persistence: ~/.octopus/ports/{branch-safe}.json
 */

import crypto from "crypto"
import fs from "fs"
import path from "path"
import os from "os"
import net from "net"

const repoRoot = process.cwd()
const PORTS_DIR = path.join(os.homedir(), ".octopus", "ports")
const PORT_RANGE_START = 3100
const PORT_PAIRS = 250  // 250 pairs → 3100-3598 (server even, web odd)

function isWorktree() {
  try {
    return fs.statSync(path.join(repoRoot, ".git")).isFile()
  } catch {
    return false
  }
}

function getBranchName() {
  try {
    const gitContent = fs.readFileSync(path.join(repoRoot, ".git"), "utf8").trim()
    const match = gitContent.match(/ref: refs\/heads\/(.+)/)
    if (match) return match[1]
  } catch {}
  return path.basename(repoRoot)
}

function safeName(branch) {
  return branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
}

function hashPortOffset(branch) {
  const hash = crypto.createHash("sha1").update(branch).digest()
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
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function writePortFile(safe, data) {
  fs.mkdirSync(PORTS_DIR, { recursive: true })
  fs.writeFileSync(path.join(PORTS_DIR, `${safe}.json`), JSON.stringify(data, null, 2))
}

function output(result) {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`mode:   ${result.mode}`)
    if (result.branch) console.log(`branch: ${result.branch}`)
    console.log(`server: ${result.server}`)
    console.log(`web:    ${result.web}`)
    if (result.dbPath) console.log(`db:     ${result.dbPath}`)
  }
}

async function main() {
  if (!isWorktree()) {
    output({
      mode: "default",
      server: 3001,
      web: 3000,
      dbPath: path.join(os.homedir(), ".octopus", "db", "octopus.db"),
    })
    return
  }

  const branch = getBranchName()
  const safe = safeName(branch)

  // 1. Check persisted port file
  const persisted = readPortFile(safe)
  if (persisted) {
    const serverBusy = await isPortInUse(persisted.server)
    const webBusy = await isPortInUse(persisted.web)
    if (!serverBusy && !webBusy) {
      output({
        mode: "isolated",
        branch,
        server: persisted.server,
        web: persisted.web,
        dbPath: path.join(os.homedir(), ".octopus", "db", `octopus-${safe}.db`),
      })
      return
    }
  }

  // 2. Hash + scan for free port pair
  const baseOffset = hashPortOffset(branch)
  for (let i = 0; i < PORT_PAIRS; i++) {
    const offset = (baseOffset + i) % PORT_PAIRS
    const server = PORT_RANGE_START + offset * 2
    const web = server + 1

    const serverBusy = await isPortInUse(server)
    if (serverBusy) continue
    const webBusy = await isPortInUse(web)
    if (webBusy) continue

    const result = {
      branch,
      server,
      web,
      allocatedAt: new Date().toISOString(),
    }
    writePortFile(safe, result)

    output({
      mode: "isolated",
      branch,
      server,
      web,
      dbPath: path.join(os.homedir(), ".octopus", "db", `octopus-${safe}.db`),
    })
    return
  }

  console.error("Error: No available port pairs in range 3100-3599")
  process.exit(1)
}

main()
