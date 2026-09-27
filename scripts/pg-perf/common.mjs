#!/usr/bin/env node
/**
 * pg-perf 公共件 —— P1 判据度量手段（plan.html P1 判据②「执行链路 p99 不劣化」、
 * 判据③「事件循环阻塞监控为空」）。
 *
 * 红线（与任务书一致）：
 *   · 真库 `.../octopus` 只读 —— 本模块的 PG 写路径一律建随机名库
 *     `octopus_perf_<12hex>`（TEMPLATE octopus_template + PG schema 幂等重放，
 *     模式照抄 packages/server/src/db/pg/__tests__/harness.ts 的 createTestDatabase），
 *     DROP 前正则护栏不过就拒绝 —— 代码层面删不到 octopus / octopus_template。
 *   · 只 import packages/server 的依赖（better-sqlite3 / postgres），不触碰其源码
 *     （并行 agent 在 B3 域工作，registry/DAO/routes 禁碰）。
 */
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')
/** 结果落盘默认目录（scripts/pg-perf/results/，目录内 .gitignore 挡住产物）。 */
export const DEFAULT_OUT_DIR = path.join(HERE, 'results')

// pnpm 布局：better-sqlite3/postgres 只装在 packages/server —— 从那里解析（同 pg-migrate 票姿势）
const require = createRequire(path.join(ROOT, 'packages', 'server', 'index.js'))

/** better-sqlite3 构造器（惰性，报错口径统一）。 */
export function loadBetterSqlite() {
  try {
    return require('better-sqlite3')
  } catch (err) {
    die(`无法从 packages/server 解析 better-sqlite3（先 pnpm install）:: ${err.message}`)
  }
}

/** postgres.js 工厂。 */
export function loadPostgres() {
  try {
    return require('postgres')
  } catch (err) {
    die(`无法从 packages/server 解析 postgres（先 pnpm install）:: ${err.message}`)
  }
}

export function die(msg) {
  console.error('[pg-perf] ' + msg)
  process.exit(1)
}

export const log = (...a) => console.log('[pg-perf]', ...a)

/** URI 抹密码（与 db/pg/config.ts maskPgUrl 同口径，不回显凭证）。 */
export const maskUrl = (u) => String(u).replace(/\/\/[^@/]+@/, '//***@')

/** 只读真库护栏：任何工具拿到的 URL 的 pathname 不许是 /octopus 本身（写路径）。 */
export function assertNotRealDb(url, what) {
  try {
    const p = new URL(url).pathname
    if (p === '/octopus') die(`${what} 指向真库 /octopus —— 真库只读，测量请走 OCTOPUS_PG_TEST_URL 随机库`)
  } catch {
    die(`${what} 不是合法 URL`)
  }
}

// ── 统计 ─────────────────────────────────────────────────────────────────────

/** 最近秩百分位（nearest-rank，向上取秩）—— 判据「p99」口径写死在这里。 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

/** ms 数组 → 报告用统计对象（可 JSON 落盘、可被 compare.mjs 复算）。 */
export function latencyStats(valuesMs) {
  const sorted = [...valuesMs].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((s, v) => s + v, 0)
  return {
    n,
    minMs: round6(sorted[0]),
    meanMs: round6(sum / n),
    p50Ms: round6(percentile(sorted, 50)),
    p95Ms: round6(percentile(sorted, 95)),
    p99Ms: round6(percentile(sorted, 99)),
    maxMs: round6(sorted[n - 1]),
  }
}

export const round6 = (v) => Math.round(v * 1e6) / 1e6
export const fmtMs = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}ms` : '—')

export const utcStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

export function gitRev() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim()
  } catch {
    return '(unknown)'
  }
}

/** JSON 落盘（结果文件是「B5/B6 前后对比」的唯一载体 —— compare.mjs 只吃这个格式）。 */
export function writeJson(outPath, obj) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n')
  log('结果落盘 →', outPath)
}

/** 读结果文件（带格式版本校验）。 */
export function readResult(file) {
  let obj
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    die(`结果文件不可读 ${file} :: ${err.message}`)
  }
  if (obj.format !== 'octopus-pg-perf/v1') die(`${file} 不是 octopus-pg-perf/v1 结果文件（format=${obj.format}）`)
  return obj
}

// ── SQLite 随机 scratch 库 ───────────────────────────────────────────────────

const SQLITE_SCHEMA_PATH = path.join(ROOT, 'packages', 'server', 'src', 'db', 'schema.sql')

/**
 * 建一次性 SQLite scratch 库（临时目录，绝不碰 ~/.octopus/db/octopus.db）。
 * 直接 exec 仓库 SQLite schema.sql（SCHEMA_VERSION 49 静态基线 + 触发器 + FTS），
 * 与 server 启动路径 applySchema 同构 —— 本票红线是不动 src，只读文件。
 */
export function createSqliteScratch(label) {
  const Database = loadBetterSqlite()
  if (!fs.existsSync(SQLITE_SCHEMA_PATH)) die(`缺少 ${SQLITE_SCHEMA_PATH}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `octopus-perf-${label}-`))
  const file = path.join(dir, 'perf.db')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(SQLITE_SCHEMA_PATH, 'utf8'))
  return {
    db,
    file,
    close() {
      try { db.close() } catch { /* 已关 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ── PG 随机 perf 库 ──────────────────────────────────────────────────────────

const PG_SCHEMA_PATH = path.join(ROOT, 'packages', 'server', 'src', 'db', 'pg', 'schema.sql')
const PERF_DB_RE = /^octopus_perf_[0-9a-f]{12}$/

/** 与 db/pg/migrate.ts readPgSchemaSql 同款方言标记校验（读到 SQLite 那份会响亮报错）。 */
export function readPgSchemaText() {
  const text = fs.readFileSync(PG_SCHEMA_PATH, 'utf8')
  if (!/GENERATED BY DEFAULT AS IDENTITY/.test(text) || /^PRAGMA/m.test(text)) {
    die(`${PG_SCHEMA_PATH} 不是 PG 平移面（检出 SQLite 内容）—— 请确认基线分支`)
  }
  return text
}

function urlForDb(adminUrl, dbName) {
  const u = new URL(adminUrl)
  u.pathname = `/${dbName}`
  return u.toString()
}

/**
 * 随机 perf 库 lifecycle —— harness.createTestDatabase 的脚本态等价物：
 * CREATE DATABASE octopus_perf_<rand> TEMPLATE octopus_template → 幂等重放 PG schema
 * → 用毕 DROP ... WITH (FORCE)。写超时与会话参数照 config.ts PG_DEFAULTS（15s/60s/10），
 * application_name 区分开（octopus-pg-perf），不冒充 server 池。
 */
export async function createPerfDatabase({ poolMax = 10 } = {}) {
  const Postgres = loadPostgres()
  const adminUrl = process.env.OCTOPUS_PG_TEST_URL?.trim()
  if (!adminUrl) {
    die('OCTOPUS_PG_TEST_URL 未设置 —— PG 测量必须在测试实例上建随机库（真库 octopus 只读）。例：OCTOPUS_PG_TEST_URL=postgres://octopus:octopus@127.0.0.1:5432/octopus')
  }
  const name = `octopus_perf_${randomBytes(6).toString('hex')}`
  const admin = Postgres(adminUrl, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE octopus_template`)
  } catch (err) {
    await admin.end({ timeout: 5 }).catch(() => {})
    const msg = err instanceof Error ? err.message : String(err)
    die(`CREATE DATABASE ${name} 失败 —— 实例里有 octopus_template 吗？（deploy/pg-init/01-extensions.sql 随容器首建创建）:: ${msg}`)
  }
  const url = urlForDb(adminUrl, name)
  const sql = Postgres(url, {
    max: poolMax,
    idle_timeout: 60,
    connect_timeout: 10,
    connection: {
      statement_timeout: 15000,
      idle_in_transaction_session_timeout: 60000,
      application_name: 'octopus-pg-perf',
    },
    onnotice: () => {},
  })
  try {
    // 与 harness 默认 migrate:true 行为等价：template 已带 schema 时重放是零效果幂等。
    await sql.unsafe(readPgSchemaText())
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {})
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {})
    await admin.end({ timeout: 5 }).catch(() => {})
    die(`perf 库 ${name} schema 重放失败 :: ${err instanceof Error ? err.message : err}`)
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await sql.end({ timeout: 5 })
    if (!PERF_DB_RE.test(name)) die(`refusing to drop non-perf database ${name}`)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end({ timeout: 5 })
  }
  return { name, url, sql, close }
}

/** 简单线性同余 PRNG（mulberry32）—— 种子数据确定性 = 两次运行可比。 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
