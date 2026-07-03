import { describe, it, expect } from 'vitest'
import { registerProvider, getProvider, getProviderAsync, listProviders } from '../registry'

describe('registry async factory', () => {
  it('getProviderAsync resolves async factory', async () => {
    registerProvider('test-async', async () => {
      return { getType: () => 'test-async', sendQuery: async function* () {} } as any
    })
    const p = await getProviderAsync('test-async')
    expect(p.getType()).toBe('test-async')
  })

  it('getProviderAsync works with sync factory too', async () => {
    registerProvider('test-sync-via-async', () => ({
      getType: () => 'test-sync-via-async',
      sendQuery: async function* () {},
    } as any))
    const p = await getProviderAsync('test-sync-via-async')
    expect(p.getType()).toBe('test-sync-via-async')
  })

  it('getProvider throws for async factory', () => {
    registerProvider('test-async-only', async () => {
      return { getType: () => 'test-async-only', sendQuery: async function* () {} } as any
    })
    expect(() => getProvider('test-async-only')).toThrow('async factory')
  })

  it('listProviders includes registered providers', () => {
    registerProvider('test-list-p0', () => ({ getType: () => 'test-list-p0', sendQuery: async function* () {} } as any))
    expect(listProviders()).toContain('test-list-p0')
  })
})
