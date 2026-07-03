import { describe, it, expect } from 'vitest'
import { ProviderErrorCode, ProviderError, getHttpStatus } from '../shared/error-types'

describe('ProviderErrorCode', () => {
  it('should have exactly 8 error codes', () => {
    const codes = Object.keys(ProviderErrorCode)
    expect(codes).toHaveLength(8)
  })

  it('should define all required error codes', () => {
    expect(ProviderErrorCode.API_KEY_MISSING).toBe('api_key_missing')
    expect(ProviderErrorCode.MODEL_NOT_FOUND).toBe('model_not_found')
    expect(ProviderErrorCode.SESSION_CREATE_FAILED).toBe('session_create_failed')
    expect(ProviderErrorCode.SESSION_NOT_FOUND).toBe('session_not_found')
    expect(ProviderErrorCode.SESSION_CORRUPTED).toBe('session_corrupted')
    expect(ProviderErrorCode.LLM_TIMEOUT).toBe('llm_timeout')
    expect(ProviderErrorCode.NETWORK_ERROR).toBe('network_error')
    expect(ProviderErrorCode.ABORTED).toBe('aborted')
  })
})

describe('ProviderError', () => {
  it('should extend Error', () => {
    const err = new ProviderError(ProviderErrorCode.API_KEY_MISSING)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ProviderError)
  })

  it('should have correct name property', () => {
    const err = new ProviderError(ProviderErrorCode.MODEL_NOT_FOUND)
    expect(err.name).toBe('ProviderError')
  })

  it('should store the error code', () => {
    const err = new ProviderError(ProviderErrorCode.SESSION_CREATE_FAILED)
    expect(err.code).toBe('session_create_failed')
  })

  it('should use default message when none provided', () => {
    const err = new ProviderError(ProviderErrorCode.API_KEY_MISSING)
    expect(err.message).toBeTruthy()
    expect(err.message.length).toBeGreaterThan(0)
  })

  it('should accept custom message', () => {
    const err = new ProviderError(ProviderErrorCode.MODEL_NOT_FOUND, 'gpt-5-turbo not found in registry')
    expect(err.message).toBe('gpt-5-turbo not found in registry')
  })

  it('should have HTTP status mapping via httpStatus property', () => {
    expect(new ProviderError(ProviderErrorCode.API_KEY_MISSING).httpStatus).toBe(401)
    expect(new ProviderError(ProviderErrorCode.MODEL_NOT_FOUND).httpStatus).toBe(404)
    expect(new ProviderError(ProviderErrorCode.SESSION_CREATE_FAILED).httpStatus).toBe(500)
    expect(new ProviderError(ProviderErrorCode.SESSION_NOT_FOUND).httpStatus).toBe(404)
    expect(new ProviderError(ProviderErrorCode.SESSION_CORRUPTED).httpStatus).toBe(500)
    expect(new ProviderError(ProviderErrorCode.LLM_TIMEOUT).httpStatus).toBe(504)
    expect(new ProviderError(ProviderErrorCode.NETWORK_ERROR).httpStatus).toBe(502)
    expect(new ProviderError(ProviderErrorCode.ABORTED).httpStatus).toBe(499)
  })

  it('should preserve stack trace', () => {
    const err = new ProviderError(ProviderErrorCode.NETWORK_ERROR)
    expect(err.stack).toBeTruthy()
  })
})

describe('getHttpStatus', () => {
  it('should return correct HTTP status for each error code', () => {
    expect(getHttpStatus(ProviderErrorCode.API_KEY_MISSING)).toBe(401)
    expect(getHttpStatus(ProviderErrorCode.MODEL_NOT_FOUND)).toBe(404)
    expect(getHttpStatus(ProviderErrorCode.SESSION_CREATE_FAILED)).toBe(500)
    expect(getHttpStatus(ProviderErrorCode.SESSION_NOT_FOUND)).toBe(404)
    expect(getHttpStatus(ProviderErrorCode.SESSION_CORRUPTED)).toBe(500)
    expect(getHttpStatus(ProviderErrorCode.LLM_TIMEOUT)).toBe(504)
    expect(getHttpStatus(ProviderErrorCode.NETWORK_ERROR)).toBe(502)
    expect(getHttpStatus(ProviderErrorCode.ABORTED)).toBe(499)
  })

  it('should return 500 for unknown error codes', () => {
    expect(getHttpStatus('unknown_code' as any)).toBe(500)
  })
})
