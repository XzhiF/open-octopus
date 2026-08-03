/**
 * E2E Harness — api.mjs
 * Unified HTTP client + port resolution for Octopus E2E tests.
 *
 * @module api
 * @status STABLE
 *
 * Port resolution priority:
 *   1. OCTOPUS_API_URL / OCTOPUS_WEB_URL env vars
 *   2. ~/.octopus/ports/{branch-safe}.json (written by dev.mjs)
 *   3. Main repo defaults: server=3001, web=3000
 */

import { createHash } from "node:crypto"
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ─── Branch & Port Resolution ─────────────────────────────────────

const PORTS_DIR = path.join(os.homedir(), ".octopus", "ports")
const DEFAULT_SERVER = 3001
const DEFAULT_WEB = 3000
const WORKTREE_PORT_BASE = 3100
const WORKTREE_PORT_STRIDE = 2
const WORKTREE_PORT_RANGE = 250

function getRepoRoot() {
  try {
    // import.meta.dirname is Node 22+; fall back to fileURLToPath
    const dir = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname)
    // Walk up from .claude/skills/e2e-harness/lib/ to repo root (4 levels up)
    return path.resolve(dir, "..", "..", "..", "..")
  } catch {
    return process.cwd()
  }
}

function getBranchName() {
  const repoRoot = getRepoRoot()
  const gitDir = path.join(repoRoot, ".git")
  try {
    const stat = fs.statSync(gitDir)
    if (stat.isFile()) {
      // Worktree: .git is a file pointing to actual gitdir
      const content = fs.readFileSync(gitDir, "utf8").trim()
      const gitdirMatch = content.match(/^gitdir:\s*(.+)$/)
      if (gitdirMatch) {
        const headPath = path.join(gitdirMatch[1], "HEAD")
        const headContent = fs.readFileSync(headPath, "utf8").trim()
        const refMatch = headContent.match(/ref: refs\/heads\/(.+)/)
        if (refMatch) return refMatch[1]
      }
    } else if (stat.isDirectory()) {
      // Main repo
      const headPath = path.join(gitDir, "HEAD")
      const headContent = fs.readFileSync(headPath, "utf8").trim()
      const refMatch = headContent.match(/ref: refs\/heads\/(.+)/)
      if (refMatch) return refMatch[1]
    }
  } catch {
    // Fallback: try git command (sync)
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8", timeout: 3000 }).trim()
    } catch { /* ignore */ }
  }
  return "main"
}

export function safeName(branch) {
  return branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
}

function isWorktree() {
  const repoRoot = getRepoRoot()
  const gitDir = path.join(repoRoot, ".git")
  try {
    return fs.statSync(gitDir).isFile()
  } catch {
    return false
  }
}

function readPortFile(branch) {
  const safe = safeName(branch)
  const file = path.join(PORTS_DIR, `${safe}.json`)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function hashPortOffset(branch) {
  const hash = createHash("sha1").update(branch).digest()
  return hash.readUInt16BE(0) % WORKTREE_PORT_RANGE
}

/**
 * Resolve the server API port for the current environment.
 * @returns {{ server: number, web: number }}
 */
export function resolvePorts() {
  // 1. Env var override
  const envApi = process.env.OCTOPUS_API_URL
  const envWeb = process.env.OCTOPUS_WEB_URL
  if (envApi && envWeb) {
    const apiUrl = new URL(envApi)
    const webUrl = new URL(envWeb)
    const serverPort = apiUrl.port ? parseInt(apiUrl.port, 10) : DEFAULT_SERVER
    const webPort = webUrl.port ? parseInt(webUrl.port, 10) : DEFAULT_WEB
    return { server: serverPort, web: webPort }
  }

  // 2. Main repo defaults
  if (!isWorktree()) {
    return { server: DEFAULT_SERVER, web: DEFAULT_WEB }
  }

  // 3. Port file from dev.mjs
  const branch = getBranchName()
  const portData = readPortFile(branch)
  if (portData && typeof portData.server === "number") {
    return { server: portData.server, web: portData.web }
  }

  // 4. Hash-based fallback
  const offset = hashPortOffset(branch)
  const server = WORKTREE_PORT_BASE + offset * WORKTREE_PORT_STRIDE
  const web = server + 1
  return { server, web }
}

/**
 * Resolve the API base URL.
 * @returns {string} e.g. "http://localhost:3001"
 */
export function resolveApiUrl() {
  if (process.env.OCTOPUS_API_URL) return process.env.OCTOPUS_API_URL
  const { server } = resolvePorts()
  return `http://localhost:${server}`
}

/**
 * Resolve the web app base URL.
 * @returns {string} e.g. "http://localhost:3000"
 */
export function resolveWebUrl() {
  if (process.env.OCTOPUS_WEB_URL) return process.env.OCTOPUS_WEB_URL
  const { web } = resolvePorts()
  return `http://localhost:${web}`
}

// ─── HTTP Client ──────────────────────────────────────────────────

/**
 * Make a JSON HTTP request to the Octopus API.
 *
 * @param {string} urlOrPath - Full URL or path (e.g. "/api/health"). Paths are prefixed with API base URL.
 * @param {RequestInit} [options] - fetch options
 * @returns {Promise<{ ok: boolean, status: number, data: any, text: string }>}
 */
export async function fetchJSON(urlOrPath, options = {}) {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${resolveApiUrl()}${urlOrPath}`

  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  }

  const resp = await fetch(url, { ...options, headers })
  let data = null
  let text = ""

  try {
    text = await resp.text()
    data = text ? JSON.parse(text) : null
  } catch {
    // Response wasn't JSON — text is already captured
  }

  return {
    ok: resp.ok,
    status: resp.status,
    data,
    text,
  }
}

/**
 * Check if the Octopus server is healthy.
 *
 * @param {string} [apiUrl] - Override API base URL
 * @returns {Promise<boolean>}
 */
export async function healthCheck(apiUrl) {
  const base = apiUrl || resolveApiUrl()
  try {
    // Try actuator health endpoint first (production path), fall back to /api/health
    let result = await fetchJSON(`${base}/api/actuator/health`)
    if (result.ok) return true
    result = await fetchJSON(`${base}/api/health`)
    return result.ok
  } catch {
    return false
  }
}
