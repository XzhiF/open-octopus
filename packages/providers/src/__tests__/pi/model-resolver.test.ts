import { describe, it, expect } from 'vitest'
import { resolveModel } from '../../pi/model-resolver'

describe('ModelResolver', () => {
  const mockRegistry = {
    getProviderNames: () => ['openai', 'anthropic', 'dashscope'],
    getModel: (provider: string, modelId: string) => {
      const models: Record<string, Record<string, any>> = {
        openai: { 'gpt-4o': { provider: 'openai', id: 'gpt-4o' } },
        anthropic: { 'claude-sonnet-4-20250514': { provider: 'anthropic', id: 'claude-sonnet-4-20250514' } },
        dashscope: { 'qwen3-max': { provider: 'dashscope', id: 'qwen3-max' } },
      }
      return models[provider]?.[modelId] ?? null
    },
  }

  it('resolves "provider/model-id" format (TC-012)', () => {
    const result = resolveModel('openai/gpt-4o', mockRegistry as any)
    expect(result).toEqual({ provider: 'openai', id: 'gpt-4o' })
  })

  it('returns undefined for undefined input (TC-013)', () => {
    expect(resolveModel(undefined, mockRegistry as any)).toBeUndefined()
  })

  it('returns undefined for unknown model', () => {
    expect(resolveModel('unknown/model', mockRegistry as any)).toBeUndefined()
  })

  it('resolves short-name aliases via MODEL_ALIASES (P1-1)', () => {
    const result = resolveModel('sonnet', mockRegistry as any)
    expect(result).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-20250514' })
  })
})
