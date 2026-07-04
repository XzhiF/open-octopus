/**
 * 统一资源管理 — 错误类体系 (canonical)
 *
 * 所有资源管理相关错误继承 RepoError，提供结构化错误码 + 退出码 + 修复建议。
 *
 * 退出码约定:
 *   0 = 成功
 *   1 = 部分失败
 *   2 = 解析/依赖错误
 *   3 = 网络错误
 *   4 = 资源不存在
 *   5 = 权限/安全错误
 */

export type RepoErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "CIRCULAR_DEPENDENCY"
  | "DEPTH_EXCEEDED"
  | "SOURCE_FETCH_FAILED"
  | "MANIFEST_PARSE_ERROR"
  | "LOCK_CONFLICT"
  | "REVERSE_DEPENDENCY"
  | "SECURITY_ERROR"
  | "INSTALL_VERIFY_FAILED"
  | "REGISTRY_CORRUPT"
  | "INVALID_INPUT"
  | "IO_ERROR"
  | "NETWORK_ERROR"
  | "DISK_SPACE"
  | "ALREADY_INITIALIZED"
  | "ALREADY_REGISTERED"
  | "AMBIGUOUS_RESOURCE"
  | "DEPENDENCY_NOT_FOUND"
  | "CONFIG_PARSE_ERROR"
  | "CACHE_CORRUPT"

export class RepoError extends Error {
  readonly code: RepoErrorCode
  readonly fix: string
  readonly exitCode: number

  constructor(message: string, code: RepoErrorCode, fix: string, exitCode: number) {
    super(message)
    this.name = "RepoError"
    this.code = code
    this.fix = fix
    this.exitCode = exitCode
  }

  /** 人类可读格式 */
  formatHuman(): string {
    return `[ERROR] ${this.code}: ${this.message}. Fix: ${this.fix}`
  }

  /** @deprecated Use formatHuman() */
  toHumanString(): string {
    return this.formatHuman()
  }

  /** Agent 可读 JSON */
  formatJson(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        fix: this.fix,
        exitCode: this.exitCode,
      },
    }
  }

  /** @deprecated Use formatJson() */
  toJson(): { error: { code: string; message: string; details: { fix: string } } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: { fix: this.fix },
      },
    }
  }
}

export class ResourceNotFoundError extends RepoError {
  constructor(name: string, type?: string) {
    const msg = type
      ? `Resource '${type}:${name}' not found in registry`
      : `Resource '${name}' not found in registry`
    super(msg, "RESOURCE_NOT_FOUND", `Run 'octo repo search --query "${name}"' or 'octo repo register' first`, 4)
    this.name = "ResourceNotFoundError"
  }
}

export class CircularDependencyError extends RepoError {
  readonly cycle: string[]

  constructor(cycle: string[]) {
    const cycleStr = cycle.join(" → ")
    super(
      `Circular dependency detected: ${cycleStr}`,
      "CIRCULAR_DEPENDENCY",
      `Break the cycle at one of: ${cycleStr}`,
      2
    )
    this.name = "CircularDependencyError"
    this.cycle = cycle
  }
}

export class DepthExceededError extends RepoError {
  constructor(depth: number, maxDepth: number) {
    super(
      `Dependency depth ${depth} exceeds maximum ${maxDepth}`,
      "DEPTH_EXCEEDED",
      `Simplify dependency tree or increase max depth`,
      2
    )
    this.name = "DepthExceededError"
  }
}

export class SourceFetchError extends RepoError {
  constructor(ref: unknown, reason: string) {
    super(
      `Failed to fetch source: ${typeof ref === 'string' ? ref : JSON.stringify(ref)} — ${reason}`,
      "SOURCE_FETCH_FAILED",
      "Check network connectivity and source URL",
      3
    )
    this.name = "SourceFetchError"
  }
}

export class ManifestParseError extends RepoError {
  constructor(path: string, reason: string) {
    super(
      `Failed to parse manifest at ${path}: ${reason}`,
      "MANIFEST_PARSE_ERROR",
      "Fix YAML/JSON syntax and validate against ResourceManifestSchema",
      2
    )
    this.name = "ManifestParseError"
  }
}

export class LockConflictError extends RepoError {
  constructor(path: string) {
    super(
      `Repository is locked: ${path}`,
      "LOCK_CONFLICT",
      "Another operation is in progress. Wait or remove stale lock.",
      1
    )
    this.name = "LockConflictError"
  }
}

export class ReverseDependencyError extends RepoError {
  constructor(name: string, type: string, dependents: string[]) {
    super(
      `Cannot uninstall ${type}:${name} — required by: ${dependents.join(", ")}`,
      "REVERSE_DEPENDENCY",
      "Uninstall dependents first or use --force",
      1
    )
    this.name = "ReverseDependencyError"
  }
}

export class SecurityError extends RepoError {
  constructor(message: string) {
    super(message, "SECURITY_ERROR", "Check trusted-sources.yaml or contact admin", 5)
    this.name = "SecurityError"
  }
}

export class InstallVerificationError extends RepoError {
  constructor(name: string, type: string, installPath: string) {
    super(
      `Install verification failed for ${type}:${name} at ${installPath}`,
      "INSTALL_VERIFY_FAILED",
      "Reinstall with --force",
      1
    )
    this.name = "InstallVerificationError"
  }
}
