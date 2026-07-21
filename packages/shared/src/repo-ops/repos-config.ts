import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import { loadOrgConfig, resolveOrgDir } from "../config/loader"

export interface ReposConfig {
  cloneBase: string
  groups: string[]
  manifestPath: string
  outputPath: string
}

export function resolveReposConfig(
  org: string,
  options?: {
    groupsOverride?: string
    cloneBaseOverride?: string
    manifestOverride?: string
    outputOverride?: string
  }
): ReposConfig {
  const orgConfig = loadOrgConfig(org)
  const orgDir = resolveOrgDir(org)

  const groupsOverride = options?.groupsOverride ?? ""
  const cloneBaseOverride = options?.cloneBaseOverride ?? ""
  const manifestOverride = options?.manifestOverride ?? ""
  const outputOverride = options?.outputOverride ?? ""

  const groups = groupsOverride
    ? groupsOverride.split(",").map((g) => g.trim()).filter(Boolean)
    : orgConfig.groups

  const cloneBase = cloneBaseOverride
    ? cloneBaseOverride.replace(/^~/, homedir())
    : (orgConfig.clone_base ?? join(orgDir, "repos", "projects"))

  // Prefer manifest.json, fall back to manifest.md for backward compatibility
  let manifestPath: string
  if (manifestOverride) {
    manifestPath = manifestOverride
  } else {
    const jsonPath = join(orgDir, "repos", "manifest.json")
    const mdPath = join(orgDir, "repos", "manifest.md")
    manifestPath = existsSync(jsonPath) ? jsonPath : mdPath
  }

  // Output to index.json by default
  const outputPath = outputOverride || join(orgDir, "repos", "index.json")

  return {
    cloneBase,
    groups,
    manifestPath,
    outputPath,
  }
}