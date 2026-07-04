import { z } from "zod"
import path from "path"

export const ResourceTypeSchema = z.enum(["skill", "agent", "workflow", "source"])
export type ResourceType = z.infer<typeof ResourceTypeSchema>

export const SourceRefSchema = z.discriminatedUnion("protocol", [
  z.object({
    protocol: z.literal("npm"),
    package: z.string().min(1),
    version: z.string().optional(),
  }),
  z.object({
    protocol: z.literal("github"),
    repo: z.string().min(1),
    path: z.string().optional(),
    ref: z.string().optional(),
  }),
  z.object({
    protocol: z.literal("local"),
    path: z.string().min(1),
  }),
  z.object({
    protocol: z.literal("builtin"),
    id: z.string().min(1),
  }),
])
export type SourceRef = z.infer<typeof SourceRefSchema>

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/

export const ResourceManifestSchema = z.object({
  name: z.string().regex(NAME_REGEX, "首字符须字母/数字，仅 [a-zA-Z0-9_-]，最长 100"),
  type: ResourceTypeSchema,
  version: z.string().default("0.0.0"),
  description: z.string().max(500).default(""),
  source: SourceRefSchema,
  target: z.object({
    dir: z.string(),
    pattern: z.enum(["directory", "file", "glob"]).default("directory"),
  }).optional(),
  files: z.array(
    z.string().refine(
      f => !f.includes("..") && !path.isAbsolute(f),
      "路径须相对且不含 '..'"
    )
  ).optional(),
  dependencies: z.array(z.object({
    name: z.string(),
    type: ResourceTypeSchema,
    optional: z.boolean().default(false),
  })).default([]),
  tags: z.array(z.string()).default([]),
  extends: z.record(z.string(), z.unknown()).optional(),
  _hash: z.string().optional(),
  _registeredAt: z.string().optional(),
  _size: z.number().optional(),
})
export type ResourceManifest = z.infer<typeof ResourceManifestSchema>

export const DEFAULT_TARGETS: Record<ResourceType, { dir: string; pattern: "directory" | "file" }> = {
  skill:    { dir: ".claude/skills", pattern: "directory" },
  agent:    { dir: ".claude/agents", pattern: "file" },
  workflow: { dir: "workflows",      pattern: "file" },
  source:   { dir: "dependencies",   pattern: "directory" },
}

// ── Backward compatibility (used by resource/dependency-resolver.ts & tests) ──

export const ResourceDependencySchema = z.object({
  name: z.string(),
  type: ResourceTypeSchema,
  optional: z.boolean().default(false),
})
export type ResourceDependency = z.infer<typeof ResourceDependencySchema>

/** 构造注册表 key: "{type}:{name}" */
export function registryKey(type: ResourceType, name: string): string {
  return `${type}:${name}`
}

/** 获取资源类型的默认安装目标 */
export function getDefaultTarget(type: ResourceType): { dir: string; pattern: "directory" | "file" } {
  return DEFAULT_TARGETS[type]
}

/** 验证资源名合法性 */
export function isValidResourceName(name: string): boolean {
  return NAME_REGEX.test(name)
}

// ── Backward-compat types (NOT in split files, unique names) ──

export const WorkspaceResourcesSchema = z.object({
  skills: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
})
export type WorkspaceResources = z.infer<typeof WorkspaceResourcesSchema>

/** 从 config.json resources 声明构造 InstallTarget 列表 */
export function flattenResourceDeclarations(
  resources: WorkspaceResources
): Array<{ name: string; type: ResourceType }> {
  const targets: Array<{ name: string; type: ResourceType }> = []
  for (const name of resources.skills) targets.push({ name, type: "skill" })
  for (const name of resources.agents) targets.push({ name, type: "agent" })
  for (const name of resources.workflows) targets.push({ name, type: "workflow" })
  for (const name of resources.sources) targets.push({ name, type: "source" })
  return targets
}

// ── Audit actions — unified in types/audit.ts ──
// Re-export for backward compatibility
export { AuditActionSchema as ResourceAuditActionSchema } from "./audit"
export type { AuditAction as ResourceAuditAction } from "./audit"

export const TrustedSourceEntrySchema = z.object({
  protocol: z.string(),
  package: z.string().optional(),
  repo: z.string().optional(),
  path: z.string().optional(),
  id: z.string().optional(),
  trusted_at: z.string(),
})
export type TrustedSourceEntry = z.infer<typeof TrustedSourceEntrySchema>

// ── Lock file types — canonical in types/lock-file.ts ──
// Import from there directly to avoid circular dependency:
//   import { LockResourceEntrySchema, LockFileSchema } from "./lock-file"
// LockEntrySchema is kept as an alias in lock-file.ts re-exports via shared/index.ts
