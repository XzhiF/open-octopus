import { describe, it, expect } from 'vitest'
import { ModelAliasConfigSchema, isModelTier } from '../types/model-alias'

describe('ModelAliasConfigSchema', () => {
  it('parses valid config', () => {
    const config = ModelAliasConfigSchema.parse({
      default: 'pro',
      providers: {
        pi: { 'pro-max': 'anthropic/claude-opus-4-20250514', pro: 'anthropic/claude-sonnet-4-20250514', se: 'anthropic/claude-haiku-4-5-20251001' },
      },
    })
    expect(config.default).toBe('pro')
    expect(config.providers.pi['pro-max']).toBe('anthropic/claude-opus-4-20250514')
  })

  it('applies defaults for missing fields', () => {
    const config = ModelAliasConfigSchema.parse({})
    expect(config.default).toBe('pro')
    expect(config.providers).toEqual({})
  })
})

describe('isModelTier', () => {
  it('recognizes tier values', () => {
    expect(isModelTier('pro-max')).toBe(true)
    expect(isModelTier('pro')).toBe(true)
    expect(isModelTier('se')).toBe(true)
  })

  it('rejects non-tier values', () => {
    expect(isModelTier('sonnet')).toBe(false)
    expect(isModelTier('openai/gpt-4o')).toBe(false)
    expect(isModelTier('')).toBe(false)
  })
})
