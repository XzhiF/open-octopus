import { describe, it, expect } from 'vitest'
import { resolveSystemPrompt } from '../../pi/provider'

// Octopus identity guard — injected by resolveSystemPrompt for preset mode
// (contract established in 4cf20866 "fix: Pi provider 全链路修复 — 身份注入").
const IDENTITY = 'You are running on the Octopus platform. When asked about your identity or model, always state this model name. Do not claim to be Claude, GPT, or any other model.'

describe('System Prompt handling (S11, P1-2)', () => {
  it('string systemPrompt replaces default (TC-025)', () => {
    expect(resolveSystemPrompt('You are a security auditor.')).toBe('You are a security auditor.')
  })

  it('preset systemPrompt returns identity guard + append (TC-026)', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'Focus on tests.' })
    expect(result).toBe(`${IDENTITY}\n\nFocus on tests.`)
  })

  it('preset without append still returns the identity guard (never undefined)', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code' })
    expect(result).toBe(IDENTITY)
  })

  it('preset with modelId embeds the resolved model name in the guard', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code' }, 'my-ai/glm-5.2')
    expect(result).toContain('Your underlying model is my-ai/glm-5.2.')
    expect(result).toContain('You are running on the Octopus platform.')
  })

  it('undefined input returns undefined (no system prompt)', () => {
    expect(resolveSystemPrompt(undefined)).toBeUndefined()
  })
})
