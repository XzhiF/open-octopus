import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { GlobalConfigSchema, OrgConfigSchema } from "../types/config"
import type { GlobalConfig, OrgConfig, ProjectConfig } from "../types/config"

export function resolveGlobalDir(): string {
  const envHome = process.env.OCTOPUS_HOME
  if (envHome) return envHome
  return join(homedir(), ".octopus")
}

export function resolveOrgDir(org: string): string {
  if (!org) throw new Error("org must not be empty")
  return join(resolveGlobalDir(), 'orgs', org)
}

function isContentLine(stripped: string): boolean {
  return Boolean(stripped) && !stripped.startsWith("#") && !stripped.startsWith(">")
}

function splitKeyValue(stripped: string): { key: string; value: string } | null {
  if (!stripped.includes(":")) return null
  const colonIdx = stripped.indexOf(":")
  return {
    key: stripped.slice(0, colonIdx).trim(),
    value: stripped.slice(colonIdx + 1).trim(),
  }
}

function scanListContinuation(remainingLines: string[]): { items: string[]; consumed: number } {
  const items: string[] = []
  for (const rl of remainingLines) {
    const ns = rl.trim()
    if (ns.startsWith("- ")) {
      items.push(ns.slice(2).trim())
    } else {
      break
    }
  }
  return { items, consumed: items.length }
}

function parseSimpleKeyValue(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const stripped = line.trim()
    if (!isContentLine(stripped)) continue
    const kv = splitKeyValue(stripped)
    if (!kv) continue
    result[kv.key] = kv.value
  }
  return result
}

const DEFAULT_GLOBAL_CONFIG: GlobalConfig = { default_org: "" }

export function loadGlobalConfig(configPath?: string): GlobalConfig {
  const path = configPath ?? join(resolveGlobalDir(), "config.yaml")
  if (!existsSync(path)) return DEFAULT_GLOBAL_CONFIG
  try {
    const content = readFileSync(path, "utf-8")
    const parsed = parseSimpleKeyValue(content)
    const cfg: GlobalConfig = { default_org: parsed.default_org ?? "" }
    const validated = GlobalConfigSchema.safeParse(cfg)
    return validated.success ? validated.data : DEFAULT_GLOBAL_CONFIG
  } catch {
    return DEFAULT_GLOBAL_CONFIG
  }
}

function parseGroupsValue(value: string, remainingLines: string[]): { groups: string[]; consumed: number } {
  if (value.startsWith("-")) {
    const firstItem = value.replace(/^-\s*/, "").trim()
    const { items, consumed } = scanListContinuation(remainingLines)
    return { groups: [firstItem, ...items], consumed }
  }
  if (value.includes(",")) {
    return { groups: value.split(",").map((g) => g.trim()).filter((g) => g), consumed: 0 }
  }
  if (value === "") {
    const { items, consumed } = scanListContinuation(remainingLines)
    return { groups: items, consumed }
  }
  return { groups: [value], consumed: 0 }
}

function makeDefaultOrgConfig(org: string): OrgConfig {
  return {
    name: org,
    prefix: "",
    description: "",
    platform: "gitlab",
    groups: [],
    clone_base: join(resolveOrgDir(org), "repos", "projects"),
  }
}

export function loadOrgConfig(org: string, configPath?: string): OrgConfig {
  const path = configPath ?? join(resolveOrgDir(org), "config.yaml")
  const defaults = makeDefaultOrgConfig(org)
  if (!existsSync(path)) return defaults
  try {
    const content = readFileSync(path, "utf-8")
    const lines = content.split("\n")
    const cfg = { ...defaults }
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim()
      if (!isContentLine(stripped)) continue
      const kv = splitKeyValue(stripped)
      if (!kv) continue
      const { key, value } = kv
      const remainingLines = lines.slice(i + 1)
      if (key === "name") cfg.name = value
      else if (key === "prefix") cfg.prefix = value
      else if (key === "description") cfg.description = value
      else if (key === "platform") cfg.platform = value
      else if (key === "clone_base") {
        cfg.clone_base = value.replace(/^~/, homedir())
      }
      else if (key === "groups") {
        const result = parseGroupsValue(value, remainingLines)
        cfg.groups = result.groups
        i += result.consumed
      }
    }
    const validated = OrgConfigSchema.safeParse(cfg)
    return validated.success ? validated.data : defaults
  } catch {
    return defaults
  }
}

export function loadProjectConfig(projectDir: string, configPath?: string): ProjectConfig {
  const path = configPath ?? join(projectDir, ".octopus", "config.yaml")
  if (!existsSync(path)) return {}
  try {
    const content = readFileSync(path, "utf-8")
    const parsed = parseSimpleKeyValue(content)
    const cfg: ProjectConfig = {}
    if ("org" in parsed) cfg.org = parsed.org
    return cfg
  } catch {
    return {}
  }
}

export function loadEffectiveConfig(org: string, projectDir?: string, orgConfigPath?: string, projConfigPath?: string): Record<string, unknown> {
  const orgConfig = loadOrgConfig(org, orgConfigPath)
  const projectConfig = projectDir ? loadProjectConfig(projectDir, projConfigPath) : {}
  return { ...orgConfig, ...projectConfig }
}

export function getDefaultOrg(): string {
  const globalConfig = loadGlobalConfig()
  const org = globalConfig.default_org
  if (!org) {
    console.error("Error: default_org not configured. Run: octopus setup --org <org>")
    process.exit(1)
  }
  return org
}

export function getOrgPrefix(org: string, workDir?: string): string {
  const cfg = loadEffectiveConfig(org, workDir)
  return ((cfg.prefix as string) || `${org}-`)
}