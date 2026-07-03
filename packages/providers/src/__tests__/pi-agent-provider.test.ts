import { describe, it, expect } from 'vitest'
import type { IAgentProvider, MessageChunk } from '../types'
import { PiAgentProvider } from '../pi/pi-agent-provider'

describe('PiAgentProvider', () => {
  it('implements IAgentProvider interface', () => {
    const provider: IAgentProvider = new PiAgentProvider()
    expect(typeof provider.getType).toBe('function')
    expect(typeof provider.sendQuery).toBe('function')
  })

  it('getType returns "pi"', () => {
    const provider = new PiAgentProvider()
    expect(provider.getType()).toBe('pi')
  })

  it('sendQuery returns an AsyncGenerator', () => {
    const provider = new PiAgentProvider()
    const result = provider.sendQuery('hello', '/tmp')

    // AsyncGenerator must have next(), return(), throw() methods
    expect(result).toBeDefined()
    expect(typeof result.next).toBe('function')
    expect(typeof result.return).toBe('function')
    expect(typeof result.throw).toBe('function')
    expect(typeof result[Symbol.asyncIterator]).toBe('function')
  })

  it('can consume the generator and it completes', async () => {
    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []

    for await (const chunk of provider.sendQuery('hello', '/tmp')) {
      chunks.push(chunk)
    }

    // Generator should complete without hanging
    // Skeleton may yield zero or more placeholder chunks
    expect(Array.isArray(chunks)).toBe(true)
  })

  it('accepts all sendQuery parameters', () => {
    const provider = new PiAgentProvider()

    // Should not throw with any combination of parameters
    const result = provider.sendQuery(
      'prompt text',
      '/working/dir',
      'session-123',
      { model: 'qwen3-max', systemPrompt: 'You are helpful' },
    )

    expect(result).toBeDefined()
    expect(typeof result.next).toBe('function')
  })

  it('sendQuery is an async generator function (not a regular async function)', () => {
    const provider = new PiAgentProvider()
    const result = provider.sendQuery('test', '/tmp')

    // An AsyncGenerator is its own async iterable
    expect(result[Symbol.asyncIterator]()).toBe(result)
  })
})
