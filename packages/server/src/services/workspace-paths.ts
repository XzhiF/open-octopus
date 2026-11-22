// Workspace runtime files live under <root>/.octopus/ — never at the repo root.
// A workspace is often an existing git repository; generic root names such as
// config.json / pipeline.yaml collide with the project's own files. New writes
// always go to the namespaced path; legacy root files are read (and updated in
// place) only when they really are ours, judged by shape — not by name alone.
import fs from "fs"
import path from "path"

export const OCTOPUS_RUNTIME_DIR = ".octopus"
export const WORKSPACE_CONFIG_BASENAME = "workspace.json"
export const WORKSPACE_CONFIG_KIND = "octopus/workspace"

export function octopusRuntimeDir(root: string): string {
  return path.join(root, OCTOPUS_RUNTIME_DIR)
}

/** Canonical config path — always safe to write. */
export function workspaceConfigPath(root: string): string {
  return path.join(root, OCTOPUS_RUNTIME_DIR, WORKSPACE_CONFIG_BASENAME)
}

export function workspaceConfigMarker(): Record<string, unknown> {
  return { kind: WORKSPACE_CONFIG_KIND }
}

/**
 * A legacy root config.json is only adopted when it looks like a workspace
 * config. Business configs (package.json-ish) must never be read or rewritten.
 */
export function isWorkspaceConfigLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  if (o.kind === WORKSPACE_CONFIG_KIND || o.octopusWorkspace === true) return true
  if ("scripts" in o || "dependencies" in o || "devDependencies" in o) return false
  if (Array.isArray(o.repos)) {
    if (
      typeof o.name === "string" ||
      typeof o.created === "string" ||
      typeof o.init_branch_name === "string" ||
      typeof o.source === "string" ||
      typeof o.repo_group === "string"
    ) {
      return true
    }
    // Minimal legacy shape: a non-empty repos[] of named entries is the
    // workspace contract itself, not a business config.
    return (
      o.repos.length > 0 &&
      o.repos.every((r) => !!r && typeof r === "object" && typeof (r as { name?: unknown }).name === "string")
    )
  }
  // No repos array yet (older/minimal config): accept only octopus-only keys,
  // so a business config.json with just a `name` is never adopted.
  return (
    typeof o.name === "string" &&
    ("repo_group" in o || "init_branch_name" in o || "task_id" in o || "source_schedule_id" in o)
  )
}

/** The file a workspace actually uses, or null when it has no valid config. */
export function findWorkspaceConfigFile(root: string): string | null {
  const canonical = workspaceConfigPath(root)
  if (fs.existsSync(canonical)) return canonical
  const legacy = path.join(root, "config.json")
  if (!fs.existsSync(legacy)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(legacy, "utf-8")) as unknown
    return isWorkspaceConfigLike(raw) ? legacy : null
  } catch {
    return null
  }
}

export function readWorkspaceConfig(root: string): Record<string, unknown> | null {
  const file = findWorkspaceConfigFile(root)
  if (!file) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown
    return isWorkspaceConfigLike(raw) ? raw : null
  } catch {
    return null
  }
}

/** Write to the file this workspace already uses; new workspaces go canonical. */
export function writeWorkspaceConfig(root: string, config: Record<string, unknown>): string {
  const file = findWorkspaceConfigFile(root) ?? workspaceConfigPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8")
  fs.renameSync(tmp, file)
  return file
}

/** Read-modify-write; starts from `{}` when the workspace has no config yet. */
export function updateWorkspaceConfig(
  root: string,
  mutate: (config: Record<string, unknown>) => Record<string, unknown> | void,
): Record<string, unknown> {
  const file = findWorkspaceConfigFile(root) ?? workspaceConfigPath(root)
  let config: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown
      if (isWorkspaceConfigLike(raw)) config = raw
    } catch {
      /* malformed — treat as empty and rewrite */
    }
  }
  const next = mutate(config) ?? config
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8")
  fs.renameSync(tmp, file)
  return next
}

/** Canonical pipeline config path — always safe to write. */
export function pipelineConfigPath(root: string): string {
  return path.join(root, OCTOPUS_RUNTIME_DIR, "pipeline.yaml")
}

export function resolvePipelineConfigPath(root: string): string {
  const canonical = pipelineConfigPath(root)
  if (fs.existsSync(canonical)) return canonical
  const legacy = path.join(root, "pipeline.yaml")
  return fs.existsSync(legacy) ? legacy : canonical
}

export function pipelineGuidePath(root: string): string {
  return path.join(root, OCTOPUS_RUNTIME_DIR, "pipeline-guide.md")
}

// ── runtime subdirectories (projects / workflows / logs / state) ─────
// New workspaces keep them under <root>/.octopus/. Older workspaces still
// use the repo root; we detect that from where the workspace identity lives
// (a legacy root config.json), never by the mere presence of a same-named
// business directory.

export const WORKSPACE_RUNTIME_SUBDIRS = ["projects", "workflows", "logs", "state"] as const
export type WorkspaceRuntimeSubdir = (typeof WORKSPACE_RUNTIME_SUBDIRS)[number]

export function workspaceRuntimeBase(root: string): string {
  const configFile = findWorkspaceConfigFile(root)
  if (configFile === path.join(root, "config.json")) return root
  return octopusRuntimeDir(root)
}

export function workspaceSubdir(root: string, name: WorkspaceRuntimeSubdir): string {
  return path.join(workspaceRuntimeBase(root), name)
}
