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

  it('multi-provider registration routes correctly (S10 integration)', async () => {
    // Register a second faux provider under a different engine key
    const fauxClaude = new FauxPiProvider([
      { type: 'text_delta', content: 'Claude response', messageId: 'c-1' },
      { type: 'result', content: 'Claude response', sessionId: 'claude-session' },
    ])
    registerProvider('claude', () => fauxClaude as any)

    const piProvider = getProvider('pi')
    const claudeProvider = getProvider('claude')

    expect(piProvider.getType()).toBe('pi')

    const piChunks: any[] = []
    for await (const c of piProvider.sendQuery('test', '/tmp')) piChunks.push(c)
    const piResult = piChunks.find(c => c.type === 'result')
    expect(piResult?.content).toContain('faux provider')

    const claudeChunks: any[] = []
    for await (const c of claudeProvider.sendQuery('test', '/tmp')) claudeChunks.push(c)
    const claudeResult = claudeChunks.find(c => c.type === 'result')
    expect(claudeResult?.content).toBe('Claude response')
  })

  it('vars_update faux E2E: text with embedded vars block (S15 integration)', async () => {
    const varsContent = 'Analysis complete.\n\n```vars_update\n{"status": "done", "score": 95}\n```'
    resetProviderInstances()
    registerProvider('pi', () => new FauxPiProvider([
      { type: 'message_start', messageId: 'v-1' },
      { type: 'text_delta', content: varsContent, messageId: 'v-1' },
      { type: 'text_done', messageId: 'v-1' },
      { type: 'message_stop', messageId: 'v-1' },
      { type: 'result', content: varsContent, sessionId: 'vars-session', tokens: { input: 5, output: 10, total: 15 } },
    ]) as any)

    const provider = getProvider('pi')
    const chunks: any[] = []
    for await (const c of provider.sendQuery('Analyze', '/tmp')) chunks.push(c)

    // Verify text content
    const textDeltas = chunks.filter(c => c.type === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(0)
    expect(textDeltas[0].content).toContain('vars_update')

    // Verify result chunk has token info
    const result = chunks.find(c => c.type === 'result')
    expect(result).toBeDefined()
    expect(result.tokens?.total).toBe(15)
  })

  it('provider instance isolation across reset (S10 E2E)', async () => {
    // Verify that resetProviderInstances clears cached instances
    const provider1 = getProvider('pi')
    expect(provider1).toBeDefined()
    expect(provider1.getType()).toBe('pi')

    resetProviderInstances()

    // Register a different faux provider after reset
    const customChunks = [
      { type: 'result', content: 'post-reset provider', sessionId: 'reset-session' },
    ]
    registerProvider('pi', () => new FauxPiProvider(customChunks) as any)
    const provider2 = getProvider('pi')
    expect(provider2).toBeDefined()

    const chunks: any[] = []
    for await (const c of provider2.sendQuery('test', '/tmp')) chunks.push(c)
    const result = chunks.find(c => c.type === 'result')
    expect(result?.content).toBe('post-reset provider')
  })

  it('token aggregation across multiple calls (S04 E2E)', async () => {
    const provider = getProvider('pi')

    let totalTokens = 0
    for (let i = 0; i < 3; i++) {
      const chunks: any[] = []
      for await (const c of provider.sendQuery(`query ${i}`, '/tmp')) chunks.push(c)
      const result = chunks.find(c => c.type === 'result')
      if (result?.tokens) totalTokens += result.tokens.total ?? 0
    }

    expect(totalTokens).toBe(75) // 25 * 3 calls
  })

  it('S17-4: second provider validation — cross-engine routing with faux providers (TC-042b)', async () => {
    // Simulate two different provider engines handling queries independently
    // This validates that the registry correctly routes to different providers by engine type
    resetProviderInstances()

    const fauxPi = new FauxPiProvider([
      { type: 'message_start', messageId: 'pi-msg-1' },
      { type: 'text_delta', content: 'Pi engine response', messageId: 'pi-msg-1' },
      { type: 'result', content: 'Pi engine response', sessionId: 'pi-sess-1', tokens: { input: 10, output: 5, total: 15 } },
    ])
    const fauxClaude = new FauxPiProvider([
      { type: 'text_delta', content: 'Claude engine response', messageId: 'cl-msg-1' },
      { type: 'result', content: 'Claude engine response', sessionId: 'cl-sess-1', tokens: { input: 20, output: 10, total: 30 } },
    ])

    registerProvider('pi', () => fauxPi as any)
    registerProvider('claude', () => fauxClaude as any)

    // Query pi provider
    const piChunks: any[] = []
    for await (const c of getProvider('pi').sendQuery('test', '/tmp')) piChunks.push(c)
    const piResult = piChunks.find(c => c.type === 'result')
    expect(piResult?.content).toBe('Pi engine response')
    expect(piResult?.tokens?.total).toBe(15)

    // Query claude provider — different engine, different result
    const claudeChunks: any[] = []
    for await (const c of getProvider('claude').sendQuery('test', '/tmp')) claudeChunks.push(c)
    const claudeResult = claudeChunks.find(c => c.type === 'result')
    expect(claudeResult?.content).toBe('Claude engine response')
    expect(claudeResult?.tokens?.total).toBe(30)

    // Verify providers are distinct instances
    expect(getProvider('pi')).not.toBe(getProvider('claude'))
  })

  it('S17-5: swarm mixed provider — multi-node workflow with different providers (TC-043b)', async () => {
    // Simulate a swarm-style workflow where different nodes use different provider engines
    // This validates the multi-provider DAG pattern used in Swarm execution
    resetProviderInstances()

    // Set up three different providers for different swarm roles
    const hostProvider = new FauxPiProvider([
      { type: 'text_delta', content: 'Host: coordinating experts', messageId: 'h-1' },
      { type: 'result', content: 'Host: coordinating experts', sessionId: 'host-1' },
    ])
    const expertAProvider = new FauxPiProvider([
      { type: 'text_delta', content: 'Expert A: architecture analysis complete', messageId: 'a-1' },
      { type: 'result', content: 'Expert A: architecture analysis complete', sessionId: 'expert-a-1' },
    ])
    const expertBProvider = new FauxPiProvider([
      { type: 'text_delta', content: 'Expert B: security review passed', messageId: 'b-1' },
      { type: 'result', content: 'Expert B: security review passed', sessionId: 'expert-b-1' },
    ])

    registerProvider('pi', () => hostProvider as any)
    registerProvider('claude', () => expertAProvider as any)
    registerProvider('openai', () => expertBProvider as any)

    // Simulate swarm dispatch: host coordinates, experts respond
    const swarmResults: string[] = []

    // Phase 1: Experts respond in parallel (dispatch mode)
    for (const [engine, prompt] of [['claude', 'analyze architecture'], ['openai', 'review security']] as const) {
      const provider = getProvider(engine)
      const chunks: any[] = []
      for await (const c of provider.sendQuery(prompt, '/tmp')) chunks.push(c)
      const result = chunks.find(c => c.type === 'result')
      swarmResults.push(result?.content ?? '')
    }

    // Phase 2: Host synthesizes expert outputs
    const hostProvider2 = getProvider('pi')
    const hostChunks: any[] = []
    const synthesisPrompt = `Synthesize: ${swarmResults.join(' | ')}`
    for await (const c of hostProvider2.sendQuery(synthesisPrompt, '/tmp')) hostChunks.push(c)
    const hostResult = hostChunks.find(c => c.type === 'result')
    swarmResults.push(hostResult?.content ?? '')

    // Verify all three providers contributed
    expect(swarmResults).toHaveLength(3)
    expect(swarmResults[0]).toContain('Expert A')
    expect(swarmResults[1]).toContain('Expert B')
    expect(swarmResults[2]).toContain('Host')
  })
})
