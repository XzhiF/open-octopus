import { describe, it, expect, vi } from 'vitest'
import { resolveModel } from '../pi/model-resolver'

function makeRegistry(models: Array<{ id: string; provider: string; name?: string }>) {
  return {
    find: vi.fn((provider: string, id: string) => models.find(m => m.provider === provider && m.id === id) ?? null),
    getAll: vi.fn(() => models),
  }
}

describe('resolveModel', () => {
  it('resolves provider/model-id format', () => {
    const reg = makeRegistry([{ id: 'gpt-4o', provider: 'openai' }])
    expect(resolveModel('openai/gpt-4o', reg)).toEqual({ id: 'gpt-4o', provider: 'openai' })
    expect(reg.find).toHaveBeenCalledWith('openai', 'gpt-4o')
  })

  it('searches all providers when no prefix', () => {
    const reg = makeRegistry([{ id: 'gpt-4o', provider: 'openai' }])
    expect(resolveModel('gpt-4o', reg)).toEqual({ id: 'gpt-4o', provider: 'openai' })
  })

  it('returns undefined for unknown model', () => {
    expect(resolveModel('unknown-model', makeRegistry([]))).toBeUndefined()
  })

  it('returns first match with ambiguity warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reg = makeRegistry([
      { id: 'gpt-4o', provider: 'openai' },
      { id: 'gpt-4o', provider: 'azure-openai' },
    ])
    expect(resolveModel('gpt-4o', reg)).toEqual({ id: 'gpt-4o', provider: 'openai' })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns undefined for undefined input', () => {
    expect(resolveModel(undefined, makeRegistry([]))).toBeUndefined()
  })
})
