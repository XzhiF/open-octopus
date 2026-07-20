import { describe, it, expect } from 'vitest'
import { maskSensitiveInfo } from '../services/github/pr-creator'

describe('GitHubPRCreator', () => {
  // ── Sensitive info filter ────────────────────────────────────────

  describe('maskSensitiveInfo', () => {
    it('masks GitHub personal access tokens', () => {
      const input = 'Check out ghp_1234567890abcdefghijklmnopqrstuvwxyz in the config'
      const result = maskSensitiveInfo(input)
      expect(result).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz')
      expect(result).toContain('[REDACTED]')
    })

    it('masks password assignments', () => {
      const input = 'password: my-secret-pass'
      const result = maskSensitiveInfo(input)
      expect(result).not.toContain('my-secret-pass')
      expect(result).toContain('pass')
      expect(result).toContain('[REDACTED]')
    })

    it('masks token assignments', () => {
      const input = 'token = abc123def456'
      const result = maskSensitiveInfo(input)
      expect(result).not.toContain('abc123def456')
    })

    it('masks API keys', () => {
      const input = 'api_key: sk-abcdefghijklmnopqrstuvwxyz1234'
      const result = maskSensitiveInfo(input)
      expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz1234')
    })

    it('masks AWS access keys', () => {
      const input = 'AWS key: AKIAIOSFODNN7EXAMPLE'
      const result = maskSensitiveInfo(input)
      expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE')
    })

    it('passes through clean text unchanged', () => {
      const input = 'This is a normal PR description with no secrets'
      expect(maskSensitiveInfo(input)).toBe(input)
    })

    it('handles multiple sensitive items in one string', () => {
      const input = 'password: secret123 and token: ghp_abcdefghijklmnopqrstuvwxyz1234567890'
      const result = maskSensitiveInfo(input)
      expect(result).not.toContain('secret123')
      expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890')
    })
  })

  // ── Retry logic (unit-level, no actual exec) ─────────────────────

  it('exports createPR as async method', async () => {
    // We can't test actual gh CLI execution in unit tests,
    // but we verify the class structure
    const { GitHubPRCreator } = await import('../services/github/pr-creator')
    const creator = new GitHubPRCreator()
    expect(typeof creator.createPR).toBe('function')
  })
})
