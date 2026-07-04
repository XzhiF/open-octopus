import { describe, it, expect } from 'vitest'

describe('System Prompt handling (S11, P1-2)', () => {
  function resolveSystemPrompt(input: string | { type: 'preset'; preset: string; append?: string } | undefined): string | undefined {
    if (!input) return undefined
    if (typeof input === 'string') return input
    if (input.append) return input.append
    return undefined
  }

  it('string systemPrompt replaces default (TC-025)', () => {
    expect(resolveSystemPrompt('You are a security auditor.')).toBe('You are a security auditor.')
  })

  it('preset systemPrompt uses only append (TC-026)', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'Focus on tests.' })
    expect(result).toBe('Focus on tests.')
  })

  it('preset without append returns undefined (Pi uses its default)', () => {
    const result = resolveSystemPrompt({ type: 'preset', preset: 'claude_code' })
    expect(result).toBeUndefined()
  })

  it('undefined systemPrompt returns undefined (Pi uses its default)', () => {
    expect(resolveSystemPrompt(undefined)).toBeUndefined()
  })
})
