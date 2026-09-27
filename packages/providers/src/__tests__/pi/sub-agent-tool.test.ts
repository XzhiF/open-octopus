import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OctopusAgentDef } from '../../types'

// 957f1bad redesigned sub-agent tools into Pi-SDK customTools format:
// allowedTools/maxDepth/executionMode metadata fields were removed; the
// whitelist and the nesting guard now live INSIDE tool.execute() (session
// options + early-return). Tests below assert that current behavior.

const hoisted = vi.hoisted(() => ({
  createSession: vi.fn(),
  promptSession: vi.fn(),
  disposeSession: vi.fn(),
}))

vi.mock('../../pi/pi-sdk-adapter', () => ({
  createSession: hoisted.createSession,
  promptSession: hoisted.promptSession,
  disposeSession: hoisted.disposeSession,
}))
vi.mock('../../pi/security', () => ({
  buildSessionEnv: () => ({}),
}))
vi.mock('../../pi/extensions/octopus-hooks', () => ({
  createOctopusHooks: () => ({}),
}))

import { toSubAgentTool } from '../../pi/extensions/sub-agent-tool'

function makeSession() {
  return {
    agent: {
      state: {
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'sub result' }] },
        ],
      },
    },
  }
}

describe('SubAgent Tool (S13)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.createSession.mockResolvedValue({ session: makeSession() })
    hoisted.promptSession.mockResolvedValue(undefined)
  })

  it('creates tool with delegate_to_ prefix (TC-031)', () => {
    const def: OctopusAgentDef = {
      description: 'Research expert',
      prompt: 'You are a researcher.',
    }
    const tool = toSubAgentTool('researcher', def, '/tmp', {})
    expect(tool.name).toBe('delegate_to_researcher')
    expect(tool.description).toContain('Research expert')
  })

  it('respects tools whitelist — lowercased tools passed to Pi session (957f1bad)', async () => {
    const def: OctopusAgentDef = {
      description: 'Limited agent',
      prompt: 'You can only read files.',
      tools: ['Read', 'Grep'],
    }
    const tool = toSubAgentTool('reader', def, '/tmp', {})
    await tool.execute('t1', { task: 'do it' })

    expect(hoisted.createSession).toHaveBeenCalledTimes(1)
    const opts = hoisted.createSession.mock.calls[0][0]
    // PascalCase (Claude convention) mapped to lowercase (Pi convention)
    expect(opts.tools).toEqual(['read', 'grep'])
    expect(opts.systemPrompt).toBe('You can only read files.')
  })

  it('blocks nesting depth > 1 (TC-033)', async () => {
    const def: OctopusAgentDef = {
      description: 'Nested agent',
      prompt: 'Test',
    }
    const tool = toSubAgentTool('nested', def, '/tmp', { depth: 1 })
    const result = await tool.execute('t1', { task: 'do it' })

    // Guard returns an error text and never opens a nested session
    expect(result.content[0].text).toContain('Sub-agent nesting depth exceeded')
    expect(hoisted.createSession).not.toHaveBeenCalled()
  })

  it('exposes Pi-SDK customTools shape (parameters schema + execute)', () => {
    const def: OctopusAgentDef = {
      description: 'Background worker',
      prompt: 'Work in background.',
      background: true,
    }
    const tool = toSubAgentTool('worker', def, '/tmp', {})
    // Pi SDK registers tools via name/label/parameters/execute; the old
    // executionMode metadata no longer exists in this contract.
    expect(tool.label).toBe('delegate_to_worker')
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    })
    expect(typeof tool.execute).toBe('function')
  })
})
