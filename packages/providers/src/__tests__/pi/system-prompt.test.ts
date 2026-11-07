import { describe, it, expect } from 'vitest'
import { resolveSystemPrompt } from '../../pi/provider'

describe('System Prompt handling (S11, P1-2)', () => {
  it('string systemPrompt replaces default (TC-025)', () => {
    expect(resolveSystemPrompt('You are a security auditor.')).toBe('You are a security auditor.')
  })

  it('preset systemPrompt injects Octopus identity and appends user prompt (TC-026)', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'Focus on tests.' })
    expect(result).toContain('You are running on the Octopus platform.')
    expect(result).toContain('Focus on tests.')
  })

  it('preset without append still carries the Octopus identity', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code' })
    expect(result).toContain('You are running on the Octopus platform.')
  })

  it('preset includes the resolved model name when given', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code' }, 'my-ai/glm-5.2')
    expect(result).toContain('Your underlying model is my-ai/glm-5.2.')
  })

  it('undefined systemPrompt returns undefined (Pi uses its default)', () => {
    expect(resolveSystemPrompt(undefined)).toBeUndefined()
  })
})
