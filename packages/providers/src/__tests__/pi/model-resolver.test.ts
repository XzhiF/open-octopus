import { describe, it, expect } from 'vitest'
import { resolveModel } from '../../pi/model-resolver'

describe('ModelResolver', () => {
  const allModels = [
    { provider: 'openai', id: 'gpt-4o' },
    { provider: 'openai', id: 'gpt-4o-mini' },
    { provider: 'anthropic', id: 'claude-sonnet-4-20250514' },
    { provider: 'dashscope', id: 'qwen3-max' },
    { provider: 'dashscope', id: 'qwen3.7-max' },
  ]

  const mockRegistry = {
    find: (provider: string, modelId: string) => {
      return allModels.find(m => m.provider === provider && m.id === modelId) ?? undefined
    },
    getAll: () => allModels,
  }

  it('resolves "provider/model-id" format via find()', () => {
    const result = resolveModel('openai/gpt-4o', mockRegistry as any)
    expect(result).toEqual({ provider: 'openai', id: 'gpt-4o' })
  })

  it('returns undefined for undefined input', () => {
    expect(resolveModel(undefined, mockRegistry as any)).toBeUndefined()
  })

  it('returns undefined for unknown provider/model-id', () => {
    expect(resolveModel('unknown/model', mockRegistry as any)).toBeUndefined()
  })

  it('resolves bare model id via getAll() search', () => {
    expect(resolveModel('gpt-4o', mockRegistry as any)).toEqual({ provider: 'openai', id: 'gpt-4o' })
    expect(resolveModel('qwen3.7-max', mockRegistry as any)).toEqual({ provider: 'dashscope', id: 'qwen3.7-max' })
  })

  it('returns undefined for unknown bare model id', () => {
    expect(resolveModel('nonexistent-model', mockRegistry as any)).toBeUndefined()
  })
})
