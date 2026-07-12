import { describe, it, expect } from 'vitest'
import { resolveMoaModel } from '../config/moa-model-resolver'
import type { ModelAliasConfig } from '../config/model-alias'

const config: ModelAliasConfig = {
  default: 'pro',
  providers: {
    pi: { 'pro-max': 'pi-pro-max-v2', pro: 'pi-pro-v1', se: 'pi-se-v1' },
    claude: { 'pro-max': 'opus', pro: 'sonnet', se: 'haiku' },
  },
  custom_providers: {},
}

describe('resolveMoaModel', () => {
  // TC-007: exact match
  it('TC-007: exact match pro-max resolves without degradation', () => {
    const result = resolveMoaModel('pro-max', 'pi', config)
    expect(result.resolved).toBe('pi-pro-max-v2')
    expect(result.degraded).toBe(false)
    expect(result.chain).toEqual(['pro-max'])
  })

  // TC-008: single suffix strip
  it('TC-008: suffix degradation pro-max-custom → pro-max', () => {
    const result = resolveMoaModel('pro-max-custom', 'pi', config)
    expect(result.resolved).toBe('pi-pro-max-v2')
    expect(result.degraded).toBe(true)
    expect(result.chain).toEqual(['pro-max-custom', 'pro-max'])
  })

  // TC-009: full chain down to se (config without pro-max/pro)
  it('TC-009: full chain degradation pro-max-unknown → se', () => {
    const seOnlyConfig: ModelAliasConfig = {
      default: 'se',
      providers: { pi: { se: 'pi-se-v1' } },
      custom_providers: {},
    }
    const result = resolveMoaModel('pro-max-unknown', 'pi', seOnlyConfig)
    expect(result.resolved).toBe('pi-se-v1')
    expect(result.degraded).toBe(true)
    expect(result.chain).toEqual(['pro-max-unknown', 'pro-max', 'pro', 'se'])
  })

  it('returns original ID when no tier matches', () => {
    const emptyConfig: ModelAliasConfig = {
      default: 'pro',
      providers: { pi: {} },
      custom_providers: {},
    }
    const result = resolveMoaModel('pro-max-custom', 'pi', emptyConfig)
    expect(result.resolved).toBe('pro-max-custom')
    expect(result.degraded).toBe(false)
    expect(result.chain).toEqual(['pro-max-custom'])
  })

  it('chain records every degradation step', () => {
    const result = resolveMoaModel('pro-max-foo-bar', 'pi', config)
    expect(result.degraded).toBe(true)
    // pro-max-foo-bar → pro-max-foo → pro-max (found)
    expect(result.chain).toEqual(['pro-max-foo-bar', 'pro-max-foo', 'pro-max'])
    expect(result.resolved).toBe('pi-pro-max-v2')
  })

  // M8 fix: when provider lacks mapping for matched tier key, resolver degrades further instead of returning tier key
  it('M8: degrades when provider lacks mapping for matched tier key', () => {
    const partialConfig: ModelAliasConfig = {
      default: 'se',
      providers: { pi: { se: 'pi-se-v1' } }, // only has 'se' tier
      custom_providers: {},
    }
    // 'pro-max' is a tier key, but pi has no mapping for it → should fall through to 'se'
    const result = resolveMoaModel('pro-max', 'pi', partialConfig)
    expect(result.resolved).toBe('pi-se-v1') // should NOT be 'pro-max' (tier key)
    expect(result.degraded).toBe(true)
  })
})
