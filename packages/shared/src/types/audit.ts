import { z } from "zod"

export const AuditActionSchema = z.enum([
  "resource.registered",
  "resource.installed",
  "resource.uninstalled",
  "resource.updated",
  "workspace.init",
  "workspace.sync",
  "lock.updated",
  "trust.added",
  "trust.revoked",
  "cache.gc",
  "config.parsed",
  "source.trusted",
  "source.blocked",
  "rollback.performed",
  "security.blocked",
])
export type AuditAction = z.infer<typeof AuditActionSchema>

export const AuditEntrySchema = z.object({
  timestamp: z.string(),
  action: AuditActionSchema,
  caller: z.enum(["human", "agent"]).default("human"),
  resource_name: z.string().optional(),
  resource_type: z.string().optional(),
  source_ref: z.string().optional(),
  hash: z.string().optional(),
  target_path: z.string().optional(),
  workspace: z.string().optional(),
  status: z.enum(["success", "failure", "warning"]).default("success"),
  reason: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>
