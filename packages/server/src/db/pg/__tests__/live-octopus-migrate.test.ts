/**
 * 对**真实 octopus 库**跑迁移器两遍（交付物 4 的活体验证入口）。
 *
 * 默认永不执行：需同时设
 *   OCTOPUS_PG_LIVE_MIGRATE=yes   （明知故犯的确认开关）
 *   OCTOPUS_PG_URL                （目标库 —— dev 单机即 postgres://…/octopus）
 * 本文件只跑 DDL 幂等重放（IF NOT EXISTS / ON CONFLICT / setval），
 * 不建不删库；跑一次 = 给真库装 schema，跑两次 = 证明重放零效果。
 * 快照直接查 information_schema（替代 pg_dump 存档，测试里断言更硬）。
 */
import { describe, it, expect } from 'vitest'
import { resolvePgConfig } from '../config'
import { createPgPool } from '../pool'
import { applyPgSchema, PG_SCHEMA_VERSION } from '../migrate'

const armed = process.env.OCTOPUS_PG_LIVE_MIGRATE === 'yes' && Boolean(process.env.OCTOPUS_PG_URL?.trim())
if (process.env.OCTOPUS_PG_LIVE_MIGRATE === 'yes' && !process.env.OCTOPUS_PG_URL?.trim()) {
  // eslint-disable-next-line no-console
  console.warn('[pg-live] OCTOPUS_PG_LIVE_MIGRATE=yes but OCTOPUS_PG_URL unset — live migrate skipped')
}
const describeLive = armed ? describe : describe.skip

async function snapshot(sql: ReturnType<typeof createPgPool>['sql']) {
  return {
    columns: await sql`
      SELECT table_name, column_name, ordinal_position, is_nullable, data_type, coalesce(column_default,'') AS d
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
    indexes: await sql`SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`,
    triggers: await sql`SELECT tgname, tgrelid::regclass::text AS t FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    version: await sql`SELECT version FROM octopus_schema_version WHERE id = 1`,
  }
}

describeLive('live octopus DB — migrator replay (opt-in)', () => {
  it('apply, snapshot, re-apply: byte-stable object surface', async () => {
    const cfg = resolvePgConfig()
    const pool = createPgPool(cfg)
    try {
      const r1 = await applyPgSchema(pool.sql)
      expect(r1.version).toBe(PG_SCHEMA_VERSION)
      const a = JSON.parse(JSON.stringify(await snapshot(pool.sql)))
      const r2 = await applyPgSchema(pool.sql)
      const b = JSON.parse(JSON.stringify(await snapshot(pool.sql)))
      // eslint-disable-next-line no-console
      console.log('[pg-live] tables/indexes/triggers:',
        a.columns.length, 'columns |', (a.indexes as unknown[]).length, 'indexes |', (a.triggers as unknown[]).length, 'triggers')
      expect(b).toEqual(a)
    } finally {
      await pool.sql.end({ timeout: 5 })
    }
  }, 180_000)
})
