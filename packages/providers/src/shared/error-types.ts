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

  constructor(code: ProviderErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code])
    this.name = 'ProviderError'
    this.code = code
    this.httpStatus = getHttpStatus(code)
  }
}
