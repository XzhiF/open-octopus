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

  it('TC-039: registers providers from env vars', async () => {
    const { ModelRegistry } = await import('@earendil-works/pi-coding-agent')
    const mockRegistry = { registerProvider: vi.fn(), getAll: () => [], find: () => null }
    vi.mocked(ModelRegistry.inMemory).mockReturnValue(mockRegistry as any)

    const origAnthropic = process.env.ANTHROPIC_API_KEY
    const origOpenai = process.env.OPENAI_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    process.env.OPENAI_API_KEY = 'test-openai-key'

    try {
      const provider = new PiAgentProvider()
      const chunks: MessageChunk[] = []
      for await (const chunk of provider.sendQuery('env test', '/tmp')) {
        chunks.push(chunk)
      }

      expect(mockRegistry.registerProvider).toHaveBeenCalledWith('anthropic', expect.objectContaining({ apiKey: 'test-anthropic-key' }))
      expect(mockRegistry.registerProvider).toHaveBeenCalledWith('openai', expect.objectContaining({ apiKey: 'test-openai-key' }))
    } finally {
      if (origAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = origAnthropic
      else delete process.env.ANTHROPIC_API_KEY
      if (origOpenai !== undefined) process.env.OPENAI_API_KEY = origOpenai
      else delete process.env.OPENAI_API_KEY
    }
  })

  it('TC-041: options.env overrides process.env', async () => {
    const { ModelRegistry } = await import('@earendil-works/pi-coding-agent')
    const mockRegistry = { registerProvider: vi.fn(), getAll: () => [], find: () => null }
    vi.mocked(ModelRegistry.inMemory).mockReturnValue(mockRegistry as any)

    const origKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'old-key'

    try {
      const provider = new PiAgentProvider()
      const chunks: MessageChunk[] = []
      for await (const chunk of provider.sendQuery('override test', '/tmp', undefined, {
        env: { ANTHROPIC_API_KEY: 'new-key' },
      })) {
        chunks.push(chunk)
      }

      expect(mockRegistry.registerProvider).toHaveBeenCalledWith('anthropic', expect.objectContaining({ apiKey: 'new-key' }))
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey
      else delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('TC-042: headless mode sets no* flags on DefaultResourceLoader', async () => {
    const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent')
    vi.mocked(DefaultResourceLoader).mockClear()

    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('headless test', '/tmp')) {
      chunks.push(chunk)
    }

    expect(DefaultResourceLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
      }),
    )
  })

  it('TC-040/TC-055: yields api_key_missing error when SDK throws API key error', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent')
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      subscribe: vi.fn(),
      prompt: vi.fn().mockRejectedValue(new Error('API key not found for provider')),
      abort: vi.fn(),
      dispose: vi.fn(),
    } as any)

    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('test', '/tmp')) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find(c => c.type === 'error')
    expect(errorChunk).toBeDefined()
    expect((errorChunk as any).code).toBe('api_key_missing')
    expect((errorChunk as any).message).toMatch(/API Key|环境变量/)
  })

  it('TC-056: yields model_not_found error when SDK throws model error', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent')
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      subscribe: vi.fn(),
      prompt: vi.fn().mockRejectedValue(new Error('model "nonexistent-model-xyz" not found in registry')),
      abort: vi.fn(),
      dispose: vi.fn(),
    } as any)

    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('test', '/tmp', undefined, { model: 'nonexistent-model-xyz' })) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find(c => c.type === 'error')
    expect(errorChunk).toBeDefined()
    expect((errorChunk as any).code).toBe('model_not_found')
    expect((errorChunk as any).message).toMatch(/provider\/model-id|模型/)
  })

  it('TC-052/TC-053: budget control - shouldStopAfterTurn registered when maxBudgetUsd set', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent')
    let capturedPromptOptions: any
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      subscribe: vi.fn((cb: any) => { (globalThis as any).__budgetCb = cb }),
      prompt: vi.fn().mockImplementation((_prompt: string, opts: any) => {
        capturedPromptOptions = opts
        const cb = (globalThis as any).__budgetCb
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            cb({ type: 'message_start' })
            cb({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } })
            cb({ type: 'message_end' })
            cb({ type: 'agent_end', messages: [] })
            resolve()
          }, 10)
        })
      }),
      abort: vi.fn(),
      dispose: vi.fn(),
    } as any)

    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('budget test', '/tmp', undefined, { maxBudgetUsd: 0.50 })) {
      chunks.push(chunk)
    }

    expect(capturedPromptOptions).toBeDefined()
    expect(typeof capturedPromptOptions.shouldStopAfterTurn).toBe('function')
    // After the run, totalCost is 0 (no real tokens), so shouldStopAfterTurn returns false
    expect(capturedPromptOptions.shouldStopAfterTurn()).toBe(false)
  })

  it('TC-054: no budget callback when maxBudgetUsd not set', async () => {
    const { createAgentSession } = await import('@earendil-works/pi-coding-agent')
    let capturedPromptOptions: any
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      subscribe: vi.fn((cb: any) => { (globalThis as any).__noBudgetCb = cb }),
      prompt: vi.fn().mockImplementation((_prompt: string, opts: any) => {
        capturedPromptOptions = opts
        const cb = (globalThis as any).__noBudgetCb
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            cb({ type: 'message_start' })
            cb({ type: 'message_end' })
            cb({ type: 'agent_end', messages: [] })
            resolve()
          }, 10)
        })
      }),
      abort: vi.fn(),
      dispose: vi.fn(),
    } as any)

    const provider = new PiAgentProvider()
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('no budget', '/tmp')) {
      chunks.push(chunk)
    }

    expect(capturedPromptOptions).toBeDefined()
    expect(capturedPromptOptions.shouldStopAfterTurn).toBeUndefined()
  })
})
