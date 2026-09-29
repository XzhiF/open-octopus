/**
 * 驱动接线单元测试（不需要 PG 实例）：配置解析 / 判定 / URL 脱敏。
 */
import { describe, it, expect } from 'vitest'
import { resolvePgConfig, isPgConfigured, maskPgUrl, PG_DEFAULTS } from '../config'

describe('pg config', () => {
  it('parses defaults matching the dev compose contract', () => {
    const cfg = resolvePgConfig({})
    expect(cfg).toEqual({
      url: PG_DEFAULTS.url,
      poolMax: 10,
      statementTimeoutMs: 15_000,
      idleInTransactionTimeoutMs: 60_000,
      connectTimeoutMs: 10_000,
      idleTimeoutS: 60,
      applicationName: 'octopus-server',
    })
  })

  it('env overrides are honored and typed', () => {
    const cfg = resolvePgConfig({
      OCTOPUS_PG_URL: 'postgres://u:p@h:5432/d',
      OCTOPUS_PG_POOL_MAX: '4',
      OCTOPUS_PG_STATEMENT_TIMEOUT_MS: '2500',
      OCTOPUS_PG_IDLE_IN_TX_TIMEOUT_MS: '9000',
      OCTOPUS_PG_CONNECT_TIMEOUT_MS: '3000',
      OCTOPUS_PG_IDLE_TIMEOUT_S: '30',
      OCTOPUS_PG_APP_NAME: 'probe',
    })
    expect(cfg.url).toBe('postgres://u:p@h:5432/d')
    expect(cfg.poolMax).toBe(4)
    expect(cfg.statementTimeoutMs).toBe(2500)
    expect(cfg.idleInTransactionTimeoutMs).toBe(9000)
    expect(cfg.connectTimeoutMs).toBe(3000)
    expect(cfg.idleTimeoutS).toBe(30)
    expect(cfg.applicationName).toBe('probe')
  })

  it('rejects nonsense pool values loudly (fail-fast at boot, not silent clamp)', () => {
    expect(() => resolvePgConfig({ OCTOPUS_PG_POOL_MAX: '0' })).toThrow(/POOL_MAX/)
    expect(() => resolvePgConfig({ OCTOPUS_PG_STATEMENT_TIMEOUT_MS: 'abc' })).toThrow(/STATEMENT_TIMEOUT/)
  })

  it('isPgConfigured keys off OCTOPUS_PG_URL only', () => {
    expect(isPgConfigured({})).toBe(false)
    expect(isPgConfigured({ OCTOPUS_PG_URL: '  ' })).toBe(false)
    expect(isPgConfigured({ OCTOPUS_PG_URL: 'postgres://x@y/z' })).toBe(true)
  })

  it('maskPgUrl strips credentials for logs/actuator', () => {
    expect(maskPgUrl('postgres://octopus:secret@127.0.0.1:5432/octopus'))
      .toBe('postgres://octopus:***@127.0.0.1:5432/octopus')
    expect(maskPgUrl('not a url')).toBe('<invalid-url>')
  })
})
