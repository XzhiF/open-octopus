const ERROR_CODE_MAP = {
  INVALID_REF: {
    httpStatus: 400,
    exitCode: 2,
    suggestion: "Check that the resource reference uses a valid source type (builtin or local) with correct path/name.",
  },
  INVALID_RESOURCE_NAME: {
    httpStatus: 400,
    exitCode: 2,
    suggestion: "Resource names must start with an alphanumeric character and contain only letters, digits, dots, underscores, and hyphens (max 128 chars).",
  },
  MANIFEST_INVALID: {
    httpStatus: 400,
    exitCode: 2,
    suggestion: "Verify the manifest file matches the ResourceManifest schema — check name, type, source, and required fields.",
  },
  RESOURCE_NOT_FOUND: {
    httpStatus: 404,
    exitCode: 1,
    suggestion: "Ensure the resource is registered. Run 'octopus resource register' before referencing it.",
  },
  PROVIDER_NOT_FOUND: {
    httpStatus: 404,
    exitCode: 1,
    suggestion: "No source provider found for this resource type. Check that the correct provider is configured.",
  },
  ALREADY_INSTALLED: {
    httpStatus: 409,
    exitCode: 1,
    suggestion: "The resource is already installed. Use --force to reinstall or uninstall first.",
  },
  HAS_DEPENDENTS: {
    httpStatus: 409,
    exitCode: 1,
    suggestion: "Cannot remove this resource while other resources depend on it. Uninstall dependents first.",
  },
  CIRCULAR_DEPENDENCY: {
    httpStatus: 422,
    exitCode: 1,
    suggestion: "A circular dependency was detected in the resource graph. Break the cycle by removing or restructuring a dependency.",
  },
  DEPENDENCY_DEPTH_EXCEEDED: {
    httpStatus: 422,
    exitCode: 1,
    suggestion: "Dependency chain exceeds the maximum allowed depth. Simplify the resource dependency tree.",
  },
  PATH_TRAVERSAL: {
    httpStatus: 403,
    exitCode: 1,
    suggestion: "The resolved path escapes the allowed directory. Use only relative paths within the project scope.",
  },
  LOCK_CONFLICT: {
    httpStatus: 423,
    exitCode: 1,
    suggestion: "Another operation holds the resource lock. Wait for it to finish or remove the stale lock file.",
  },
  REGISTRY_CORRUPTED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "The registry file is corrupted. Run 'octopus resource doctor' to repair or re-initialize the registry.",
  },
  LOCK_CORRUPTED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "The lock file is corrupted. Run 'octopus resource doctor' to regenerate it.",
  },
  WRITE_FAILED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "Failed to write to disk. Check file permissions and available disk space.",
  },
  INSTALL_FAILED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "Resource installation failed. Check the source provider, network connectivity, and target directory permissions.",
  },
  UNINSTALL_FAILED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "Resource uninstallation failed. The resource directory may be locked or have permission issues.",
  },
  GC_FAILED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "Garbage collection failed. Some orphaned resources may remain. Run 'octopus resource doctor' to diagnose.",
  },
  SYNC_FAILED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "Registry sync failed. The registry and installed resources may be out of sync. Run 'octopus resource doctor'.",
  },
  DOCTOR_FAILED: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "The doctor check encountered errors. Review the diagnostic output and fix reported issues manually.",
  },
  UNKNOWN: {
    httpStatus: 500,
    exitCode: 1,
    suggestion: "An unexpected error occurred. Re-run with --verbose for more details or file an issue.",
  },
} as const

export type ResourceErrorCode = keyof typeof ERROR_CODE_MAP

export class ResourceError extends Error {
  readonly code: ResourceErrorCode
  readonly exitCode: number
  readonly httpStatus: number
  readonly suggestion: string

  constructor(code: ResourceErrorCode, message?: string, detail?: string) {
    const info = ERROR_CODE_MAP[code]
    const finalMessage = detail
      ? `${message ?? code}: ${detail}`
      : (message ?? code)

    super(finalMessage)
    this.name = "ResourceError"
    this.code = code
    this.exitCode = info.exitCode
    this.httpStatus = info.httpStatus
    this.suggestion = info.suggestion

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
