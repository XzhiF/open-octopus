// Resource types — single source of truth is @octopus/shared.
// Re-export for web-app convenience. No custom types here.

export type {
  ResourceType,
  ResourceSource,
  ResourceScope,
  ResourceStatus,
  ResourceEntry,
  ResourceAuditAction,
  ResourceAuditCaller,
  ResourceAuditRecord,
  InstallRequest,
  InstallResponse,
  UninstallRequest,
  UninstallResponse,
  ResourceListResponse,
  VerifyResult,
  VerifyStepResult,
  BuiltinCatalogEntry,
  SourceEntry,
  SourceAddRequest,
  SourceAddResponse,
  SourceUpdateRequest,
} from "@octopus/shared"

// Web-app specific query params (not in shared — UI concern)
export interface ListQuery {
  type?: "skill" | "agent" | "workflow"
  query?: string
  installed?: boolean
}
