import { describe, it, expect } from 'vitest'
import { resolveSystemPrompt } from '../pi/pi-agent-provider'

describe('resolveSystemPrompt (TC-048 ~ TC-050)', () => {
  it('string override (TC-048)', () => {
    expect(resolveSystemPrompt('You are a security expert.')).toBe('You are a security expert.')
  })

  it('preset ignores claude_code, takes append only (TC-049)', () => {
    expect(resolveSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'extra instructions' }))
      .toBe('extra instructions')
  })

  it('preset without append returns undefined', () => {
    expect(resolveSystemPrompt({ type: 'preset', preset: 'claude_code' })).toBeUndefined()
  })

  it('empty string treated as undefined (TC-050)', () => {
    expect(resolveSystemPrompt('')).toBeUndefined()
  })

  it('undefined input returns undefined', () => {
    expect(resolveSystemPrompt(undefined)).toBeUndefined()
  })
})
