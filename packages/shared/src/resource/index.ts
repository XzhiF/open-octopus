/**
 * Resource Management — 统一导出
 *
 * 4 类资源（skill/agent/workflow/source）的全生命周期管理
 */

// Core schemas
export * from "./schema"

// Error system
export { ResourceError, ResourceErrorCode } from "./errors"

// Storage
export { AtomicJsonStore, FsResourceStore } from "./fs-store"
export type { ReleaseLock } from "./fs-store"

// Audit
export { AuditLogger } from "./audit"

// Security
export { SecurityContext, CallerContext, TrustStore, HookExecutor } from "./security"
export type { TrustSource, TrustData } from "./security"

// Dependency resolution
export { DependencyResolver } from "./resolver"

// Install plan
export { InstallPlanBuilder, createInstallPlan } from "./install-plan"

// Short name resolution
export { ShortNameResolver } from "./short-name"
export type { ResolveResult, ResolveHints } from "./short-name"

// Scan paths
export {
  getScanPaths,
  getAllScanPaths,
  getResourceScanPaths,
  getResourceVars,
  getResourcePromptSegment,
} from "./scan-paths"
export type { ScanPathOptions, ScanContext } from "./scan-paths"

// Source providers
export type { SourceRef, FetchResult, SourceProvider } from "./providers"
export { computeHash, readDirRecursive } from "./providers"
export { BuiltinSourceProvider } from "./providers/builtin-provider"
export { LocalSourceProvider } from "./providers/local-provider"
export { NpmSourceProvider } from "./providers/npm-provider"
export { GitSourceProvider } from "./providers/git-provider"

// Activation hooks
export {
  scanInstalledResources,
  generateDepsVars,
  generatePromptSegment,
} from "./activation"

// Dependency scanner
export {
  scanDependencyVars,
  hasDependency,
  getDependencyPath,
} from "./dependency-scanner"

// Workflow discovery
export { discoverWorkflows, WorkflowDiscovery } from "./workflow-discovery"
export type { WorkflowResourceRef, ResourceReference, InstalledWorkflow } from "./workflow-discovery"
export type { ValidationResult as ResourceValidationResult } from "./workflow-discovery"

// Kernel (main orchestrator)
export { ResourceKernel } from "./kernel"
export type { KernelDeps, InitOptions, PlanInput } from "./kernel"
