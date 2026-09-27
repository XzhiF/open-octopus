/**
 * B1 探针测试共用 PG fixture（p1-batch-plan §8 网 3 · db/pg/README 施工图）。
 *
 * 为什么不是 `new Database(':memory:')`：B1 起 Org/Chat/Clone/AgentVersion/Harness
 * 五个 DAO 是 postgres.js（BasePgDAO），造数必须落到真 PG 才能对拍。
 *
 * 用法（每个测试文件一座库，成本毫秒级）：
 *   const pg = await setupPgSchema()          // 建随机库 + applyPgSchema + 返回句柄
 *   const dao = new OrgDAO(pg.sql)             // 直接注入 Sql
 *   await pg.truncate('orgs')                  // 用例间清表（按 FK 逆序传参随意，B1 表无跨表 FK）
 *   await pg.close()                           // 务必 afterAll 里调（DROP DATABASE）
 *
 * 无 OCTOPUS_PG_TEST_URL 时 setupPgSchema 抛错 —— 调用方用 describePg 门住整块，
 * 永远进不到这里（用例记为 skip，全量数不减）。
 */
import { describe } from 'vitest'
import { createTestDatabase, pgTestEnabled, type PgTestDatabase } from './harness'
import { registerPgPool } from '../pool'
import type { Sql } from 'postgres'

export const describePg = pgTestEnabled ? describe : describe.skip

/** 供文件内条件建库（顶层 fixture 半 PG 半 SQLite 场景）。 */
export function pgTestEnabledOn(): boolean {
  return pgTestEnabled
}

export interface PgFixture {
  sql: Sql
  db: PgTestDatabase
  truncate(...tables: string[]): Promise<void>
  close(): Promise<void>
}

/** 建一座随机测试库（含全套 schema）。afterAll 必须 close()。 */
export async function setupPgSchema(): Promise<PgFixture> {
  const db = await createTestDatabase()
  return {
    sql: db.sql,
    db,
    async truncate(...tables: string[]) {
      if (tables.length === 0) return
      const list = tables.map((t) => `"${t.replace(/[^\w]/g, '')}"`).join(', ')
      await db.sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
    },
    async close() {
      await db.close()
    },
  }
}

/**
 * 建随机测试库 **并注册为全局当前池** —— 供「整 app / 引擎生命周期」类集成测试用：
 * 这类测试经 `import app from "../index"`（VITEST 下走 createLazyDAOs → registry 的
 * pgSql() → getPgPool()）或直接 `new XxxDAO(pgSql())` 取句柄，池必须先注册否则 pgSql 抛错。
 * close 时自动注销（registerPgPool(null)）。
 */
export async function setupRegisteredPgSchema(): Promise<PgFixture> {
  const db = await createTestDatabase()
  registerPgPool(db)
  return {
    sql: db.sql,
    db,
    async truncate(...tables: string[]) {
      if (tables.length === 0) return
      const list = tables.map((t) => `"${t.replace(/[^\w]/g, '')}"`).join(', ')
      await db.sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
    },
    async close() {
      registerPgPool(null)
      await db.close()
    },
  }
}

/** 需要自行控制注册时机时直接用 pool.ts 的 registerPgPool。 */
export { getPgPool } from '../pool'
