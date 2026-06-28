import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { load as parseYaml } from "js-yaml"
import { OrgDAO } from "../db/dao"
import type { OrgRow } from "../db/types"

/** Reserved global directories that are NOT org dirs */
const GLOBAL_DIRS = new Set([
  'agent', 'orgs', 'db', 'logs', 'debug', 'ports', 'prod',
  'workflows', 'hermes-notify', 'bug-patterns', 'bug-report',
  'regression-baseline', 'worktrees',
])

/**
 * Migrate org directories from ~/.octopus/{org}/ to ~/.octopus/orgs/{org}/
 * Idempotent — skips if already migrated.
 */
export function migrateOrgDirs(): number {
  const base = path.join(os.homedir(), '.octopus')
  const orgsBase = path.join(base, 'orgs')

  // Create orgs dir if missing
  if (!fs.existsSync(orgsBase)) {
    fs.mkdirSync(orgsBase, { recursive: true })
  }

  let migrated = 0
  const entries = fs.readdirSync(base, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (GLOBAL_DIRS.has(entry.name)) continue

    const oldDir = path.join(base, entry.name)
    const configPath = path.join(oldDir, 'config.yaml')

    // Only migrate directories with a config.yaml (i.e., actual org dirs)
    if (!fs.existsSync(configPath)) continue

    const newDir = path.join(orgsBase, entry.name)

    // Already migrated
    if (fs.existsSync(newDir)) continue

    try {
      fs.renameSync(oldDir, newDir)
      migrated++
      console.log(`[orgs] Migrated ${entry.name} → orgs/${entry.name}`)
    } catch {
      // renameSync may fail across drives — fallback to copy + remove
      try {
        fs.cpSync(oldDir, newDir, { recursive: true })
        fs.rmSync(oldDir, { recursive: true, force: true })
        migrated++
        console.log(`[orgs] Migrated (copy) ${entry.name} → orgs/${entry.name}`)
      } catch (err: any) {
        console.warn(`[orgs] Failed to migrate ${entry.name}: ${err.message}`)
      }
    }
  }

  return migrated
}

export function syncOrgsFromFilesystem(dao: OrgDAO, baseDir?: string): number {
  return syncOrgsFromFilesystemWithDao(dao, baseDir)
}

export function syncOrgsFromFilesystemWithDao(dao: OrgDAO, baseDir?: string): number {
  const homeDir = baseDir ?? path.join(os.homedir(), ".octopus", "orgs")
  if (!fs.existsSync(homeDir)) return 0

  let inserted = 0
  const now = new Date().toISOString()

  const entries = fs.readdirSync(homeDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirPath = path.join(homeDir, entry.name)
    const configPath = path.join(dirPath, "config.yaml")
    if (!fs.existsSync(configPath)) continue

    try {
      const content = fs.readFileSync(configPath, "utf-8")
      const parsed = parseYaml(content)

      if (!parsed || typeof parsed !== "object" || !(parsed as any).name || typeof (parsed as any).name !== "string" || (parsed as any).name.trim() === "") {
        console.warn(`[orgs] Skipping ${entry.name}: config.yaml has no valid 'name' field`)
        continue
      }
    } catch (err: any) {
      console.warn(`[orgs] Skipping ${entry.name}: failed to parse config.yaml — ${err.message}`)
      continue
    }

    const orgPath = `~/.octopus/orgs/${entry.name}`
    // ponytail: INSERT OR IGNORE — changes==0 when org already exists, making sync truly idempotent
    const result = dao.insert({ name: entry.name, path: orgPath, created_at: now })
    if (result.changes > 0) inserted++
  }

  return inserted
}

export function listOrgs(dao: OrgDAO): OrgRow[] {
  return dao.findAll()
}

export function orgExists(dao: OrgDAO, name: string): boolean {
  return dao.exists(name)
}
