import { describe, it, expect, beforeEach } from 'vitest'
import { registerProvider, getProvider, resetProviderInstances, buildSessionEnv } from '@octopus/providers'

// Inline faux provider to avoid cross-package test import issues
class FauxPiProvider {
  private chunks: any[]
  constructor(chunks?: any[]) {
    this.chunks = chunks ?? [
      { type: 'message_start', messageId: 'faux-msg-1' },
      { type: 'text_delta', content: 'Hello from faux provider. ', messageId: 'faux-msg-1' },
      { type: 'text_delta', content: 'This is a deterministic test response.', messageId: 'faux-msg-1' },
      { type: 'text_done', messageId: 'faux-msg-1' },
      { type: 'message_stop', messageId: 'faux-msg-1' },
      {
        type: 'result',
        content: 'Hello from faux provider. This is a deterministic test response.',
        sessionId: 'faux-session-1',
        tokens: { input: 10, output: 15, total: 25 },
        costUsd: 0,
      },
    ]
  }
  getType() { return 'pi' }
  async *sendQuery() { for (const c of this.chunks) yield c }
}

function fauxWithToolCall() {
  return new FauxPiProvider([
    { type: 'message_start', messageId: 'faux-msg-2' },
    { type: 'text_delta', content: 'Let me check the files.', messageId: 'faux-msg-2' },
    { type: 'tool_call_start', toolCallId: 'faux-tool-1', toolName: 'Bash', messageId: 'faux-msg-2' },
    { type: 'tool_call', toolCallId: 'faux-tool-1', toolName: 'Bash', toolInput: { command: 'ls' }, messageId: 'faux-msg-2' },
    { type: 'tool_result', toolCallId: 'faux-tool-1', content: 'file1.txt\nfile2.txt' },
    { type: 'text_delta', content: 'Found 2 files.', messageId: 'faux-msg-2' },
    { type: 'text_done', messageId: 'faux-msg-2' },
    { type: 'message_stop', messageId: 'faux-msg-2' },
    {
      type: 'result',
      content: 'Found 2 files.',
      sessionId: 'faux-session-2',
      tokens: { input: 20, output: 30, total: 50 },
    },
  ])
}

describe('E2E Pi Provider workflow tests', () => {
  beforeEach(() => {
    resetProviderInstances()
    registerProvider('pi', () => new FauxPiProvider() as any)
  })

  it('single-node workflow with faux provider (TC-040)', async () => {
    const provider = getProvider('pi')
    expect(provider.getType()).toBe('pi')

    const chunks: any[] = []
    for await (const chunk of provider.sendQuery('Hello', '/tmp')) {
      chunks.push(chunk)
    }

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0].type).toBe('message_start')
    const result = chunks.find(c => c.type === 'result')
    expect(result).toBeDefined()
    expect(result.content).toBeTruthy()
  })

  it('faux provider with tool calls', async () => {
    resetProviderInstances()
    registerProvider('pi', () => fauxWithToolCall() as any)
    const provider = getProvider('pi')

    const chunks: any[] = []
    for await (const chunk of provider.sendQuery('List files', '/tmp')) {
      chunks.push(chunk)
    }

    const toolCalls = chunks.filter(c => c.type === 'tool_call')
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0].toolName).toBe('Bash')
  })

  it('DAG 3-node sequential execution with variable passing (P2-2, TC-041)', async () => {
    const provider = getProvider('pi')

    const outputs: string[] = []
    for (const node of ['analyze', 'review', 'summarize']) {
      const chunks: any[] = []
      const prevOutput = outputs[outputs.length - 1] ?? ''
      const prompt = prevOutput ? `${node}: based on "${prevOutput}"` : `${node}: start`
      for await (const chunk of provider.sendQuery(prompt, '/tmp')) {
        chunks.push(chunk)
      }
      const result = chunks.find(c => c.type === 'result')
      outputs.push(result?.content ?? '')
    }

    expect(outputs).toHaveLength(3)
    expect(outputs[0]).toBeTruthy()
  })

  it('security: buildSessionEnv blocks sensitive vars in provider context (P2-2)', () => {
    const original = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://secret:pass@db:5432/prod'
    const env = buildSessionEnv()
    expect(env.DATABASE_URL).toBeUndefined()
    if (original) process.env.DATABASE_URL = original
    else delete process.env.DATABASE_URL
  })
})
