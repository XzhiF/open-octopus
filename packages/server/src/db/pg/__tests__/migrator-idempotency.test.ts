/**
 * 迁移器幂等重放验证（P1 交付物 3/4 的测试面）：
 * 同一随机测试库上 applyPgSchema 连跑两遍，逐对象快照（列/索引/触发器/序列/
 * IDENTITY/种子行数）必须完全相等 —— 「同一版本重复执行零效果」的可执行判据。
 * CI 无 PG：OCTOPUS_PG_TEST_URL 缺失时 skip + 警告。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pgTestEnabled, createTestDatabase, type PgTestDatabase } from './harness'
import { applyPgSchema, PG_SCHEMA_VERSION } from '../migrate'

if (!pgTestEnabled) {
  // eslint-disable-next-line no-console
  console.warn('[pg-tests] OCTOPUS_PG_TEST_URL not set — PG migrator idempotency tests are SKIPPED (CI has no PG service). See packages/server/src/db/pg/README.md')
}
const describePg = pgTestEnabled ? describe : describe.skip

const TRACKED_TABLES = 45 // 42 平移表 + 3 FTS5 占位表

async function snapshot(db: PgTestDatabase) {
const [columns, indexes, triggers, sequences, versionRow, seedCounts] = await Promise.all([
    db.sql`
      SELECT table_name, column_name, ordinal_position, is_nullable, data_type,
             coalesce(column_default, '') AS column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'octopus_schema_version'
      ORDER BY table_name, ordinal_position`,
    db.sql<{ indexname: string }[]>`
      SELECT indexname, tablename, indexdef FROM pg_indexes
      WHERE schemaname = 'public' ORDER BY indexname`,
    db.sql`
      SELECT tgname, tgrelid::regclass::text AS tbl, tgenabled
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    db.sql`
      SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
    db.sql`SELECT version FROM octopus_schema_version WHERE id = 1`,
    db.sql`
      SELECT count(*)::int AS cols
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (SELECT table_name FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`,
  ])
  const orgs = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM orgs`
  const state = await db.sql<{ n: number; v: number }[]>`SELECT count(*)::int AS n, max(schema_version)::int AS v FROM scheduler_state`
  return {
    columns,
    indexes: indexes.length,
    indexesRaw: indexes,
    triggers,
    sequences,
    versionRow,
    seedCounts,
    orgs: orgs[0].n,
    schedulerState: state,
  }
}

describePg('PG migrator — replay discipline', () => {
  let db: PgTestDatabase

  beforeAll(async () => {
    db = await createTestDatabase({ migrate: false })
  }, 60_000)

  afterAll(async () => {
    await db?.close()
  })

  it('first apply creates the full object surface and stamps the version', async () => {
    const report = await applyPgSchema(db.sql)
    expect(report.version).toBe(PG_SCHEMA_VERSION)
    expect(report.identitySequencesSynced).toBe(6)

    const tables = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name <> 'octopus_schema_version'`
    expect(tables[0].n).toBe(TRACKED_TABLES)
  })

  it('second apply on the same database is a no-op (per-object snapshot equality)', async () => {
    const before = JSON.parse(JSON.stringify(await snapshot(db)))
    await applyPgSchema(db.sql)
    const after = JSON.parse(JSON.stringify(await snapshot(db)))
    expect(after).toEqual(before)
  })

  it('a fresh apply then replay: third run still equal (replayable from scratch)', async () => {
    await applyPgSchema(db.sql)
    const third = JSON.parse(JSON.stringify(await snapshot(db)))
    const second = JSON.parse(JSON.stringify(await snapshot(db)))
    expect(third).toEqual(second)
  })

  it('seeds are conflict-safe: orgs/scheduler_state never duplicate', async () => {
    await applyPgSchema(db.sql)
    const orgs = (await db.sql`SELECT count(*)::int AS n FROM orgs WHERE name = 'xzf'`)[0] as { n: number }
    expect(orgs.n).toBe(1)
    const st = (await db.sql`SELECT count(*)::int AS n FROM scheduler_state`)[0] as { n: number }
    expect(st.n).toBe(1)
  })

  it('IDENTITY setval sync: explicit-id COPY then replay realigns the sequence', async () => {
    // 模拟搬迁票：带原 id 插入（BY DEFAULT 允许），migrator 的 setval 把序列抬到 max+1，
    // 之后不显式 id 的插入不得撞主键。
    await db.sql`INSERT INTO orgs (id, name, path, created_at) VALUES (4242, 'setval-probe', '/tmp/x', now())`
    await applyPgSchema(db.sql)
    const next = (await db.sql`INSERT INTO orgs (name, path, created_at)
      VALUES ('setval-next', '/tmp/y', now()) RETURNING id`)[0] as { id: bigint }
    expect(Number(next.id)).toBeGreaterThan(4242)
    await db.sql`DELETE FROM orgs WHERE name IN ('setval-probe', 'setval-next')`
    await applyPgSchema(db.sql) // 收尾回到稳定态，防后续用例受扰动
  })

  it('octopus_schema_version holds the PG_SCHEMA_VERSION and a single row', async () => {
    const rows = await db.sql`SELECT version FROM octopus_schema_version`
    expect(rows).toHaveLength(1)
    expect((rows[0] as { version: number }).version).toBe(PG_SCHEMA_VERSION)
  })
})
