import { join } from "path"
import { homedir } from "os"
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

  const manifestPath = manifestOverride || join(orgDir, "repos", "manifest.md")
  const outputPath = outputOverride || join(orgDir, "repos", "index.md")

  return {
    cloneBase,
    groups,
    manifestPath,
    outputPath,
  }
}