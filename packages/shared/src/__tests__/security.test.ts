import { describe, it, expect } from 'vitest'
import { SecurityContext, TrustStore, HookExecutor } from '../resource/security'

describe('SecurityContext', () => {
  it('allows safe paths', () => {
    const result = SecurityContext.assertSafePath('skills/test', '/workspace')
    expect(result).toContain('skills/test')
  })

  it('detects path traversal with ..', () => {
    expect(() => SecurityContext.assertSafePath('../../../etc/passwd', '/workspace'))
      .toThrow('PATH_TRAVERSAL_DETECTED')
  })

  it('detects embedded ..', () => {
    expect(() => SecurityContext.assertSafePath('foo/../bar', '/workspace'))
      .toThrow('PATH_TRAVERSAL_DETECTED')
  })

  it('assertSafeTarget rejects dangerous characters', () => {
    expect(() => SecurityContext.assertSafeTarget('foo/bar')).not.toThrow()
    expect(() => SecurityContext.assertSafeTarget('../etc')).toThrow('dangerous')
    expect(() => SecurityContext.assertSafeTarget('$(cmd)')).toThrow('dangerous')
    expect(() => SecurityContext.assertSafeTarget('a;rm -rf')).toThrow('dangerous')
  })
})

describe('TrustStore', () => {
  it('trusts and checks sources', () => {
    const store = new TrustStore()
    const source = { protocol: 'npm', location: 'superpowers-zh' }

    expect(store.isTrusted(source)).toBe(false)
    store.trust(source)
    expect(store.isTrusted(source)).toBe(true)
  })

  it('blocks sources', () => {
    const store = new TrustStore()
    const source = { protocol: 'npm', location: 'evil-pkg' }

    store.block(source, 'malicious')
    expect(store.isBlocked(source)).toBe(true)
    expect(store.isTrusted(source)).toBe(false)
  })

  it('assertAllowed throws for blocked sources', () => {
    const store = new TrustStore()
    const source = { protocol: 'npm', location: 'evil-pkg' }
    store.block(source)
    expect(() => store.assertAllowed(source)).toThrow('SOURCE_BLOCKED')
  })

  it('assertAllowed throws for untrusted sources', () => {
    const store = new TrustStore()
    const source = { protocol: 'npm', location: 'unknown' }
    expect(() => store.assertAllowed(source)).toThrow('SOURCE_NOT_TRUSTED')
  })

  it('always trusts builtin and local protocols', () => {
    const store = new TrustStore()
    expect(() => store.assertAllowed({ protocol: 'builtin', location: 'core-pack' })).not.toThrow()
    expect(() => store.assertAllowed({ protocol: 'local', location: '/tmp' })).not.toThrow()
  })

  it('untrust removes trust', () => {
    const store = new TrustStore()
    const source = { protocol: 'npm', location: 'test' }
    store.trust(source)
    expect(store.isTrusted(source)).toBe(true)
    store.untrust(source)
    expect(store.isTrusted(source)).toBe(false)
  })
})

describe('HookExecutor', () => {
  it('rejects commands not in allowlist', async () => {
    const executor = new HookExecutor(['npm', 'npx'])
    await expect(executor.execute('rm -rf /', '/tmp'))
      .rejects.toThrow('AGENT_CONFIRMATION_REQUIRED')
  })

  it('dry-run returns simulated output', async () => {
    const executor = new HookExecutor([], true)
    const result = await executor.execute('echo hello', '/tmp')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('dry-run')
  })
})
