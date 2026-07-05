import { describe, it, expect } from 'vitest'
import { ResourceError, ResourceErrorCode } from '../resource/errors'

describe('ResourceError', () => {
  it('should carry error code and message', () => {
    const err = new ResourceError(ResourceErrorCode.RESOURCE_NOT_FOUND, 'brainstorming not found')
    expect(err.code).toBe('RESOURCE_NOT_FOUND')
    expect(err.message).toBe('brainstorming not found')
    expect(err instanceof Error).toBe(true)
  })

  it('should carry optional suggestion', () => {
    const err = new ResourceError(ResourceErrorCode.SOURCE_NOT_TRUSTED, 'npm:evil', {
      suggestion: 'Use --trust to add this source'
    })
    expect(err.suggestion).toBe('Use --trust to add this source')
  })

  it('should have all 17 error codes defined', () => {
    const codes = Object.values(ResourceErrorCode)
    expect(codes.length).toBe(17)
    expect(codes).toContain('RESOURCE_NOT_FOUND')
    expect(codes).toContain('DEPENDENCY_CYCLE')
    expect(codes).toContain('LOCK_HELD')
    expect(codes).toContain('PATH_TRAVERSAL_DETECTED')
  })

  it('should map to HTTP status codes', () => {
    expect(ResourceError.toHttpStatus(ResourceErrorCode.RESOURCE_NOT_FOUND)).toBe(404)
    expect(ResourceError.toHttpStatus(ResourceErrorCode.LOCK_HELD)).toBe(409)
    expect(ResourceError.toHttpStatus(ResourceErrorCode.SOURCE_NOT_TRUSTED)).toBe(403)
    expect(ResourceError.toHttpStatus(ResourceErrorCode.RATE_LIMITED)).toBe(429)
    expect(ResourceError.toHttpStatus(ResourceErrorCode.DEPENDENCY_CYCLE)).toBe(422)
  })

  it('should map to CLI exit codes', () => {
    expect(ResourceError.toExitCode(ResourceErrorCode.RESOURCE_NOT_FOUND)).toBe(4)
    expect(ResourceError.toExitCode(ResourceErrorCode.SOURCE_NOT_TRUSTED)).toBe(3)
    expect(ResourceError.toExitCode(ResourceErrorCode.DEPENDENCY_CYCLE)).toBe(5)
    expect(ResourceError.toExitCode(ResourceErrorCode.AUTH_FAILED)).toBe(6)
  })
})
