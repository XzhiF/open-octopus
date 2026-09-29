/**
 * PG 测试 harness 骨架（P1 交付物 5）。
 *
 * 用法与存量 :memory: 测试的迁移策略见同目录上层的 README.md（packages/server/src/db/pg/README.md）。
 *
 * 隔离模型：每个用例 `CREATE DATABASE octopus_test_<rand> TEMPLATE octopus_template`
 *   → 跑迁移器 → 用毕 `DROP DATABASE ... WITH (FORCE)`。
 *   - 快路径（推荐逐批采用）：template 库带全套 schema，建库毫秒级；
 *   - 本骨架默认连建库后立刻 applyPgSchema —— template 尚未灌 schema 时行为等价，
 *     template 灌好后 opts.migrate 传 false 可再省一段。
 * 名字护栏：DROP 仅允许匹配 /^octopus_test_[0-9a-f]{12}$/ 的随机名 ——
 *   误删 octopus / octopus_template 在代码层面不可能。
 */
import { randomBytes } from 'node:crypto'
import Postgres from 'postgres'
import { applyPgSchema } from '../migrate'
import { createPgPool, type PgPoolHandle } from '../pool'
import { resolvePgConfig } from '../config'

/** CI 无 PG 服务 —— 有 OCTOPUS_PG_TEST_URL 才跑（见 README 的 describe 门）。 */
export const pgTestEnabled = Boolean(process.env.OCTOPUS_PG_TEST_URL?.trim())

const TEST_DB_RE = /^octopus_test_[0-9a-f]{12}$/

export interface PgTestDatabase extends PgPoolHandle {
  name: string
  /** 结束查询池 + DROP DATABASE（幂等）。afterEach 里 await。 */
  close(): Promise<void>
}

export interface CreateTestDbOptions {
  /** 建库后跑迁移器（默认 true）。template 已含 schema 时可传 false 走快路径。 */
  migrate?: boolean
  /** 覆盖池上限（默认 2：单测不需要大池）。 */
  max?: number
}

function testDbName(): string {
  return `octopus_test_${randomBytes(6).toString('hex')}`
}

/** 从维护连接串派生目标库的连接串（只换 pathname）。 */
function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl)
  u.pathname = `/${dbName}`
  return u.toString()
}

/**
 * 建随机测试库并迁移。OCTOPUS_PG_TEST_URL 指向实例的任意库（compose 部署用
 * postgres://octopus:octopus@127.0.0.1:5432/octopus 即可 —— 维护连接只用来
 * CREATE/DROP DATABASE，不碰它指向的库本身）。
 */
export async function createTestDatabase(opts: CreateTestDbOptions = {}): Promise<PgTestDatabase> {
  const adminUrl = process.env.OCTOPUS_PG_TEST_URL?.trim()
  if (!adminUrl) {
    throw new Error('[pg-harness] OCTOPUS_PG_TEST_URL is not set — PG tests require a reachable instance (see packages/server/src/db/pg/README.md)')
  }
  const name = testDbName()
  const admin = Postgres(adminUrl, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE octopus_template`)
  } catch (err) {
    await admin.end({ timeout: 5 }).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `[pg-harness] CREATE DATABASE ${name} failed — does octopus_template exist in this instance? ` +
      `(deploy/pg-init/01-extensions.sql creates it) :: ${msg}`,
    )
  }

  const config = { ...resolvePgConfig(), url: urlForDb(adminUrl, name), poolMax: opts.max ?? 2 }
  const pool = createPgPool(config)
  try {
    if (opts.migrate !== false) await applyPgSchema(pool.sql)
  } catch (err) {
    await pool.sql.end({ timeout: 5 }).catch(() => {})
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {})
    await admin.end({ timeout: 5 }).catch(() => {})
    throw err
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await pool.sql.end({ timeout: 5 })
    if (!TEST_DB_RE.test(name)) throw new Error(`[pg-harness] refusing to drop non-test database ${name}`)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end({ timeout: 5 })
  }

  return { ...pool, name, close }
}

/** 维护连接（指向测试实例，用于快照/管理查询 —— 不参与用例事务）。 */
export function openAdminConnection(): ReturnType<typeof Postgres> {
  const adminUrl = process.env.OCTOPUS_PG_TEST_URL?.trim()
  if (!adminUrl) throw new Error('[pg-harness] OCTOPUS_PG_TEST_URL is not set')
  return Postgres(adminUrl, { max: 1 })
}
