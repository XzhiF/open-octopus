// Workspace config/instruction files live under <root>/.octopus/ — the runtime
// directories (projects / workflows / logs / state) stay at the workspace root.
// A workspace is often an existing git repository, so generic root names such
// as config.json / pipeline.yaml collide with the project's own files. New
// writes always go to the namespaced path; legacy root files are read (and
// updated in place) only when they really are ours, judged by shape.
import fs from "fs"
import path from "path"

export const OCTOPUS_RUNTIME_DIR = ".octopus"
export const WORKSPACE_CONFIG_BASENAME = "config.json"
export const WORKSPACE_CONFIG_KIND = "octopus/workspace"
export const WORKSPACE_INSTRUCTION_BASENAME = "CLAUDE.md"

/** Managed block markers for the full workspace instructions in .octopus/CLAUDE.md. */
export const WORKSPACE_CLAUDE_BEGIN = "<!-- octopus:workspace:begin -->"
export const WORKSPACE_CLAUDE_END = "<!-- octopus:workspace:end -->"

/**
 * One-line pointer kept in the repo-root CLAUDE.md. The full workspace
 * instructions live in .octopus/CLAUDE.md; the root file is often the user's
 * own project instructions and must never be clobbered.
 */
export const ROOT_CLAUDE_POINTER =
  "> 工作空间完整说明（目录结构 / 项目 / 开工作树命令）见 [.octopus/CLAUDE.md](.octopus/CLAUDE.md)"

export function octopusRuntimeDir(root: string): string {
  return path.join(root, OCTOPUS_RUNTIME_DIR)
}

/** Canonical config path — always safe to write. */
export function workspaceConfigPath(root: string): string {
  return path.join(root, OCTOPUS_RUNTIME_DIR, WORKSPACE_CONFIG_BASENAME)
}

/** Canonical workspace instructions — the file the root CLAUDE.md points at. */
export function workspaceInstructionPath(root: string): string {
  return path.join(root, OCTOPUS_RUNTIME_DIR, WORKSPACE_INSTRUCTION_BASENAME)
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

/**
 * Replace (or append) a delimited block in a markdown file, preserving the
 * rest of the file. Shared by the workspace instructions and the cabin block.
 */
export function upsertManagedBlock(filePath: string, body: string, beginMarker: string, endMarker: string): void {
  let existing = ""
  try {
    existing = fs.readFileSync(filePath, "utf-8")
  } catch {
    /* new file */
  }
  const block = `${beginMarker}\n${body.trimEnd()}\n${endMarker}`
  const begin = existing.indexOf(beginMarker)
  const end = existing.indexOf(endMarker)
  let next: string
  if (begin !== -1 && end !== -1 && end > begin) {
    next = existing.slice(0, begin) + block + existing.slice(end + endMarker.length)
  } else if (existing.trim().length === 0) {
    next = `${block}\n`
  } else {
    next = `${existing.replace(/\s*$/, "")}\n\n${block}\n`
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, next, "utf-8")
}

/**
 * Ensure the repo-root CLAUDE.md carries exactly one pointer line. Creates the
 * file when the workspace has no CLAUDE.md yet; never rewrites existing content.
 */
export function ensureRootClaudePointer(root: string): string {
  const file = path.join(root, "CLAUDE.md")
  let existing = ""
  try {
    existing = fs.readFileSync(file, "utf-8")
  } catch {
    /* new file */
  }
  if (existing.includes(ROOT_CLAUDE_POINTER)) return file
  const next =
    existing.trim().length === 0
      ? `${ROOT_CLAUDE_POINTER}\n`
      : `${existing.replace(/\s*$/, "")}\n\n${ROOT_CLAUDE_POINTER}\n`
  fs.writeFileSync(file, next, "utf-8")
  return file
}
