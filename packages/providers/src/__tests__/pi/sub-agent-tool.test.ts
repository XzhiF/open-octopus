import { describe, it, expect } from 'vitest'
import { toSubAgentTool } from '../../pi/extensions/sub-agent-tool'
import type { OctopusAgentDef } from '../../types'

describe('SubAgent Tool (S13)', () => {
  it('creates tool with delegate_to_ prefix (TC-031)', () => {
    const def: OctopusAgentDef = {
      description: 'Research expert',
      prompt: 'You are a researcher.',
    }
    const tool = toSubAgentTool('researcher', def, '/tmp', {})
    expect(tool.name).toBe('delegate_to_researcher')
    expect(tool.description).toContain('Research expert')
  })

  it('respects tools whitelist', () => {
    const def: OctopusAgentDef = {
      description: 'Limited agent',
      prompt: 'You can only read files.',
      tools: ['Read', 'Grep'],
    }
    const tool = toSubAgentTool('reader', def, '/tmp', {})
    expect(tool.allowedTools).toEqual(['Read', 'Grep'])
  })

  it('blocks nesting depth > 1 (TC-033)', () => {
    const def: OctopusAgentDef = {
      description: 'Nested agent',
      prompt: 'Test',
    }
    const tool = toSubAgentTool('nested', def, '/tmp', { depth: 1 })
    expect(tool.maxDepth).toBe(1)
  })

  it('background: true maps to parallel execution', () => {
    const def: OctopusAgentDef = {
      description: 'Background worker',
      prompt: 'Work in background.',
      background: true,
    }
    const tool = toSubAgentTool('worker', def, '/tmp', {})
    expect(tool.executionMode).toBe('parallel')
  })
})
