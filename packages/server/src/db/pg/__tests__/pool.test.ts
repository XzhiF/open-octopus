/**
 * 驱动接线集成测试（需 PG）：查询级超时落到会话、池计数/统计、actuator resolver 面。
 * CI 无 PG：缺 OCTOPUS_PG_TEST_URL 时 skip + 警告。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { pgTestEnabled, createTestDatabase, type PgTestDatabase } from './harness'
import { createPgPool, getPgPool, registerPgPool, getPgPoolStats } from '../pool'
import { PgResolver } from '../../../services/actuator/pg-resolver'
import { PG_DEFAULTS } from '../config'

if (!pgTestEnabled) {
  // eslint-disable-next-line no-console
  console.warn('[pg-tests] OCTOPUS_PG_TEST_URL not set — PG pool integration tests are SKIPPED (CI has no PG service). See packages/server/src/db/pg/README.md')
}
const describePg = pgTestEnabled ? describe : describe.skip

describePg('pg pool wiring', () => {
  let db: PgTestDatabase | null = null

  afterEach(async () => {
    registerPgPool(null)
    await db?.close()
    db = null
  })

  it('per-connection session timeouts land (server-level stays unset by design)', async () => {
    db = await createTestDatabase()
    const rows = (await db.sql`
      SELECT name, setting, unit FROM pg_settings
      WHERE name IN ('statement_timeout', 'idle_in_transaction_session_timeout', 'application_name')
    `) as unknown as Array<{ name: string; setting: string; unit: string }>
    const byName = new Map(rows.map(r => [r.name, r]))
    expect(byName.get('statement_timeout')!.setting).toBe(String(PG_DEFAULTS.statementTimeoutMs))
    expect(byName.get('idle_in_transaction_session_timeout')!.setting).toBe(String(PG_DEFAULTS.idleInTransactionTimeoutMs))
    expect(byName.get('application_name')!.setting).toBe(PG_DEFAULTS.applicationName)
  })

  it('query counting + stats surface (occupancy / queue estimate / masked url)', async () => {
    db = await createTestDatabase({ max: 4 })
    registerPgPool(db)
    await db.sql`SELECT 1`
    await db.sql`SELECT count(*)::int AS n FROM workspaces`
    // 失败查询也要计入 failed
    await expect(db.sql`SELECT no_such_fn_cannot_resolve()`).rejects.toThrow(/does not exist/)
    // postgres.js 惰性派发：查询在第一次 .then 之前不上线 —— Promise.resolve() 强制 adopt。
    const pending = Promise.resolve(db.sql`SELECT pg_sleep(1)`)
    await new Promise(r => setTimeout(r, 400))
    const stats = await getPgPoolStats()
    await pending
    expect(stats.initialized).toBe(true)
    expect(stats.url).not.toMatch(/octopus:octopus@/) // 密码已抹
    expect(stats.app!.queries_started).toBeGreaterThanOrEqual(4)
    expect(stats.app!.queries_failed).toBeGreaterThanOrEqual(1)
    // sleep 占用一条 → stats 采样时 inflight 恰为它（stats 自身的查询已 settled）
    expect(stats.app!.inflight).toBeLessThanOrEqual(1)
    expect(stats.connections!.total).toBeGreaterThanOrEqual(1)
    expect(stats.session!.statement_timeout).toMatch(/^15/)
    expect(stats.pool_max).toBe(db.config.poolMax)
  })

  it('statement_timeout actually kills a runaway query (the guard is live, not decorative)', async () => {
    // 独立小池指同一测试库，只改会话超时 —— SELECT pg_sleep 不写数据，安全。
    db = await createTestDatabase()
    const slow = createPgPool({ ...db.config, statementTimeoutMs: 300 })
    try {
      await expect(slow.sql`SELECT pg_sleep(5)`).rejects.toThrow(/canceling statement due to statement timeout/)
    } finally {
      await slow.sql.end({ timeout: 5 })
    }
  })

  it('actuator PgResolver reports ok with live pool and disabled without', async () => {
    const resolver = new PgResolver()
    registerPgPool(null)
    const disabled = await resolver.resolve()
    expect(['disabled', 'error']).toContain(disabled.status) // error = OCTOPUS_PG_URL 设了但池未建
    expect(disabled.primary).toBe(false)

    db = await createTestDatabase({ max: 4 })
    registerPgPool(db)
    const pending = Promise.resolve(db.sql`SELECT pg_sleep(1)`) // 占用非采样连接（.then 即派发）
    await new Promise(r => setTimeout(r, 400))
    const ok = await resolver.resolve()
    await pending
    expect(ok.status).toBe('ok')
    expect(ok.connections!.total).toBeGreaterThanOrEqual(1)
  })
})
