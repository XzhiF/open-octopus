export enum ResourceErrorCode {
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_ALREADY_EXISTS = 'RESOURCE_ALREADY_EXISTS',
  RESOURCE_ALREADY_INITIALIZED = 'RESOURCE_ALREADY_INITIALIZED',
  RESOURCE_NOT_INSTALLED = 'RESOURCE_NOT_INSTALLED',
  SOURCE_NOT_TRUSTED = 'SOURCE_NOT_TRUSTED',
  SOURCE_BLOCKED = 'SOURCE_BLOCKED',
  DEPENDENCY_CYCLE = 'DEPENDENCY_CYCLE',
  DEPENDENCY_MISSING = 'DEPENDENCY_MISSING',
  LOCK_HELD = 'LOCK_HELD',
  LOCK_FAILED = 'LOCK_FAILED',
  PATH_TRAVERSAL_DETECTED = 'PATH_TRAVERSAL_DETECTED',
  AUTH_FAILED = 'AUTH_FAILED',
  AGENT_CONFIRMATION_REQUIRED = 'AGENT_CONFIRMATION_REQUIRED',
  RATE_LIMITED = 'RATE_LIMITED',
  FETCH_FAILED = 'FETCH_FAILED',
  HASH_MISMATCH = 'HASH_MISMATCH',
  INVALID_MANIFEST = 'INVALID_MANIFEST',
  RESOURCE_HAS_DEPENDENTS = 'RESOURCE_HAS_DEPENDENTS',
}

export class ResourceError extends Error {
  readonly code: string
  readonly status: number
  readonly suggestion?: string

  constructor(code: ResourceErrorCode, message: string, opts?: { suggestion?: string }) {
    super(message)
    this.name = 'ResourceError'
    this.code = code
    this.status = ResourceError.toHttpStatus(code)
    this.suggestion = opts?.suggestion
  }

  static toHttpStatus(code: ResourceErrorCode): number {
    const map: Record<string, number> = {
      RESOURCE_NOT_FOUND: 404,
      RESOURCE_ALREADY_EXISTS: 409,
      RESOURCE_ALREADY_INITIALIZED: 409,
      RESOURCE_NOT_INSTALLED: 404,
      SOURCE_NOT_TRUSTED: 403,
      SOURCE_BLOCKED: 403,
      DEPENDENCY_CYCLE: 422,
      DEPENDENCY_MISSING: 422,
      LOCK_HELD: 409,
      LOCK_FAILED: 423,
      PATH_TRAVERSAL_DETECTED: 400,
      AUTH_FAILED: 401,
      AGENT_CONFIRMATION_REQUIRED: 403,
      RATE_LIMITED: 429,
      FETCH_FAILED: 502,
      HASH_MISMATCH: 422,
      INVALID_MANIFEST: 400,
      RESOURCE_HAS_DEPENDENTS: 409,
    }
    return map[code] ?? 500
  }

  static toExitCode(code: ResourceErrorCode): number {
    const map: Record<string, number> = {
      RESOURCE_NOT_FOUND: 4,
      RESOURCE_ALREADY_EXISTS: 1,
      RESOURCE_ALREADY_INITIALIZED: 1,
      RESOURCE_NOT_INSTALLED: 4,
      SOURCE_NOT_TRUSTED: 3,
      SOURCE_BLOCKED: 3,
      DEPENDENCY_CYCLE: 5,
      DEPENDENCY_MISSING: 5,
      LOCK_HELD: 1,
      LOCK_FAILED: 1,
      PATH_TRAVERSAL_DETECTED: 1,
      AUTH_FAILED: 6,
      AGENT_CONFIRMATION_REQUIRED: 3,
      RATE_LIMITED: 7,
      FETCH_FAILED: 1,
      HASH_MISMATCH: 1,
      INVALID_MANIFEST: 1,
      RESOURCE_HAS_DEPENDENTS: 1,
    }
    return map[code] ?? 1
  }
}
