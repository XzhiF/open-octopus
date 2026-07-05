import { describe, it, expect } from 'vitest'
import { CallerContext } from '../resource/security'

describe('CallerContext (Agent gating)', () => {
  it('human caller can install without --confirmed', () => {
    const ctx = new CallerContext({})
    expect(ctx.caller).toBe('human')
    expect(ctx.requireConfirmation(false)).toBe(true)
  })

  it('agent caller rejected without --confirmed', () => {
    const ctx = new CallerContext({ OCTOPUS_CALLER: 'agent' })
    expect(ctx.caller).toBe('agent')
    expect(ctx.isAgent()).toBe(true)
    expect(ctx.requireConfirmation(false)).toBe(false)
  })

  it('agent caller accepted with --confirmed', () => {
    const ctx = new CallerContext({ OCTOPUS_CALLER: 'agent' })
    expect(ctx.requireConfirmation(true)).toBe(true)
  })
})
