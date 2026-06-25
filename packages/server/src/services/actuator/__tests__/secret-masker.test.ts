import { describe, it, expect } from 'vitest'
import { SecretMasker } from '../secret-masker'

describe('SecretMasker', () => {
  const masker = new SecretMasker()

  describe('isSensitive', () => {
    it('detects common sensitive key patterns', () => {
      expect(masker.isSensitive('API_KEY')).toBe(true)
      expect(masker.isSensitive('ANTHROPIC_API_KEY')).toBe(true)
      expect(masker.isSensitive('DATABASE_URL')).toBe(true)
      expect(masker.isSensitive('SECRET_TOKEN')).toBe(true)
      expect(masker.isSensitive('auth_token')).toBe(true)
      expect(masker.isSensitive('PRIVATE_KEY')).toBe(true)
      expect(masker.isSensitive('connection_string')).toBe(true)
      expect(masker.isSensitive('jwt_secret')).toBe(true)
    })

    it('does not flag non-sensitive keys', () => {
      expect(masker.isSensitive('NODE_ENV')).toBe(false)
      expect(masker.isSensitive('PORT')).toBe(false)
      expect(masker.isSensitive('DEBUG')).toBe(false)
      expect(masker.isSensitive('HOME')).toBe(false)
    })
  })

  describe('maskValue', () => {
    it('returns original value for non-sensitive keys', () => {
      expect(masker.maskValue('NODE_ENV', 'development')).toBe('development')
    })

    it('masks short sensitive values (≤4 chars) with ***', () => {
      expect(masker.maskValue('API_KEY', 'ab')).toBe('***')
      expect(masker.maskValue('API_KEY', 'abcd')).toBe('***')
    })

    it('masks medium sensitive values (≤8 chars) with first char + ***', () => {
      expect(masker.maskValue('API_KEY', 'abcdef')).toBe('a***')
      expect(masker.maskValue('API_KEY', 'abcdefgh')).toBe('a***')
    })

    it('masks long sensitive values (>8 chars) preserving first 3 and last 3', () => {
      expect(masker.maskValue('API_KEY', 'sk-ant-api03-xxx-a3f')).toBe('sk-***...a3f')
      expect(masker.maskValue('SECRET_TOKEN', 'my-very-long-secret-token')).toBe('my-***...ken')
    })

    it('truncates PATH-like keys exceeding truncateLength', () => {
      const longPath = '/usr/bin:/usr/local/bin:/opt/homebrew/bin:/some/very/long/path/that/exceeds/eighty/characters/total'
      const result = masker.maskValue('PATH', longPath)
      expect(result).toContain('...(truncated)')
      expect(result.length).toBeLessThan(longPath.length)
    })
  })

  describe('maskObject', () => {
    it('applies masking rules to each entry', () => {
      const result = masker.maskObject({
        NODE_ENV: 'production',
        ANTHROPIC_API_KEY: 'sk-ant-api03-xxxxx-a3f',
        PORT: '3001',
      })
      expect(result.NODE_ENV).toBe('production')
      expect(result.ANTHROPIC_API_KEY).toBe('sk-***...a3f')
      expect(result.PORT).toBe('3001')
    })
  })

  describe('custom patterns', () => {
    it('accepts custom sensitive patterns', () => {
      const custom = new SecretMasker({ sensitivePatterns: [/^CUSTOM_/i] })
      expect(custom.isSensitive('CUSTOM_SECRET')).toBe(true)
      expect(custom.isSensitive('API_KEY')).toBe(false) // default patterns not used
    })

    it('accepts custom truncate keys', () => {
      const custom = new SecretMasker({ truncateKeys: ['MY_LONG_VAR'], truncateLength: 10 })
      expect(custom.maskValue('MY_LONG_VAR', 'abcdefghijklmnop')).toBe('abcdefghij...(truncated)')
    })
  })
})
