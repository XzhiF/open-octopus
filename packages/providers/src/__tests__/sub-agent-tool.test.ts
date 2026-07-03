import { describe, it, expect, vi } from 'vitest'
import { createSubAgentTools } from '../pi/extensions/sub-agent-tool'

function makeOpts(overrides: Partial<Parameters<typeof createSubAgentTools>[0]> = {}) {
  return {
    agents: {
      reviewer: { description: 'Review code', prompt: 'You are a reviewer.' },
      tester: { description: 'Test code', prompt: 'You are a tester.', model: 'sonnet' },
    },
    createSession: vi.fn().mockResolvedValue({
      prompt: vi.fn().mockResolvedValue('done'),
    }),
    cwd: '/tmp/project',
    ...overrides,
  }
}

describe('SubAgentTool', () => {
  it('creates delegate_to_{name} tools for each agent', () => {
    const tools = createSubAgentTools(makeOpts())
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('delegate_to_reviewer')
    expect(tools[1].name).toBe('delegate_to_tester')
    expect(tools[0].description).toBe('Review code')
    expect(tools[1].inputSchema.required).toEqual(['task'])
  })

  it('executes task and returns result text', async () => {
    const promptFn = vi.fn().mockResolvedValue('review result')
    const createSession = vi.fn().mockResolvedValue({ prompt: promptFn })
    const tools = createSubAgentTools(makeOpts({ createSession }))

    const result = await tools[0].execute({ task: 'check types' })
    expect(result).toEqual({ content: 'review result' })
    expect(createSession).toHaveBeenCalledWith('/tmp/project', { model: undefined })
    expect(promptFn).toHaveBeenCalledWith(expect.stringContaining('Task: check types'))
    expect(promptFn).toHaveBeenCalledWith(expect.stringContaining('You are a reviewer.'))
  })

  it('passes model option from agent definition', async () => {
    const createSession = vi.fn().mockResolvedValue({ prompt: vi.fn().mockResolvedValue('ok') })
    const tools = createSubAgentTools(makeOpts({ createSession }))

    await tools[1].execute({ task: 'test it' })
    expect(createSession).toHaveBeenCalledWith('/tmp/project', { model: 'sonnet' })
  })

  it('returns error content when session creation fails', async () => {
    const createSession = vi.fn().mockRejectedValue(new Error('API key missing'))
    const tools = createSubAgentTools(makeOpts({ createSession }))

    const result = await tools[0].execute({ task: 'fail' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('API key missing')
  })

  it('returns error content when prompt throws', async () => {
    const promptFn = vi.fn().mockRejectedValue(new Error('network error'))
    const createSession = vi.fn().mockResolvedValue({ prompt: promptFn })
    const tools = createSubAgentTools(makeOpts({ createSession }))

    const result = await tools[0].execute({ task: 'will fail' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('network error')
  })

  it('extracts text from structured result with messages array', async () => {
    const structuredResult = {
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: [{ type: 'text', text: 'structured answer' }] },
      ],
    }
    const promptFn = vi.fn().mockResolvedValue(structuredResult)
    const createSession = vi.fn().mockResolvedValue({ prompt: promptFn })
    const tools = createSubAgentTools(makeOpts({ createSession }))

    const result = await tools[0].execute({ task: 'extract test' })
    expect(result).toEqual({ content: 'structured answer' })
  })
})
