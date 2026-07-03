import { describe, it, expect, vi } from 'vitest'
import type { ModelAliasConfig } from '../types/model-alias'
import yaml from 'js-yaml'

// Mock fs for TC-037
const mockFs: { existsOverride?: (p: string) => boolean; readOverride?: (p: string) => string } = {}
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (p: any) => mockFs.existsOverride ? mockFs.existsOverride(String(p)) : actual.existsSync(p),
    readFileSync: (p: any, ...args: any[]) => mockFs.readOverride ? mockFs.readOverride(String(p)) : (actual as any).readFileSync(p, ...args),
  }
})

import { resolveModelAlias, loadModelAliasConfig, BUILTIN_DEFAULTS } from '../config/model-alias'

const testConfig: ModelAliasConfig = {
  default: 'pro',
  providers: {
    pi: {
      'pro-max': 'anthropic/claude-opus-4-20250514',
      pro: 'anthropic/claude-sonnet-4-20250514',
      se: 'anthropic/claude-haiku-4-5-20251001',
    },
    claude: {
      'pro-max': 'opus',
      pro: 'sonnet',
      se: 'haiku',
    },
  },
}

describe('resolveModelAlias', () => {
  it('resolves tier to mapped model (TC-034)', () => {
    expect(resolveModelAlias('pro-max', 'pi', testConfig)).toBe('anthropic/claude-opus-4-20250514')
  })

  it('returns non-tier model unchanged (TC-035)', () => {
    expect(resolveModelAlias('sonnet', 'claude', testConfig)).toBe('sonnet')
    expect(resolveModelAlias('openai/gpt-4o', 'pi', testConfig)).toBe('openai/gpt-4o')
  })

  it('uses default tier for undefined model (TC-036)', () => {
    expect(resolveModelAlias(undefined, 'pi', testConfig)).toBe('anthropic/claude-sonnet-4-20250514')
  })

  it('returns tier string unchanged when provider has no mapping', () => {
    expect(resolveModelAlias('pro', 'unknown-provider', testConfig)).toBe('pro')
  })
})

describe('loadModelAliasConfig', () => {
  it('returns builtin defaults when no config exists (TC-038)', () => {
    const config = loadModelAliasConfig('nonexistent-org-' + Date.now())
    expect(config.default).toBe(BUILTIN_DEFAULTS.default)
    expect(config.providers).toBeDefined()
  })

  it('builtin defaults contain pi and claude mappings', () => {
    expect(BUILTIN_DEFAULTS.providers.pi?.['pro-max']).toBe('anthropic/claude-opus-4-20250514')
    expect(BUILTIN_DEFAULTS.providers.claude?.pro).toBe('sonnet')
  })

  it('TC-037: org-level config overrides builtin defaults', () => {
    const customYaml = yaml.dump({
      default: 'se',
      providers: {
        pi: { 'pro-max': 'custom/model-v99' },
      },
    })

    mockFs.existsOverride = (p: string) => p.includes('test-org-tc037')
    mockFs.readOverride = () => customYaml

    try {
      const config = loadModelAliasConfig('test-org-tc037')
      expect(config.default).toBe('se')
      expect(config.providers.pi?.['pro-max']).toBe('custom/model-v99')
      // Non-overridden keys should still come from builtin
      expect(config.providers.pi?.pro).toBe('anthropic/claude-sonnet-4-20250514')
    } finally {
      mockFs.existsOverride = undefined
      mockFs.readOverride = undefined
    }
  })
})
