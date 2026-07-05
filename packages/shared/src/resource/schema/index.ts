import { z } from 'zod'

// --- ResourceManifest ---
const NameRegex = /^[a-z0-9][a-z0-9-]*$/
const HashRegex = /^[a-f0-9]{64}$/
const TargetRegex = /^[a-zA-Z0-9_\-]+(\/[a-zA-Z0-9_\-]+)*$/

export const ResourceSourceSchema = z.object({
  protocol: z.enum(['npm', 'git', 'local', 'builtin']),
  location: z.string().min(1),
  version: z.string().min(1),
  subpath: z.string().optional(),
})

export const ResourceInstallSchema = z.object({
  target: z.string().regex(TargetRegex, 'install.target must not contain shell special characters or path traversal'),
  post_install: z.string().optional(),
}).optional()

export const ResourceManifestSchema = z.object({
  name: z.string().regex(NameRegex).max(64),
  type: z.enum(['skill', 'agent', 'workflow', 'source']),
  version: z.string().min(1),
  source: ResourceSourceSchema,
  hash: z.string().regex(HashRegex),
  dependencies: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  install: ResourceInstallSchema,
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

export type ResourceManifest = z.infer<typeof ResourceManifestSchema>

// --- Registry ---
export const RegistryEntrySchema = z.object({
  manifest: ResourceManifestSchema,
  installedAt: z.string(),
  cachePath: z.string().optional(),
})

export const RegistrySchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), RegistryEntrySchema),
})

export type Registry = z.infer<typeof RegistrySchema>
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>

// --- LockFile ---
export const LockFileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['skill', 'agent', 'workflow', 'source']),
  version: z.string(),
  hash: z.string().regex(HashRegex),
  source: z.string(),
  installedAt: z.string(),
  installedBy: z.enum(['human', 'agent']),
  path: z.string(),
})

export const LockFileSchema = z.object({
  version: z.literal(1),
  resources: z.array(LockFileEntrySchema),
})

export type LockFile = z.infer<typeof LockFileSchema>
export type LockFileEntry = z.infer<typeof LockFileEntrySchema>

// --- WorkspaceResourceConfig ---
export const WorkspaceResourceConfigSchema = z.object({
  resources: z.record(z.string(), z.object({
    type: z.enum(['skill', 'agent', 'workflow', 'source']),
    version: z.string(),
  })),
})

export type WorkspaceResourceConfig = z.infer<typeof WorkspaceResourceConfigSchema>

// --- AuditEntry ---
const AuditActionSchema = z.enum([
  'resource.registered', 'resource.installed', 'resource.uninstalled',
  'resource.updated', 'resource.replaced', 'resource.init_forced',
  'trust.added', 'trust.removed', 'trust.blocked',
  'cache.gc', 'doctor.repaired',
  'security.path_traversal', 'security.agent_forbidden',
  'security.source_blocked', 'security.auth_failed',
])

export const AuditEntrySchema = z.object({
  timestamp: z.string(),
  action: AuditActionSchema,
  resource: z.string(),
  caller: z.enum(['human', 'agent']),
  detail: z.record(z.any()).optional(),
})

export type AuditEntry = z.infer<typeof AuditEntrySchema>

// --- TrustEntry ---
export const TrustEntrySchema = z.object({
  trusted: z.array(z.object({
    protocol: z.string(),
    location: z.string(),
    trusted_at: z.string(),
  })),
  blocked: z.array(z.object({
    protocol: z.string(),
    location: z.string(),
    blocked_at: z.string(),
    reason: z.string().optional(),
  })),
})

export type TrustEntry = z.infer<typeof TrustEntrySchema>

// --- InstallPlan ---
export const InstallPlanSchema = z.object({
  id: z.string(),
  additions: z.array(z.object({
    name: z.string(),
    type: z.enum(['skill', 'agent', 'workflow', 'source']),
    version: z.string(),
    source: z.string(),
  })),
  removals: z.array(z.string()),
  conflicts: z.array(z.object({
    name: z.string(),
    reason: z.string(),
  })),
})

export type InstallPlan = z.infer<typeof InstallPlanSchema>

// ── API Request Schemas (B-07: runtime validation for HTTP endpoints) ────

// TrustSource input — used by POST/DELETE /trust, /trust/block
export const TrustSourceInputSchema = z.object({
  protocol: z.string().min(1, 'protocol is required'),
  // Accept either `location` or legacy `package` field; both resolve to `location`.
  location: z.string().optional(),
  package: z.string().optional(),
  reason: z.string().optional(),
})

// POST /install and POST /update body
export const InstallRequestSchema = z.object({
  names: z.array(z.string()).optional(),
  confirmed: z.boolean().optional(),
  additions: z.array(z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    version: z.string().min(1),
    source: z.string().min(1),
  })).optional(),
  removals: z.array(z.string()).optional(),
})

// POST /uninstall body
export const UninstallRequestSchema = z.object({
  names: z.array(z.string()),
})

// POST /sync body
export const SyncRequestSchema = z.object({
  fix: z.boolean().optional(),
})

// POST /gc body
export const GcRequestSchema = z.object({
  dryRun: z.boolean().optional(),
})

// POST /init body
export const InitRequestSchema = z.object({
  force: z.boolean().optional(),
})

// POST /register body — reuse existing manifest schema
export const RegisterRequestSchema = ResourceManifestSchema
