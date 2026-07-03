import { describe, it, expect, vi } from 'vitest'
import { PiAgentProvider } from '../pi/pi-agent-provider'
import type { MessageChunk } from '../types'

// Mock Pi SDK modules to avoid real API calls
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn().mockResolvedValue({
    subscribe: vi.fn((cb: (e: any) => void) => {
      // Store callback for prompt() to invoke
      ;(globalThis as any).__piSubscribeCb = cb
    }),
    prompt: vi.fn().mockImplementation(() => {
      const cb = (globalThis as any).__piSubscribeCb
      return new Promise<void>((resolve) => {
        // Fire events then resolve — ensures bridge sees them before close
        setTimeout(() => {
          cb({ type: 'message_start' })
          cb({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello from Pi' } })
          cb({ type: 'message_end' })
          cb({ type: 'agent_end', messages: [] })
          resolve()
        }, 10)
      })
    }),
    abort: vi.fn(),
    dispose: vi.fn(),
  }),
  DefaultResourceLoader: vi.fn().mockImplementation(() => ({})),
  ModelRegistry: { inMemory: vi.fn().mockReturnValue({ registerProvider: vi.fn(), getAll: () => [], find: () => null }) },
  AuthStorage: { inMemory: vi.fn().mockReturnValue({}) },
  SessionManager: { list: vi.fn().mockResolvedValue([]) },
}))

describe('PiAgentProvider integration', () => {
  it('produces text_delta + result sequence', async () => {
    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hello', '/tmp')) {
      chunks.push(chunk)
    }
    expect(chunks.some(c => c.type === 'text_delta')).toBe(true)
    expect(chunks.some(c => c.type === 'result')).toBe(true)
    expect(chunks.some(c => c.type === 'message_start')).toBe(true)
  })

  it('pre-aborted signal yields error immediately', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('test', '/tmp', undefined, { abortSignal: controller.signal })) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'error', code: 'aborted' })
  })

  it('getType returns pi', () => {
    expect(new PiAgentProvider().getType()).toBe('pi')
  })

  it('dispose does not throw', () => {
    const provider = new PiAgentProvider()
    expect(() => provider.dispose()).not.toThrow()
  })
})
