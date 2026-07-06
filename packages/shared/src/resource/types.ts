import { z } from "zod"

export const ResourceTypeSchema = z.enum(["skill", "agent", "workflow"])
export type ResourceType = z.infer<typeof ResourceTypeSchema>

export const SourceRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("builtin"), name: z.string(), subpath: z.string().optional() }),
  z.object({ type: z.literal("local"), path: z.string() }),
])
export type SourceRef = z.infer<typeof SourceRefSchema>

export const ResourceManifestSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  type: ResourceTypeSchema,
  version: z.string().default("0.0.0"),
  description: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  source: SourceRefSchema,
  tags: z.array(z.string()).default([]),
})
export type ResourceManifest = z.infer<typeof ResourceManifestSchema>

export const RegistryEntrySchema = z.object({
  name: z.string(),
  type: ResourceTypeSchema,
  version: z.string(),
  description: z.string().optional(),
  source: SourceRefSchema,
  installed: z.boolean().default(false),
  installPath: z.string().optional(),
  contentHash: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>

export const LockFileEntrySchema = z.object({
  name: z.string(),
  type: ResourceTypeSchema,
  version: z.string(),
  installPath: z.string(),
  contentHash: z.string(),
  installedAt: z.string(),
})
export type LockFileEntry = z.infer<typeof LockFileEntrySchema>

export const InstallPlanSchema = z.object({
  order: z.array(z.string()),
  entries: z.record(z.string(), RegistryEntrySchema),
})
export type InstallPlan = z.infer<typeof InstallPlanSchema>

export const DriftItemSchema = z.object({
  resource: z.string(),
  type: ResourceTypeSchema,
  issue: z.enum(["MISSING", "MODIFIED", "EXTRA"]),
  expected: z.string().optional(),
  actual: z.string().optional(),
  fixed: z.boolean().default(false),
})
export type DriftItem = z.infer<typeof DriftItemSchema>

export const DoctorCheckSchema = z.object({
  name: z.string(),
  healthy: z.boolean(),
  detail: z.string().optional(),
  fixApplied: z.boolean().optional(),
})
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>

export const AuditEntrySchema = z.object({
  timestamp: z.string(),
  action: z.enum(["install", "uninstall", "register", "gc", "sync", "doctor"]),
  resource: z.string(),
  type: ResourceTypeSchema,
  status: z.enum(["success", "failed"]),
  caller: z.string().optional(),
  detail: z.string().optional(),
  prevHash: z.string().optional(),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>
