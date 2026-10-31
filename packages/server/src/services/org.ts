import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { load as parseYaml } from "js-yaml"
import { OrgDAO } from "../db/dao"
import type { OrgRow } from "../db/types"

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
