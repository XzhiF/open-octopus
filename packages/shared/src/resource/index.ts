/**
 * @octopus/shared — resource module
 *
 * 统一资源管理的数据基础:
 *   - Zod Schemas (manifest, registry, lock file, audit, trusted sources)
 *   - 错误类体系 (RepoError 家族)
 *   - 原子写入存储 (AtomicJsonStore)
 *   - 依赖解析引擎 (DependencyResolver)
 *   - 工具函数 (hash, file ops, formatting)
 *
 * Note: Core types are now split into dedicated files under types/ and repository/.
 * This module re-exports backward-compatible names and enhanced implementations
 * that don't conflict with the new split files.
 */

// ── Backward-compatible types from resource-manifest ────────────
// (names NOT present in the new split type files)
export {
  ResourceDependencySchema,
  registryKey,
} from "../types/resource-manifest"
export type { ResourceDependency } from "../types/resource-manifest"

// ── Errors (only non-conflicting enhanced error classes) ────────
// RepoError, SecurityError, SourceFetchError, InstallVerificationError
// are now in repository/errors.ts — not re-exported here to avoid conflicts.
export {
  ResourceNotFoundError,
  CircularDependencyError,
  DepthExceededError,
  ManifestParseError,
  LockConflictError,
  ReverseDependencyError,
} from "./errors"

// ── Enhanced Dependency Resolver (BFS + DFS + Kahn topology) ────
// GraphDependencyResolver (this module) uses a lookup-function API with full
// graph construction + cycle detection + Kahn topological sort.
// The simpler DependencyResolver (repository/dependency-resolver.ts) takes a
// ResourceManifest[] array and uses direct DFS traversal.
// Only non-conflicting types and functions are re-exported here.
export {
  computeReverseDependencies,
} from "./dependency-resolver"
export type {
  DependencyNode,
  DependencyEdge,
  DependencyGraph,
  ResolveResult,
  DependencyLookup,
} from "./dependency-resolver"

// ── Utilities ───────────────────────────────────────────────────
export {
  collectFiles,
  copyDirRecursive,
  computeDirSize,
  isPathWithinBase,
  safeRemove,
  formatBytes,
  formatSourceRef,
  nowISO,
} from "./utils"
