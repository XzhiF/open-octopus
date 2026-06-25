import { describe, it, expect } from 'vitest'
import { registerProvider, getProvider, isProviderRegistered, listProviders } from '../registry'
import type { IAgentProvider, MessageChunk } from '../types'

async function* emptyGenerator(): AsyncGenerator<MessageChunk> {}

function makeProvider(id: string): IAgentProvider {
  return {
    sendQuery: () => emptyGenerator(),
    getType: () => id,
  }
}

describe('Provider Registry', () => {
  it('registers and retrieves a provider', () => {
    registerProvider('test', () => makeProvider('test'))
    const p = getProvider('test')
    expect(p.getType()).toBe('test')
  })

  it('throws for unknown provider', () => {
    expect(() => getProvider('nonexistent')).toThrow('Unknown provider: nonexistent')
  })

  it('isProviderRegistered returns true after registration', () => {
    registerProvider('test2', () => makeProvider('test2'))
    expect(isProviderRegistered('test2')).toBe(true)
    expect(isProviderRegistered('nonexistent')).toBe(false)
  })

  it('listProviders returns registered IDs', () => {
    registerProvider('a', () => makeProvider('a'))
    registerProvider('b', () => makeProvider('b'))
    const list = listProviders()
    expect(list).toContain('a')
    expect(list).toContain('b')
  })
})