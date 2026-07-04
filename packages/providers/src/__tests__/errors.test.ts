import { describe, it, expect } from 'vitest'
import { classifyProviderError, sanitizeErrorMessage } from '../errors'

describe('classifyProviderError (E-5)', () => {
  it('classifies API key errors as auth_missing', () => {
    const result = classifyProviderError(
      new Error('API key not found'),
      { provider: 'dashscope', envKeyName: 'DASHSCOPE_API_KEY' },
    )
    expect(result.code).toBe('auth_missing')
    expect(result.message).toContain('DASHSCOPE_API_KEY')
  })

  it('classifies 401 errors as auth_invalid', () => {
    const result = classifyProviderError(
      new Error('HTTP 401 Unauthorized'),
      { provider: 'openai' },
    )
    expect(result.code).toBe('auth_invalid')
  })

  it('classifies network errors', () => {
    const result = classifyProviderError(
      new Error('ECONNREFUSED 127.0.0.1:443'),
      {},
    )
    expect(result.code).toBe('network_error')
  })

  it('falls back to provider_error with sanitized message', () => {
    const result = classifyProviderError(
      new Error('sk-abc123secret456789012345 is invalid'),
      {},
    )
    expect(result.code).toBe('provider_error')
    expect(result.message).not.toContain('sk-abc123secret456789012345')
  })
})

describe('sanitizeErrorMessage', () => {
  it('removes Anthropic API key patterns', () => {
    const msg = 'Error: API key sk-ant-abc123def456ghijklmnopqrst is invalid'
    expect(sanitizeErrorMessage(msg)).not.toContain('sk-ant-')
  })

  it('removes Google API key patterns (P2-3)', () => {
    const msg = 'Invalid key AIzaSyA1234567890abcdefghijklmnopqrstuv'
    expect(sanitizeErrorMessage(msg)).not.toContain('AIzaSy')
  })

  it('removes AWS access key patterns (P2-3)', () => {
    const msg = 'Access key AKIAIOSFODNN7EXAMPLE found in request'
    expect(sanitizeErrorMessage(msg)).not.toContain('AKIAIOSFODNN7')
  })

  it('removes generic long tokens (P2-3)', () => {
    const msg = 'Token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 is expired'
    expect(sanitizeErrorMessage(msg)).not.toContain('eyJhbGci')
  })

  it('BL-4: preserves UUIDs and file paths (no over-sanitization)', () => {
    const msg = 'Session abc12345-def6-7890-abcd-ef1234567890 failed at /usr/local/lib/node_modules/package/index.ts'
    const result = sanitizeErrorMessage(msg)
    expect(result).toContain('abc12345-def6-7890-abcd-ef1234567890')
    expect(result).toContain('/usr/local/lib/node_modules/package/index.ts')
  })

  it('BL-4: removes GitHub PAT tokens', () => {
    const msg = 'Authentication failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12'
    expect(sanitizeErrorMessage(msg)).not.toContain('ghp_')
  })

  it('BL-4: removes npm tokens', () => {
    const msg = 'npm error: npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh1234 expired'
    expect(sanitizeErrorMessage(msg)).not.toContain('npm_ABC')
  })
})
