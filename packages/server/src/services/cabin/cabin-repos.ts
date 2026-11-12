// packages/server/src/services/cabin/cabin-repos.ts
//
// Cabin repo helpers shared by CabinInitService (gate 3/4) and CabinService
// (repos endpoint / wake). The org registry contract is the existing one:
// ~/.octopus/orgs/<org>/repos/manifest.json + projects/<group>/<name> clones.
// config.json.repos[] stays the single cabin-side repo contract (decision #3).

import fs from "fs"
import path from "path"
import os from "os"
import {
  parseManifest, parseManifestJson, findLocalRepo, cloneProject,
  type ManifestEntry,
} from "@octopus/shared"

export function getOctopusHome(): string {
  return process.env.OCTOPUS_HOME ?? path.join(os.homedir(), ".octopus")
}

export function getCloneBase(org: string): string {
  return path.join(getOctopusHome(), "orgs", org, "repos", "projects")
}

export function readOrgManifest(org: string): Record<string, ManifestEntry[]> {
  const reposDir = path.join(getOctopusHome(), "orgs", org, "repos")
  const jsonPath = path.join(reposDir, "manifest.json")
  const mdPath = path.join(reposDir, "manifest.md")
  if (fs.existsSync(jsonPath)) return parseManifestJson(fs.readFileSync(jsonPath, "utf-8"))
  if (fs.existsSync(mdPath)) return parseManifest(fs.readFileSync(mdPath, "utf-8"))
  return {}
}

export function findOrgEntry(
  groups: Record<string, ManifestEntry[]>, name: string,
): { entry: ManifestEntry; group: string } | null {
  for (const [group, entries] of Object.entries(groups)) {
    const found = entries.find((e) => e.name === name)
    if (found) return { entry: found, group }
  }
  return null
}

/** config.json.repos[] entry — pre-clone placeholders carry only name/group;
 *  post-init entries carry the full spec shape (main_path/worktree_path/branch)
 *  that resolveRepoDir / resolveWorktree / ensureWorktreesForReuse read. */
export interface CabinRepoEntry {
  name: string
  group?: string
  repoName?: string
  main_path?: string
  worktree_path?: string
  branch?: string
}

export function readCabinConfig(cabinPath: string): { name: string; repos: CabinRepoEntry[] } {
  const configPath = path.join(cabinPath, "config.json")
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { name?: string; repos?: unknown }
    return {
      name: typeof raw.name === "string" ? raw.name : path.basename(cabinPath),
      repos: Array.isArray(raw.repos) ? (raw.repos as CabinRepoEntry[]) : [],
    }
  } catch {
    return { name: path.basename(cabinPath), repos: [] }
  }
}

/** Merge repo entries into config.json (preserves other keys). Atomic write. */
export function writeCabinConfigRepos(cabinPath: string, repos: CabinRepoEntry[]): void {
  const configPath = path.join(cabinPath, "config.json")
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
  } catch {
    config = { name: path.basename(cabinPath), created: new Date().toISOString() }
  }
  config.repos = repos
  const tmp = `${configPath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8")
  fs.renameSync(tmp, configPath)
}

/** Idempotent: already-cloned repos return their local path; otherwise clone
 *  from the org manifest. Never throws — failures come back as {error}. */
export function ensureRepoCloned(org: string, name: string): { localPath: string } | { error: string } {
  const groups = readOrgManifest(org)
  const found = findOrgEntry(groups, name)
  if (!found) return { error: `repo '${name}' not found in org '${org}' manifest` }
  const cloneBase = getCloneBase(org)
  const existing = findLocalRepo(found.group, name, cloneBase)
  if (existing) return { localPath: existing }
  if (!found.entry.git_url) return { error: `repo '${name}' has no git_url` }
  const result = cloneProject(found.entry.git_url, found.group, name, found.entry.branch, cloneBase)
  if (!result.success) return { error: result.message }
  const localPath = findLocalRepo(found.group, name, cloneBase)
  if (!localPath) return { error: `clone reported success but local path missing for '${name}'` }
  return { localPath }
}