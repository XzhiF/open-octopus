/**
 * Structured error types for AI provider operations.
 *
 * Defines error codes, HTTP status mappings, and a typed error class
 * used across all provider implementations.
 */

// ═══════════════════════════════════════════════════
// Error code registry
// ═══════════════════════════════════════════════════

export const ProviderErrorCode = {
  API_KEY_MISSING: 'api_key_missing',
  MODEL_NOT_FOUND: 'model_not_found',
  SESSION_CREATE_FAILED: 'session_create_failed',
  SESSION_NOT_FOUND: 'session_not_found',
  SESSION_CORRUPTED: 'session_corrupted',
  LLM_TIMEOUT: 'llm_timeout',
  NETWORK_ERROR: 'network_error',
  ABORTED: 'aborted',
  PROVIDER_DISPOSED: 'provider_disposed',
  NESTING_NOT_SUPPORTED: 'nesting_not_supported',
  SUB_AGENT_TIMEOUT: 'sub_agent_timeout',
  BUDGET_EXCEEDED: 'budget_exceeded',
} as const

export type ProviderErrorCode = (typeof ProviderErrorCode)[keyof typeof ProviderErrorCode]

// ═══════════════════════════════════════════════════
// HTTP status mapping
// ═══════════════════════════════════════════════════

const HTTP_STATUS_MAP: Record<ProviderErrorCode, number> = {
  [ProviderErrorCode.API_KEY_MISSING]: 401,
  [ProviderErrorCode.MODEL_NOT_FOUND]: 404,
  [ProviderErrorCode.SESSION_CREATE_FAILED]: 500,
  [ProviderErrorCode.SESSION_NOT_FOUND]: 404,
  [ProviderErrorCode.SESSION_CORRUPTED]: 500,
  [ProviderErrorCode.LLM_TIMEOUT]: 504,
  [ProviderErrorCode.NETWORK_ERROR]: 502,
  [ProviderErrorCode.ABORTED]: 499,
  [ProviderErrorCode.PROVIDER_DISPOSED]: 503,
  [ProviderErrorCode.NESTING_NOT_SUPPORTED]: 400,
  [ProviderErrorCode.SUB_AGENT_TIMEOUT]: 504,
  [ProviderErrorCode.BUDGET_EXCEEDED]: 429,
}

const DEFAULT_HTTP_STATUS = 500

/**
 * Returns the HTTP status code associated with a provider error code.
 * Falls back to 500 for unknown codes.
 */
export function getHttpStatus(code: ProviderErrorCode): number {
  return HTTP_STATUS_MAP[code] ?? DEFAULT_HTTP_STATUS
}

// ═══════════════════════════════════════════════════
// Error class
// ═══════════════════════════════════════════════════

/** Default messages per error code, used when no custom message is provided. */
const DEFAULT_MESSAGES: Record<ProviderErrorCode, string> = {
  [ProviderErrorCode.API_KEY_MISSING]: 'API key is missing or not configured for this provider',
  [ProviderErrorCode.MODEL_NOT_FOUND]: 'Requested model was not found in the provider registry',
  [ProviderErrorCode.SESSION_CREATE_FAILED]: 'Failed to create a new agent session',
  [ProviderErrorCode.SESSION_NOT_FOUND]: 'Session not found or has expired',
  [ProviderErrorCode.SESSION_CORRUPTED]: 'Session state is corrupted and cannot be recovered',
  [ProviderErrorCode.LLM_TIMEOUT]: 'LLM request timed out',
  [ProviderErrorCode.NETWORK_ERROR]: 'Network error while communicating with the provider',
  [ProviderErrorCode.ABORTED]: 'Request was aborted by the caller',
  [ProviderErrorCode.PROVIDER_DISPOSED]: 'Provider has been disposed and cannot accept new requests',
  [ProviderErrorCode.NESTING_NOT_SUPPORTED]: 'Nested sub-agent delegation is not supported',
  [ProviderErrorCode.SUB_AGENT_TIMEOUT]: 'Sub-agent execution timed out',
  [ProviderErrorCode.BUDGET_EXCEEDED]: 'Token budget exceeded',
}

/**
 * Typed error class for provider operations.
 *
 * Carries a structured `code` (from `ProviderErrorCode`) and the
 * corresponding `httpStatus` so callers can translate errors into
 * HTTP responses without ad-hoc mapping.
 *
 * @example
 * ```ts
 * throw new ProviderError(ProviderErrorCode.API_KEY_MISSING)
 * // → code: 'api_key_missing', httpStatus: 401
 * ```
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly httpStatus: number
  readonly recoverable: boolean
  readonly suggestion?: string

  constructor(code: ProviderErrorCode, message?: string, opts?: { recoverable?: boolean; suggestion?: string }) {
    super(message ?? DEFAULT_MESSAGES[code])
    this.name = 'ProviderError'
    this.code = code
    this.httpStatus = getHttpStatus(code)
    this.recoverable = opts?.recoverable ?? false
    this.suggestion = opts?.suggestion
  }
}
