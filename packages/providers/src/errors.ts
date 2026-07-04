export interface ProviderError {
  code: string
  message: string
}

export function classifyProviderError(
  raw: unknown,
  hints: { provider?: string; envKeyName?: string },
): ProviderError {
  if (raw instanceof Error) {
    const msg = raw.message.toLowerCase()

    if (msg.includes('api key') || msg.includes('api_key') || msg.includes('apikey')) {
      if (hints.envKeyName) {
        return {
          code: 'auth_missing',
          message: `API key not found. Set ${hints.envKeyName} environment variable for ${hints.provider ?? 'the'} provider.`,
        }
      }
      return { code: 'auth_invalid', message: `Invalid API key for ${hints.provider ?? 'the'} provider. Check key format.` }
    }

    if (msg.includes('401') || msg.includes('unauthorized')) {
      return { code: 'auth_invalid', message: `Authentication failed for ${hints.provider ?? 'the'} provider. Verify your API key.` }
    }

    if (msg.includes('403') || msg.includes('forbidden')) {
      return { code: 'auth_expired', message: `API key may be expired or revoked for ${hints.provider ?? 'the'} provider.` }
    }

    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('etimedout')) {
      return { code: 'network_error', message: raw.message }
    }

    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
      return { code: 'rate_limited', message: `Rate limited by ${hints.provider ?? 'the'} provider. Will retry.` }
    }

    // P1-1: Additional error code classifications
    if (msg.includes('model not found') || msg.includes('unknown model') || msg.includes('invalid model') || msg.includes('model_not_found')) {
      return { code: 'model_not_found', message: `Model not found for ${hints.provider ?? 'the'} provider. Check available models and aliases.` }
    }

    if (msg.includes('session disposed') || msg.includes('session closed') || msg.includes('already ended') || msg.includes('session_disposed')) {
      return { code: 'session_disposed', message: 'Session has been disposed. Create a new session to continue.' }
    }

    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline exceeded') || msg.includes('etimedout')) {
      return { code: 'timeout', message: `Request timed out for ${hints.provider ?? 'the'} provider.` }
    }

    if (msg.includes('budget') || msg.includes('cost limit') || msg.includes('spending limit') || msg.includes('budget_exceeded')) {
      return { code: 'budget_exceeded', message: 'Budget limit exceeded. Increase maxBudgetUsd or reduce usage.' }
    }

    if (msg.includes('vars parse') || msg.includes('invalid vars') || msg.includes('variable syntax') || msg.includes('vars_parse_failed')) {
      return { code: 'vars_parse_failed', message: 'Failed to parse vars_update JSON from agent output.' }
    }

    return { code: 'provider_error', message: sanitizeErrorMessage(raw.message) }
  }

  return { code: 'provider_error', message: sanitizeErrorMessage(String(raw)) }
}

export function sanitizeErrorMessage(raw: string): string {
  return raw
    .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***')
    .replace(/sk-ant-[a-zA-Z0-9_-]{20,}/g, '***')
    .replace(/AIzaSy[a-zA-Z0-9_-]{30,}/g, '***')
    .replace(/AKIA[A-Z0-9]{12,}/g, 'AKIA***')
    .replace(/key-[a-zA-Z0-9]{16,}/g, 'key-***')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/g, 'Bearer ***')
    .replace(/[a-zA-Z0-9_-]{36,}/g, '***')
}
