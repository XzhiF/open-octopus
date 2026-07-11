import { join } from "path"
import { existsSync } from "fs"
import { resolveGlobalDir, resolveOrgDir, getDefaultOrg, loadProjectConfig } from "@octopus/shared"

export { resolveGlobalDir, resolveOrgDir }

export function resolveCurrentOrg(workDir?: string): string {
  if (process.env.OCTOPUS_ORG) return process.env.OCTOPUS_ORG

  const cwd = workDir ?? process.cwd()
  const wsConfigPath = join(cwd, ".octopus", "config.yaml")
  if (existsSync(wsConfigPath)) {
    const projCfg = loadProjectConfig(cwd)
    if (projCfg.org) return projCfg.org
  }

  return getDefaultOrg()
}

export function resolveProjectDir(): string {
  return process.cwd()
}

export function resolveSkillDir(org: string, skillName: string): string {
  return join(resolveOrgDir(org), "skills", skillName)
}

export function resolveEnvDir(org: string): string {
  return join(resolveOrgDir(org), "env")
}

export function resolveMcpDir(org: string): string {
  return join(resolveOrgDir(org), "mcp")
}

export function resolveReposDir(org: string): string {
  return join(resolveOrgDir(org), "repos")
}

export function resolveEvolutionDir(org: string): string {
  return join(resolveOrgDir(org), "evolution")
}

export function resolveBuiltinWorkflowsDir(): string {
  return join(resolveGlobalDir(), "resources", "installed", "workflows")
}