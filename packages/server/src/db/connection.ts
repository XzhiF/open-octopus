import Database from "better-sqlite3"
import path from "path"
import fs from "fs"
import os from "os"
import { applySchema } from "./schema"

let db: Database.Database | null = null

export function getDbPath(dbPath?: string): string {
  if (dbPath) return dbPath
  if (process.env.OCTOPUS_DB_PATH) return process.env.OCTOPUS_DB_PATH
  const home = os.homedir()
  const dir = path.join(home, ".octopus", "db")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "octopus.db")
}

/**
 * Resolve the legacy agent_memory.db path for cleanup.
 */
function getLegacyAgentDbPath(): string {
  const home = os.homedir()
  return path.join(home, ".octopus", "agent", "memory", "agent_memory.db")
}

/**
 * Log stats from the legacy agent DB before deleting it.
 */
function cleanupLegacyAgentDb(): void {
  const agentDbPath = getLegacyAgentDbPath()
  if (!fs.existsSync(agentDbPath)) return

  try {
    const legacyDb = new Database(agentDbPath)
    const sessionCount = (legacyDb.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c
    const messageCount = (legacyDb.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c
    // eslint-disable-next-line no-console
    console.log(
      `[db] Legacy agent_memory.db found — sessions: ${sessionCount}, messages: ${messageCount}. Migrating to unified DB (deleting legacy file).`
    )
    legacyDb.close()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(`[db] Could not read legacy agent DB stats: ${msg}`)
  }

  try {
    fs.unlinkSync(agentDbPath)
    // Also remove WAL/SHM sidecar files if they exist
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = agentDbPath + suffix
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar)
    }
    // eslint-disable-next-line no-console
    console.log("[db] Legacy agent_memory.db deleted successfully.")
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(`[db] Could not delete legacy agent_memory.db: ${msg}`)
  }
}

export function initDb(dbPath?: string): Database.Database {
  const resolved = getDbPath(dbPath)
  db = new Database(resolved)
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")
  db.pragma("foreign_keys = ON")
  applySchema(db)

  // Integrity check (lightweight — quick_verify mode)
  try {
    const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    if (result.integrity_check !== "ok") {
      // eslint-disable-next-line no-console
      console.warn(`[db] Integrity check result: ${result.integrity_check}`)
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // eslint-disable-next-line no-console
    console.warn(`[db] Integrity check failed: ${msg}`)
  }

  // Clean up legacy agent_memory.db if it exists alongside the main DB
  cleanupLegacyAgentDb()

  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDb() first.")
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
