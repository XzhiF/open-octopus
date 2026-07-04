export { VERSION } from "./version"
export * from "./types/workflow"
export * from "./types/workspace"
export * from "./types/config"
export * from "./types/pipeline"
export * from "./types/notify"
export * from "./yaml/parser"
export * from "./variables/var-pool"
export * from "./variables/expression"
export * from "./variables/substitute"
export * from "./variables/cross-exec-resolver"
export * from "./auto-answers/compiler"
export * from "./config/loader"
export * from "./manifest/validator"
export * from "./repo-ops/mod"
export * from "./skill-search"
export * from "./yaml/pipeline-parser"
export { TemplateRenderer, validateTemplateSyntax } from "./notify/template-renderer"
export { applyFilters } from "./notify/filters"
export * from "./types/scheduler-job"
export * from "./types/scheduler-execution"
export * from "./types/scheduler-audit"
export * from "./types/scheduler-common"
export * from "./types/schedule-workspace"
export * from "./types/agent"
export * from "./types/swarm"
export * from "./plugin/detector"
export * from "./plugin/types"
export * from "./types/knowledge"
export { ModelAliasConfigSchema, DEFAULT_MODEL_ALIASES } from './config/model-alias'
export type { ModelAliasConfig } from './config/model-alias'
export { resolveModelAlias, loadModelAliasConfig, collectNodeEngines } from './config/model-alias'

// ── 统一资源管理 ──────────────────────────────────────────────────
// Resource module utilities (utils, not duplicated from repository/)
export {
  collectFiles,
  copyDirRecursive,
  computeDirSize,
  isPathWithinBase,
  safeRemove,
  formatBytes,
  formatSourceRef,
  nowISO,
} from "./resource/utils"

// Enhanced dependency resolver types & computeReverseDependencies
export {
  computeReverseDependencies,
} from "./resource/dependency-resolver"
export type {
  DependencyNode,
  DependencyEdge,
  DependencyGraph,
  ResolveResult,
  DependencyLookup,
} from "./resource/dependency-resolver"

// Core resource manifest types
export * from "./types/resource-manifest"

// Split type files for resource management
export * from "./types/registry"
export * from "./types/lock-file"
// AuditAction from types/audit conflicts with scheduler-audit's AuditAction,
// so we re-export with prefixed names to avoid ambiguity.
export {
  AuditActionSchema as ResourceAuditActionV2Schema,
  AuditEntrySchema as ResourceAuditEntryV2Schema,
} from "./types/audit"
export type {
  AuditAction as ResourceAuditActionV2,
  AuditEntry as ResourceAuditEntryV2,
} from "./types/audit"
export * from "./types/trusted-sources"
export * from "./types/workspace-config"

// Repository infrastructure (canonical error/store/resolver)
export * from "./repository/dependency-resolver"
export * from "./repository/atomic-store"
export * from "./repository/errors"
export * from "./repository/content-hash"
export type { ISecurityContext } from "./repository/security-interface"
