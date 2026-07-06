import { z } from "zod"

// ── Resource Types ──────────────────────────────────────────────

export const ResourceType = z.enum(["skill", "agent", "workflow"])
export type ResourceType = z.infer<typeof ResourceType>

export const ResourceSource = z.enum(["builtin", "local"])
export type ResourceSource = z.infer<typeof ResourceSource>

export const ResourceScope = z.literal("org")
export type ResourceScope = z.infer<typeof ResourceScope>

export const ResourceStatus = z.enum(["installed", "installed_but_unverified"])
export type ResourceStatus = z.infer<typeof ResourceStatus>

// ── Validation Patterns ─────────────────────────────────────────

/** Safe resource name: alphanumeric start, then alphanumeric/dot/underscore/hyphen, max 128 chars */
export const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

/** Ref format: source:name (e.g. builtin:brainstorming, local:/path/to/skill) */
export const REF_RE = /^(builtin|local):[a-zA-Z0-9._:/-]{1,256}$/

// ── Schemas ─────────────────────────────────────────────────────

export const ResourceEntrySchema = z.object({
  name: z.string().regex(SAFE_NAME_RE),
  type: ResourceType,
  source: ResourceSource,
  ref: z.string(),
  installed: z.boolean(),
  verified: z.boolean(),
  status: ResourceStatus,
  installedAt: z.string(),
  scope: ResourceScope,
  installPath: z.string(),
  dependsOn: z.array(z.string()).default([]),
})

export type ResourceEntry = z.infer<typeof ResourceEntrySchema>

export const LockEntrySchema = z.object({
  name: z.string(),
  type: ResourceType,
  hash: z.string(),
  lockedAt: z.string(),
  installPath: z.string(),
  fileCount: z.number().int().nonnegative(),
})

export type LockEntry = z.infer<typeof LockEntrySchema>

export const ResourceAuditAction = z.enum([
  "install",
  "uninstall",
  "verify",
  "install_blocked",
  "verify_warn",
  "verify_fail",
])
export type ResourceAuditAction = z.infer<typeof ResourceAuditAction>

export const ResourceAuditCaller = z.enum(["cli", "ui"])
export type ResourceAuditCaller = z.infer<typeof ResourceAuditCaller>

export const ResourceAuditRecordSchema = z.object({
  timestamp: z.string(),
  action: ResourceAuditAction,
  resource_name: z.string(),
  resource_type: ResourceType,
  source: z.string(),
  caller: ResourceAuditCaller,
  details: z.record(z.unknown()).optional(),
})

export type ResourceAuditRecord = z.infer<typeof ResourceAuditRecordSchema>

// ── Registry File Schema ────────────────────────────────────────

export const RegistryFileSchema = z.object({
  version: z.literal(1),
  resources: z.array(ResourceEntrySchema),
})

export type RegistryFile = z.infer<typeof RegistryFileSchema>

export const LockFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(LockEntrySchema),
})

export type LockFile = z.infer<typeof LockFileSchema>

// ── API Request/Response Schemas ────────────────────────────────

export const InstallRequestSchema = z.object({
  ref: z.string().regex(REF_RE, "Invalid ref format. Use: builtin:{name} or local:{path}"),
  scope: ResourceScope.default("org"),
  caller: ResourceAuditCaller.default("cli"),
})

export type InstallRequest = z.infer<typeof InstallRequestSchema>

export const UninstallRequestSchema = z.object({
  name: z.string().regex(SAFE_NAME_RE, "Invalid resource name"),
  type: ResourceType,
  caller: ResourceAuditCaller.default("cli"),
})

export type UninstallRequest = z.infer<typeof UninstallRequestSchema>

export const InstallResponseSchema = z.object({
  name: z.string(),
  type: ResourceType,
  source: z.string(),
  status: ResourceStatus,
  installPath: z.string(),
  installedAt: z.string(),
})

export type InstallResponse = z.infer<typeof InstallResponseSchema>

export const UninstallResponseSchema = z.object({
  name: z.string(),
  type: ResourceType,
  status: z.literal("uninstalled"),
  verified: z.boolean(),
})

export type UninstallResponse = z.infer<typeof UninstallResponseSchema>

export const ResourceListResponseSchema = z.object({
  resources: z.array(ResourceEntrySchema),
  total: z.number(),
})

export type ResourceListResponse = z.infer<typeof ResourceListResponseSchema>

// ── Verify Result ───────────────────────────────────────────────

export interface VerifyStepResult {
  step: string
  passed: boolean
  message?: string
}

export interface VerifyResult {
  passed: boolean
  steps: VerifyStepResult[]
}

// ── Builtin Catalog Entry ───────────────────────────────────────

export interface BuiltinCatalogEntry {
  name: string
  type: ResourceType
  description: string
  sourcePath: string
}
