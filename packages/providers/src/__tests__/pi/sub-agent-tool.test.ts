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

  it('declares a task parameter schema', () => {
    const def: OctopusAgentDef = {
      description: 'Limited agent',
      prompt: 'You can only read files.',
      tools: ['Read', 'Grep'],
    }
    const tool = toSubAgentTool('reader', def, '/tmp', {})
    expect(tool.parameters.required).toEqual(['task'])
    expect(tool.parameters.properties.task.type).toBe('string')
  })

  it('blocks nesting depth > 1 (TC-033)', async () => {
    const def: OctopusAgentDef = {
      description: 'Nested agent',
      prompt: 'Test',
    }
    const tool = toSubAgentTool('nested', def, '/tmp', { depth: 1 })
    const result = await tool.execute('call-1', { task: 'delegate again' })
    expect(result.content[0].text).toContain('nesting depth exceeded')
  })
})
