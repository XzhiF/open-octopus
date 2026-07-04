/**
 * Repository module — 统一资源管理
 *
 * 模块导出 + 工厂函数
 */
import { join } from "path"
import { homedir } from "os"
import { RepositoryManager } from "./repository-manager"
import { SecurityContext, TrustStore } from "./security-context"
import { AuditLogger } from "./audit-logger"
import { SourceProviderRegistry } from "./providers"

// Re-exports
export { RepositoryManager } from "./repository-manager"
export { RegistryStore } from "./registry"
export { SecurityContext, TrustStore } from "./security-context"
export type { SecurityContextOptions, TrustStatus } from "./security-context"
export { AuditLogger } from "./audit-logger"
export {
  SourceProviderRegistry,
  NpmProvider,
  GitProvider,
  LocalProvider,
  BuiltinProvider,
} from "./providers"
export type { SourceProvider, FetchResult, ValidationResult } from "./providers"
export { WorkspaceInstaller } from "./installer"
export type { InstallPlan, InstallStep, InstallOptions, InstallResult, InstallMode } from "./installer"
export { SnapshotManager } from "./snapshot"
export type { InstallSnapshot, SnapshotEntry, RollbackReport } from "./snapshot"
export { ResourceSearcher } from "./searcher"
export type { SearchOptions, SearchResult } from "./searcher"
export { WorkspaceUninstaller } from "./uninstaller"
export type { UninstallResult } from "./uninstaller"
export { OutputFormatter } from "./output"
export type { OutputOptions } from "./output"
export { scanUnusedCache, runGc, aggregateGcResult } from "./gc"
export type { GcEntry, GcResult } from "./gc"
export { readLockFile, readWorkspaceConfig, computeDrift } from "./lock-manager"
export type { LockEntry, LockFile, WorkspaceConfig, DriftItem, DriftReport } from "./lock-manager"

// ── 工厂函数 ────────────────────────────────────────────────────

export interface CreateRepositoryOptions {
  repoDir?: string
  workspaceDir?: string
  autoTrust?: boolean
  corePackDir?: string
}

/**
 * 创建完整的资源管理上下文
 *
 * ```typescript
 * const repo = createRepository()
 * const entries = repo.manager.list()
 * ```
 */
export function createRepository(opts: CreateRepositoryOptions = {}): {
  manager: RepositoryManager
  security: SecurityContext
  audit: AuditLogger
  trustStore: TrustStore
} {
  const repoDir = opts.repoDir || join(homedir(), ".octopus", "repository")
  const workspaceDir = opts.workspaceDir || process.cwd()

  // 安全上下文
  const trustStore = new TrustStore(join(repoDir, "trusted-sources.yaml"))
  const security = new SecurityContext({
    trustStore,
    autoTrust: opts.autoTrust ?? false,
  })

  // 审计日志
  const auditLogPath = join(workspaceDir, ".octopus", "audit.jsonl")
  const audit = new AuditLogger(auditLogPath)

  // Repository manager
  const manager = new RepositoryManager(repoDir)

  return { manager, security, audit, trustStore }
}
