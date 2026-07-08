// ── ResourceError: 20 error codes with user-facing suggestions ──

export type ResourceErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_ALREADY_EXISTS"
  | "INVALID_REF"
  | "INVALID_NAME"
  | "INVALID_TYPE"
  | "INVALID_SOURCE"
  | "REGISTRY_CORRUPT"
  | "LOCK_CORRUPT"
  | "AUDIT_WRITE_FAILED"
  | "FILE_COPY_FAILED"
  | "FILE_DELETE_FAILED"
  | "PATH_TRAVERSAL"
  | "LOCK_TIMEOUT"
  | "LOCK_BUSY"
  | "ALREADY_INSTALLED"
  | "RESOURCE_LOCKED"
  | "DEPENDENCY_BLOCKED"
  | "VERIFY_FAILED"
  | "VERIFY_WARN"
  | "BUILTIN_NOT_FOUND"
  | "LOCAL_PATH_INVALID"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_ORG"
  | "INTERNAL_ERROR"
  | "SYMLINK_REJECTED"
  | "GIT_CLONE_FAILED"
  | "GIT_PULL_FAILED"
  | "GIT_URL_INVALID"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_ALREADY_EXISTS"
  | "SOURCE_NOT_TRUSTED"
  | "SOURCE_SYNC_FAILED"

const STATUS_MAP: Record<ResourceErrorCode, number> = {
  RESOURCE_NOT_FOUND: 404,
  RESOURCE_ALREADY_EXISTS: 409,
  INVALID_REF: 400,
  INVALID_NAME: 400,
  INVALID_TYPE: 400,
  INVALID_SOURCE: 400,
  REGISTRY_CORRUPT: 500,
  LOCK_CORRUPT: 500,
  AUDIT_WRITE_FAILED: 500,
  FILE_COPY_FAILED: 500,
  FILE_DELETE_FAILED: 500,
  PATH_TRAVERSAL: 400,
  LOCK_TIMEOUT: 408,
  LOCK_BUSY: 409,
  ALREADY_INSTALLED: 409,
  RESOURCE_LOCKED: 409,
  DEPENDENCY_BLOCKED: 409,
  VERIFY_FAILED: 500,
  VERIFY_WARN: 200,
  BUILTIN_NOT_FOUND: 404,
  LOCAL_PATH_INVALID: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_ORG: 400,
  INTERNAL_ERROR: 500,
  SYMLINK_REJECTED: 400,
  GIT_CLONE_FAILED: 500,
  GIT_PULL_FAILED: 500,
  GIT_URL_INVALID: 400,
  SOURCE_NOT_FOUND: 404,
  SOURCE_ALREADY_EXISTS: 409,
  SOURCE_NOT_TRUSTED: 403,
  SOURCE_SYNC_FAILED: 500,
}

const DEFAULT_SUGGESTIONS: Record<ResourceErrorCode, string> = {
  RESOURCE_NOT_FOUND: "Check resource name and type. Use 'octopus resource list' to see available resources.",
  RESOURCE_ALREADY_EXISTS: "Resource is already installed. Uninstall first or use a different name.",
  INVALID_REF: "Use format: builtin:{name} or local:{path}",
  INVALID_NAME: "Name must match: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$",
  INVALID_TYPE: "Type must be one of: skill, agent, workflow",
  INVALID_SOURCE: "Source must be one of: builtin, local, git",
  REGISTRY_CORRUPT: "Registry file is corrupted. Check ~/.octopus/resources/registry.json",
  LOCK_CORRUPT: "Lock file is corrupted. Check ~/.octopus/resources/resources.lock",
  AUDIT_WRITE_FAILED: "Failed to write audit log. Check disk space and permissions.",
  FILE_COPY_FAILED: "Failed to copy resource files. Check disk space and permissions.",
  FILE_DELETE_FAILED: "Failed to delete resource files. Check file permissions.",
  PATH_TRAVERSAL: "Path traversal detected. Use absolute paths within allowed directories.",
  LOCK_TIMEOUT: "Operation timed out waiting for lock. Another install/uninstall may be in progress.",
  LOCK_BUSY: "Another operation is in progress for this resource. Wait and retry.",
  ALREADY_INSTALLED: "Resource is already installed. Uninstall first or use --force.",
  RESOURCE_LOCKED: "Another operation is in progress for this resource. Wait and retry.",
  DEPENDENCY_BLOCKED: "Uninstall blocked by dependent resources. Remove dependents first.",
  VERIFY_FAILED: "Post-install verification failed. Resource may not be usable.",
  VERIFY_WARN: "Verification completed with warnings. Resource installed but may need attention.",
  BUILTIN_NOT_FOUND: "Builtin resource not found. Use 'octopus resource list --builtin' to see available.",
  LOCAL_PATH_INVALID: "Local path is invalid or not accessible.",
  UNSUPPORTED_MEDIA_TYPE: "Set Content-Type: application/json",
  INVALID_ORG: "Org must match: ^[a-zA-Z0-9._-]{1,64}$ and not be reserved",
  INTERNAL_ERROR: "Internal error. Check server logs for details.",
  SYMLINK_REJECTED: "Symlinks are not allowed in resource directories for security.",
  GIT_CLONE_FAILED: "Git clone failed. Check network connectivity and repository access.",
  GIT_PULL_FAILED: "Git pull failed. The repository may have been deleted or moved.",
  GIT_URL_INVALID: "URL must be https://github.com/{owner}/{repo}",
  SOURCE_NOT_FOUND: "Source not found. Use 'octopus resource source list' to see available.",
  SOURCE_ALREADY_EXISTS: "Source already added. Use 'octopus resource source update' to refresh.",
  SOURCE_NOT_TRUSTED: "Source not in allowlist. Use 'octopus resource source add' to trust.",
  SOURCE_SYNC_FAILED: "Failed to sync source. Check network connectivity and repository status.",
}

export class ResourceError extends Error {
  readonly code: ResourceErrorCode
  readonly suggestion: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(
    code: ResourceErrorCode,
    message?: string,
    options?: { suggestion?: string; details?: Record<string, unknown> },
  ) {
    super(message ?? code)
    this.name = "ResourceError"
    this.code = code
    this.status = STATUS_MAP[code]
    this.suggestion = options?.suggestion ?? DEFAULT_SUGGESTIONS[code]
    this.details = options?.details
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        suggestion: this.suggestion,
        ...(this.details && { details: this.details }),
      },
    }
  }
}
