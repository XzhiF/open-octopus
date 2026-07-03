import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MessageChunk } from '../types'

// Mock pi-ai/compat streamSimple
const mockStreamSimple = vi.fn()
vi.mock('@earendil-works/pi-ai/compat', () => ({
  streamSimple: (...args: unknown[]) => mockStreamSimple(...args),
}))

// Mock pi-agent-core Agent
type SubscribeListener = (event: any) => void
let subscribeListeners: SubscribeListener[] = []
let mockPromptFn: (prompt: string) => Promise<void>
let mockAgentState: Record<string, any> = {}

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: class MockAgent {
    state = mockAgentState

    constructor(public options: any) {}

    subscribe(listener: SubscribeListener) {
      subscribeListeners.push(listener)
      return () => {
        subscribeListeners = subscribeListeners.filter(l => l !== listener)
      }
    }

    prompt(input: string) {
      return mockPromptFn(input)
    }
  },
}))

import { PiSDKProvider } from '../pi/provider'

function emit(event: any) {
  for (const listener of [...subscribeListeners]) {
    listener(event)
  }
}

describe('PiSDKProvider', () => {
  let provider: PiSDKProvider

  beforeEach(() => {
    provider = new PiSDKProvider()
    subscribeListeners = []
    mockAgentState = {}
    mockStreamSimple.mockReset()
    mockPromptFn = async (_prompt: string) => {
      // Default: simulate a simple text response
      emit({ type: 'agent_start' })
      emit({
        type: 'message_start',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
      })
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      })
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now() },
      })
      emit({
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: Date.now(), usage: { input: 10, output: 5 } },
        ],
      })
    }
  })

  it('getType returns pi', () => {
    expect(provider.getType()).toBe('pi')
  })

  it('streams text delta and result chunks', async () => {
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const types = chunks.map(c => c.type)
    expect(types).toContain('message_start')
    expect(types).toContain('text_delta')
    expect(types).toContain('result')
  })

  it('maps text_delta content correctly', async () => {
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const textDelta = chunks.find(c => c.type === 'text_delta')
    expect(textDelta).toBeDefined()
    if (textDelta?.type === 'text_delta') {
      expect(textDelta.content).toBe('Hello')
    }
  })

  it('includes token usage in result', async () => {
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const result = chunks.find(c => c.type === 'result')
    expect(result).toBeDefined()
    if (result?.type === 'result') {
      expect(result.tokens).toBeDefined()
      expect(result.tokens?.input).toBe(10)
      expect(result.tokens?.output).toBe(5)
      expect(result.tokens?.total).toBe(15)
    }
  })

  it('yields error when API key is missing', async () => {
    // Clear any env vars that might provide a key
    const origDash = process.env.DASHSCOPE_API_KEY
    const origAnthropic = process.env.ANTHROPIC_API_KEY
    const origOpenAI = process.env.OPENAI_API_KEY
    const origGeneric = process.env.API_KEY
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.API_KEY

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp')) {
      chunks.push(chunk)
    }

    expect(chunks.length).toBe(1)
    expect(chunks[0].type).toBe('error')
    if (chunks[0].type === 'error') {
      expect(chunks[0].code).toBe('missing_api_key')
    }

    // Restore
    if (origDash) process.env.DASHSCOPE_API_KEY = origDash
    if (origAnthropic) process.env.ANTHROPIC_API_KEY = origAnthropic
    if (origOpenAI) process.env.OPENAI_API_KEY = origOpenAI
    if (origGeneric) process.env.API_KEY = origGeneric
  })

  it('maps tool execution events', async () => {
    mockPromptFn = async () => {
      emit({ type: 'agent_start' })
      emit({
        type: 'message_start',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
      })
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'bash',
        args: { command: 'echo hello' },
      })
      emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'hello\n' }] },
        isError: false,
      })
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
      })
      emit({
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Done' }], timestamp: Date.now(), usage: { input: 20, output: 10 } },
        ],
      })
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('run echo', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const toolStart = chunks.find(c => c.type === 'tool_call_start')
    expect(toolStart).toBeDefined()
    if (toolStart?.type === 'tool_call_start') {
      expect(toolStart.toolName).toBe('bash')
      expect(toolStart.toolCallId).toBe('tool-1')
    }

    const toolResult = chunks.find(c => c.type === 'tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toBe('hello\n')
      expect(toolResult.isError).toBe(false)
    }
  })

  it('handles agent errors gracefully', async () => {
    mockPromptFn = async () => {
      emit({ type: 'agent_start' })
      throw new Error('Connection refused')
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find(c => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type === 'error') {
      expect(errorChunk.code).toBe('agent_error')
      expect(errorChunk.message).toContain('Connection refused')
    }
  })

  it('maps thinking events from assistantMessageEvent', async () => {
    mockPromptFn = async () => {
      emit({ type: 'agent_start' })
      emit({
        type: 'message_start',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
      })
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
        assistantMessageEvent: { type: 'thinking_start' },
      })
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
        assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me think...' },
      })
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
        assistantMessageEvent: { type: 'thinking_end' },
      })
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], timestamp: Date.now() },
        assistantMessageEvent: { type: 'text_delta', delta: 'Answer' },
      })
      emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], timestamp: Date.now() },
      })
      emit({
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], timestamp: Date.now(), usage: { input: 30, output: 15 } },
        ],
      })
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('think', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const types = chunks.map(c => c.type)
    expect(types).toContain('thinking_start')
    expect(types).toContain('thinking')
    expect(types).toContain('thinking_done')
    expect(types).toContain('text_delta')
  })

  it('passes model option to Agent', async () => {
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      model: 'qwen3-max',
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    // Verify model was set on agent state
    expect(mockAgentState.model).toBeDefined()
    expect(mockAgentState.model.id).toBe('qwen3-max')
  })

  it('maps error streaming events', async () => {
    mockPromptFn = async () => {
      emit({ type: 'agent_start' })
      emit({
        type: 'message_start',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
      })
      emit({
        type: 'message_update',
        message: { role: 'assistant', content: [], timestamp: Date.now() },
        assistantMessageEvent: { type: 'error', reason: 'rate_limited' },
      })
      emit({
        type: 'agent_end',
        messages: [],
      })
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const errorChunk = chunks.find(c => c.type === 'error')
    expect(errorChunk).toBeDefined()
    if (errorChunk?.type === 'error') {
      expect(errorChunk.code).toBe('stream_error')
      expect(errorChunk.message).toBe('rate_limited')
    }
  })

  it('sets system prompt from string option', async () => {
    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('hi', '/tmp', undefined, {
      systemPrompt: 'You are a helpful assistant',
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    expect(mockAgentState.systemPrompt).toBe('You are a helpful assistant')
  })

  it('handles tool_execution_end with error flag', async () => {
    mockPromptFn = async () => {
      emit({ type: 'agent_start' })
      emit({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: Date.now() } })
      emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-2',
        toolName: 'bash',
        args: { command: 'rm /' },
      })
      emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-2',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'Permission denied' }] },
        isError: true,
      })
      emit({ type: 'message_end', message: { role: 'assistant', content: [], timestamp: Date.now() } })
      emit({
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Failed' }], timestamp: Date.now(), usage: { input: 10, output: 5 } },
        ],
      })
    }

    const chunks: MessageChunk[] = []
    for await (const chunk of provider.sendQuery('rm /', '/tmp', undefined, {
      env: { DASHSCOPE_API_KEY: 'test-key' },
    })) {
      chunks.push(chunk)
    }

    const toolResult = chunks.find(c => c.type === 'tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(true)
      expect(toolResult.content).toBe('Permission denied')
    }
  })
})
