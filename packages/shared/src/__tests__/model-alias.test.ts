import { describe, it, expect } from 'vitest'
import { ModelAliasConfigSchema, DEFAULT_MODEL_ALIASES, resolveModelAlias, loadModelAliasConfig, collectNodeEngines } from '../config/model-alias'
import type { ModelAliasConfig } from '../config/model-alias'

describe('ModelAliasConfig', () => {
  it('validates a correct config', () => {
    const raw = {
      default: 'pro',
      providers: {
        claude: { 'pro-max': 'opus', pro: 'sonnet', se: 'haiku' },
        pi: { 'pro-max': 'anthropic/claude-opus-4-20250514', pro: 'anthropic/claude-sonnet-4-20250514' },
      },
    }
    const result = ModelAliasConfigSchema.parse(raw)
    expect(result.default).toBe('pro')
    expect(result.providers.pi['pro-max']).toBe('anthropic/claude-opus-4-20250514')
  })

  it('DEFAULT_MODEL_ALIASES has claude and pi providers', () => {
    expect(DEFAULT_MODEL_ALIASES.providers.claude).toBeDefined()
    expect(DEFAULT_MODEL_ALIASES.providers.pi).toBeDefined()
    expect(DEFAULT_MODEL_ALIASES.default).toBe('pro')
  })
})

describe('resolveModelAlias', () => {
  const config = DEFAULT_MODEL_ALIASES

  it('resolves tier "pro" for provider "pi" (TC-001)', () => {
    const result = resolveModelAlias('pro', 'pi', config)
    expect(result).toBe('anthropic/claude-sonnet-4-20250514')
  })

  it('passes through non-tier strings unchanged (TC-002)', () => {
    expect(resolveModelAlias('openai/gpt-4o', 'pi', config)).toBe('openai/gpt-4o')
  })

  it('resolves tier for "claude" provider', () => {
    expect(resolveModelAlias('pro-max', 'claude', config)).toBe('opus')
  })

  it('resolves dashscope tiers', () => {
    expect(resolveModelAlias('pro-max', 'dashscope', config)).toBe('dashscope/qwen3.7-max')
    expect(resolveModelAlias('pro', 'dashscope', config)).toBe('dashscope/qwen3.7-plus')
    expect(resolveModelAlias('se', 'dashscope', config)).toBe('dashscope/qwen3.6-plus')
  })

  it('returns model as-is when provider has no mapping for tier', () => {
    expect(resolveModelAlias('pro', 'unknown-provider', config)).toBe('pro')
  })

  it('uses default tier when model is undefined', () => {
    expect(resolveModelAlias(undefined, 'pi', config)).toBe('anthropic/claude-sonnet-4-20250514')
  })

  it('handles circular aliases with depth guard', () => {
    const circular: ModelAliasConfig = {
      default: 'a',
      providers: { test: { a: 'b', b: 'a' } },
    }
    const result = resolveModelAlias('a', 'test', circular)
    expect(typeof result).toBe('string')
  })
})

describe('loadModelAliasConfig', () => {
  it('returns defaults when no file exists', () => {
    const config = loadModelAliasConfig({ orgDir: '/nonexistent', globalDir: '/nonexistent2' })
    expect(config).toEqual(DEFAULT_MODEL_ALIASES)
  })
})

describe('collectNodeEngines (F-1)', () => {
  it('collects engines from flat nodes', () => {
    const nodes = [
      { id: 'a', type: 'agent', engine: 'pi' },
      { id: 'b', type: 'agent', engine: 'claude' },
      { id: 'c', type: 'agent' },
      { id: 'd', type: 'bash' },
    ]
    const engines = collectNodeEngines(nodes)
    expect(engines).toContain('pi')
    expect(engines).toContain('claude')
    expect(engines.length).toBe(2)
  })

  it('collects engines from swarm experts', () => {
    const nodes = [{
      id: 'swarm1', type: 'swarm',
      experts: [
        { name: 'architect', engine: 'pi' },
        { name: 'reviewer', engine: 'claude' },
      ],
    }]
    const engines = collectNodeEngines(nodes)
    expect(engines).toContain('pi')
    expect(engines).toContain('claude')
  })

  it('returns ["claude"] for empty nodes', () => {
    expect(collectNodeEngines([])).toEqual(['claude'])
  })
})
