import { describe, it, expect, beforeEach } from 'vitest'
import { registerProvider, getProvider, resetProviderInstances, isProviderRegistered, listProviders } from '../registry'

describe('Registry base', () => {
  beforeEach(() => {
    resetProviderInstances()
  })

  it('registers and retrieves a provider (P1-2)', () => {
    registerProvider('test-base', () => ({ getType: () => 'test-base', sendQuery: async function*() {} } as any))
    const provider = getProvider('test-base')
    expect(provider.getType()).toBe('test-base')
  })

  it('throws for unknown provider (P1-2)', () => {
    expect(() => getProvider('nonexistent')).toThrow('Unknown provider: nonexistent')
  })

  it('isProviderRegistered returns true/false (P1-2)', () => {
    expect(isProviderRegistered('test-reg')).toBe(false)
    registerProvider('test-reg', () => ({ getType: () => 'test', sendQuery: async function*() {} } as any))
    expect(isProviderRegistered('test-reg')).toBe(true)
  })

  it('listProviders returns registered IDs (P1-2)', () => {
    registerProvider('alpha', () => ({ getType: () => 'alpha', sendQuery: async function*() {} } as any))
    registerProvider('beta', () => ({ getType: () => 'beta', sendQuery: async function*() {} } as any))
    const ids = listProviders()
    expect(ids).toContain('alpha')
    expect(ids).toContain('beta')
  })
})

describe('Registry singleton cache (F-2)', () => {
  beforeEach(() => {
    resetProviderInstances()
  })

  it('returns the same instance on repeated calls', () => {
    let callCount = 0
    registerProvider('test-singleton', () => {
      callCount++
      return { getType: () => 'test', sendQuery: async function*() {} } as any
    })
    const a = getProvider('test-singleton')
    const b = getProvider('test-singleton')
    expect(a).toBe(b)
    expect(callCount).toBe(1)
  })

  it('resetProviderInstances clears cache', () => {
    let callCount = 0
    registerProvider('test-reset', () => {
      callCount++
      return { getType: () => 'test', sendQuery: async function*() {} } as any
    })
    getProvider('test-reset')
    resetProviderInstances()
    getProvider('test-reset')
    expect(callCount).toBe(2)
  })
})
