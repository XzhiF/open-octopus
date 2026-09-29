/**
 * BasePgDAO（B0.5 收口票交付物 1）的对拍与证伪测试。
 *
 * 三块：
 *   A. convertPlaceholders 单元测试 —— 钉住「§7 草案的 replace((_, i) => $++i)
 *      中第二个回调参数是**偏移**不是序号」这个 bug 不复存在；字符串内 `?` 不动。
 *   B. §7「静态 SQL 无字符串内 ? —— 实测安全」证伪扫描 —— 逐文件扫 dao/*.ts +
 *      price-sql.ts 的全部字符串字面量（JS tokenizer 级别，不是肉眼 grep），
 *      断言转换可逆（引号区域字节级不动 + $n 连号）且违例列表为空。
 *   C. paginate SQLite↔PG 同数据对拍 + q/q1/exec/transaction 语义冒烟
 *      （OCTOPUS_PG_TEST_URL 缺席时 skip，与 db/pg/__tests__ 同一门）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BasePgDAO, convertPlaceholders, type PgSql } from '../base-pg'
import { BaseDAO } from '../base'
import { initDb, closeDb } from '../../connection'
import { pgTestEnabled, createTestDatabase, type PgTestDatabase } from '../../pg/__tests__/harness'
import type { PgPoolHandle } from '../../pg/pool'

if (!pgTestEnabled) {
  // eslint-disable-next-line no-console
  console.warn('[base-pg-tests] OCTOPUS_PG_TEST_URL not set — BasePgDAO PG parity tests are SKIPPED (SQLite-side scan still runs).')
}
const describePg = pgTestEnabled ? describe : describe.skip

// ── A. convertPlaceholders ───────────────────────────────────────────────

describe('convertPlaceholders', () => {
  it('编号来自独立计数器，不是匹配偏移（§7 草案 bug 钉死）', () => {
    // §7 草案: sql.replace(/\?/g, (_, i) => `$${++i}`) —— 回调第二参是**偏移量**，
    // "a ? b ?" 会得到 "$3 $7"。反面对照钉住草案的错误，再钉我们的正确。
    const draft = (sql: string) => sql.replace(/\?/g, (_, i) => `$${++i}`)
    expect(draft('a ? b ?')).toBe('a $3 b $7')
    expect(convertPlaceholders('a ? b ?')).toBe('a $1 b $2')
    const sql = 'SELECT * FROM t WHERE a = ? AND b = ? AND c = ?'
    expect(convertPlaceholders(sql)).toBe('SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3')
  })

  it('SQL 单引号字面量内的 ? 不是占位符', () => {
    expect(convertPlaceholders("SELECT 'what? yes?' AS q, id FROM t WHERE id = ?"))
      .toBe("SELECT 'what? yes?' AS q, id FROM t WHERE id = $1")
  })

  it("SQL '' 转义不翻出引号状态", () => {
    expect(convertPlaceholders("UPDATE t SET name = 'it''s ? here' WHERE id = ?"))
      .toBe("UPDATE t SET name = 'it''s ? here' WHERE id = $1")
  })

  it('无 ? 的 SQL 逐字节不变（高频路径零开销语义）', () => {
    const sql = 'SELECT * FROM orgs ORDER BY name ASC'
    expect(convertPlaceholders(sql)).toBe(sql)
  })

  it('IN (?, ?, ?) 批量占位逐位连号', () => {
    expect(convertPlaceholders('SELECT 1 WHERE id IN (?,?,?) AND x = ?'))
      .toBe('SELECT 1 WHERE id IN ($1,$2,$3) AND x = $4')
  })
})

// ── B. §7 证伪扫描：全部 DAO 静态 SQL 字面量 ──────────────────────────────

/**
 * 迷你 JS 扫描器：字符串/模板字面量提取 + 注释跳过（注释里的 `'`/`?` 不算数）。
 * `${…}` 插值整体跳过并打一个空格占位（被插值的片段字面量会作为独立字面量各自扫到）。
 */
function extractStringLiterals(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') { // 行注释
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') { // 块注释
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c !== "'" && c !== '"' && c !== '`') { i++; continue }
    const quote = c
    let j = i + 1
    let content = ''
    while (j < src.length) {
      const d = src[j]
      if (d === '\\') { content += '  '; j += 2; continue }
      if (quote === '`' && d === '$' && src[j + 1] === '{') {
        let depth = 1
        j += 2
        while (j < src.length && depth > 0) {
          const e = src[j]
          if (e === '{') depth++
          else if (e === '}') depth--
          else if (e === "'" || e === '"' || e === '`') {
            const q = e
            j++
            while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++ }
          }
          j++
        }
        content += ' '
        continue
      }
      if (d === quote) { j++; break }
      content += d
      j++
    }
    out.push(content)
    i = j
  }
  return out
}

/** 字面量内容是否像（片段）SQL：含 ? 且命中 SQL 关键字或比较式前缀。 */
function looksLikeSql(lit: string): boolean {
  if (!lit.includes('?')) return false
  return /\b(SELECT|INSERT|UPDATE|DELETE|SET|WHERE|VALUES|FROM|INTO)\b/i.test(lit)
    || /^[\w."]+\s*(=|!=|<>|<=|>=|\bLIKE\b|\bIN\b)/i.test(lit.trim())
}

/** SQL 文本中单引号区域（含 '' 转义）里出现 ? 的片段 —— §7 口径的违例探测器。 */
function questionMarksInsideSqlStrings(lit: string): string[] {
  const hits: string[] = []
  let inQ = false
  let buf = ''
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i]
    if (inQ) {
      if (ch === "'") {
        if (lit[i + 1] === "'") { buf += "''"; i++; continue }
        if (buf.includes('?')) hits.push(buf)
        inQ = false
        buf = ''
      } else buf += ch
    } else if (ch === "'") inQ = true
  }
  return hits
}

/** 提取全部引号区域原文（转换前后必须逐字节相等）。 */
function sqlQuotedRegions(lit: string): string[] {
  const regions: string[] = []
  let inQ = false
  let buf = ''
  for (let i = 0; i < lit.length; i++) {
    const ch = lit[i]
    if (inQ) {
      buf += ch
      if (ch === "'") {
        if (lit[i + 1] === "'") { buf += "'"; i++; continue }
        regions.push(buf)
        inQ = false
        buf = ''
      }
    } else if (ch === "'") { inQ = true; buf = "'" }
  }
  return regions
}

describe('§7 口径证伪 —— 全 DAO 静态 SQL 扫描', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const daoDir = path.join(here, '..')
  const files = [
    ...fs.readdirSync(daoDir)
      .filter((f) => f.endsWith('.ts') && !['base-pg.ts', 'index.ts', 'registry.ts'].includes(f))
      .map((f) => path.join(daoDir, f)),
    path.join(here, '..', '..', 'price-sql.ts'),
  ].filter((f) => fs.existsSync(f))

  it('所有含 ? 的 SQL 字面量过替换函数：可逆、引号区不动、$n 连号；且字符串内 ? 违例 = 0', () => {
    let scanned = 0
    const violations: string[] = []
    for (const file of files) {
      const name = path.basename(file)
      const src = fs.readFileSync(file, 'utf8')
      for (const lit of extractStringLiterals(src).filter(looksLikeSql)) {
        scanned++
        violations.push(...questionMarksInsideSqlStrings(lit).map((frag) => `${name}: '${frag}'`))
        const converted = convertPlaceholders(lit)
        // (1) 引号区域逐字节不动
        expect(sqlQuotedRegions(converted), `${name} 引号区被改动: ${lit.slice(0, 80)}`).toEqual(sqlQuotedRegions(lit))
        // (2) 可逆：$n 全部还原成 ? 后与原串一致
        expect(converted.replace(/\$\d+/g, '?'), name).toBe(lit)
        // (3) 编号按出现顺序恰好 $1..$k
        const nums = [...converted.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
        expect(nums, `${name} 编号不连号: ${converted.slice(0, 80)}`).toEqual(nums.map((_, k) => k + 1))
      }
    }
    // 覆盖面自检：21 个 DAO + base 的 stmt SQL 合计数百条，低于 200 说明扫描器瞎了。
    expect(scanned).toBeGreaterThanOrEqual(200)
    // §7「静态 SQL 无字符串内 ?」口径：违例必须为空；翻出来即 B1 前关键情报。
    expect(violations, '§7 口径被证伪 —— 字符串内含 ? 的静态 SQL: ' + violations.join(' | ')).toEqual([])
  })
})

// ── C. SQLite ↔ PG 对拍（paginate 逐参数语义 + 基类方法冒烟） ─────────────

interface ProbeRow { name: string; path: string }

/**
 * 两端探针共用同一条 SQL 文本形态（archive-dao.listByWorkspace 同款四参）。
 * 数据面刻意选 name/path 两列 —— PG 的 orgs.id 是 bigint（int8），
 * 与 SQLite INTEGER→number 的返回类型天然不同型，id 不进对拍（S11 注记）。
 */
const DATA_SQL = (where: string) =>
  `SELECT name, path FROM orgs ${where} ORDER BY name ASC, id ASC LIMIT ? OFFSET ?`
const COUNT_SQL = (where: string) => `SELECT COUNT(*) as cnt FROM orgs ${where}`

class SqliteProbeDAO extends BaseDAO {
  list(where: string, params: unknown[], page: number, pageSize: number) {
    return this.paginate<ProbeRow>(DATA_SQL(where), COUNT_SQL(where), params, page, pageSize)
  }
}

class PgProbeDAO extends BasePgDAO {
  list(where: string, params: unknown[], page: number, pageSize: number) {
    return this.paginate<ProbeRow>(DATA_SQL(where), COUNT_SQL(where), params, page, pageSize)
  }
  insertProbe(name: string, pathVal: string) {
    return this.exec('INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?)', [name, pathVal, '2026-01-01T00:00:00.000Z'])
  }
  updateProbe(name: string) {
    return this.exec('UPDATE orgs SET path = ? WHERE name = ?', ['/x', name])
  }
  findProbe(name: string) { return this.q1<ProbeRow>('SELECT name, path FROM orgs WHERE name = ?', [name]) }
  findQuotedProbe() {
    return this.q1<{ q: string }>("SELECT 'what? yes?' AS q FROM orgs WHERE name = ? LIMIT 1", ['c'])
  }
  findAllProbe() { return this.q<ProbeRow>('SELECT name, path FROM orgs ORDER BY name') }
}

// 9 行：/x 4 行 /y 5 行；name 唯一，ORDER BY name,id 两端确定性一致
const SEED: Array<[string, string]> = [
  ['a', '/x/one'], ['b', '/x/two'], ['c', '/y/three'],
  ['d', '/x/four'], ['e', '/y/five'], ['f', '/x/six'],
  ['g', '/y/seven'], ['h', '/x/eight'], ['i', '/y/nine'],
]

describePg('BasePgDAO ↔ BaseDAO 同数据对拍', () => {
  let sqlite: ReturnType<typeof initDb>
  let pgDb: PgTestDatabase
  let sqlDao: SqliteProbeDAO
  let pgDao: PgProbeDAO

  beforeAll(async () => {
    sqlite = initDb(':memory:') // 自带 applySchema
    // orgs 有 seed 行 —— 对拍要纯数据，先清表再灌同一批（id 交给各引擎自增）
    sqlite.prepare('DELETE FROM orgs').run()
    for (const [name, p] of SEED) {
      sqlite.prepare('INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?)').run(name, p, '2026-01-01T00:00:00.000Z')
    }
    sqlDao = new SqliteProbeDAO(sqlite)

    pgDb = await createTestDatabase()
    await pgDb.sql.unsafe('TRUNCATE orgs RESTART IDENTITY')
    pgDao = new PgProbeDAO(pgDb.sql)
    for (const [name, p] of SEED) {
      await pgDb.sql.unsafe('INSERT INTO orgs (name, path, created_at) VALUES ($1, $2, $3)', [name, p, '2026-01-01T00:00:00.000Z'])
    }
  })

  afterAll(async () => {
    sqlite?.close()
    await pgDb?.close()
  })

  const cases: Array<[string, string, unknown[], number, number]> = [
    ['第 1 页带过滤', 'WHERE path LIKE ?', ['%/x/%'], 1, 3],
    ['第 2 页带过滤（残页）', 'WHERE path LIKE ?', ['%/x/%'], 2, 3],
    ['页大小恰好整除', 'WHERE path LIKE ?', ['%/x/%'], 1, 4],
    ['越界页 → data 空 total 不变', 'WHERE path LIKE ?', ['%/x/%'], 5, 3],
    ['page=0 夹紧到 1', '', [], 0, 4],
    ['page 负数夹紧到 1', '', [], -3, 4],
    ['pageSize=0 夹紧到 1', '', [], 1, 0],
    ['pageSize 负数夹紧到 1', '', [], 1, -5],
    ['pageSize>100 夹紧到 100', '', [], 1, 500],
    ['无过滤中间页', '', [], 2, 4],
  ]

  it.each(cases)('paginate %s —— SQLite/PG 逐字段相等', async (_label, where, params, page, pageSize) => {
    const a = sqlDao.list(where, params, page, pageSize)
    const b = await pgDao.list(where, params, page, pageSize)
    expect(b.data).toEqual(a.data)
    expect(b.total).toBe(a.total) // 两端都是 JS number（PG COUNT bigint 已归一）
    expect(typeof b.total).toBe('number')
    expect(b.page).toBe(a.page)
    expect(b.pageSize).toBe(a.pageSize)
  })

  it('q 返回全行数组；q1 无行返回 undefined（对齐 stmt().get()）', async () => {
    const rows = await pgDao.findAllProbe()
    expect(rows.map((r) => r.name)).toEqual(SEED.map((s) => s[0]).sort())
    expect(await pgDao.findProbe('nope')).toBeUndefined()
  })

  it('exec.changes 对齐 better-sqlite3 RunResult.changes', async () => {
    const sqliteChanges = sqlite.prepare('INSERT INTO orgs (name, path, created_at) VALUES (?, ?, ?)')
      .run('zz', '/x/zz', '2026-01-01T00:00:00.000Z').changes
    const ins = await pgDao.insertProbe('zz', '/x/zz')
    expect(ins.changes).toBe(sqliteChanges)
    const upd = await pgDao.updateProbe('zz')
    expect(upd.changes).toBe(sqlite.prepare('UPDATE orgs SET path = ? WHERE name = ?').run('/x', 'zz').changes)
    await pgDb.sql.unsafe('DELETE FROM orgs WHERE name = $1', ['zz'])
    sqlite.prepare('DELETE FROM orgs WHERE name = ?').run('zz')
  })

  it('字符串内含 ? 的 SQL 在真 PG 上原样执行（quote-aware 替换端到端）', async () => {
    const row = await pgDao.findQuotedProbe()
    expect(row).toEqual({ q: 'what? yes?' })
  })

  it('transaction：正常提交回传值、抛错整段回滚（PG 无 sqlite deferred 侥幸）', async () => {
    const dao = new PgProbeDAO(pgDb.sql)
    // 事务体必须经回调给的 tx 构造 DAO —— 沿用 this.db（池根句柄）会逃逸出事务（对拍钉桩见下）
    const v = await dao.transaction(async (tx) => {
      await new PgProbeDAO(tx as PgSql).insertProbe('tx-ok', '/tx')
      return 'ret'
    })
    expect(v).toBe('ret')
    expect((await dao.findProbe('tx-ok'))?.name).toBe('tx-ok')
    await expect(dao.transaction(async (tx) => {
      await new PgProbeDAO(tx as PgSql).insertProbe('tx-bad', '/tx')
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await dao.findProbe('tx-bad')).toBeUndefined()
    await pgDb.sql.unsafe('DELETE FROM orgs WHERE name = $1', ['tx-ok'])
  })

  it('transaction 反模式钉桩：体内混用根句柄方法 = 写逃逸出事务（B 批改写红线）', async () => {
    const dao = new PgProbeDAO(pgDb.sql)
    await expect(dao.transaction(async () => {
      await dao.insertProbe('tx-leak', '/tx') // ← 走池根连接，不在 BEGIN 内
      throw new Error('boom')
    })).rejects.toThrow('boom')
    const leaked = await dao.findProbe('tx-leak') // 已提交 —— 旧 BaseDAO 同步语义在此失效
    expect(leaked?.name).toBe('tx-leak')
    await pgDb.sql.unsafe('DELETE FROM orgs WHERE name = $1', ['tx-leak'])
  })

  it('transaction：句柄已是事务 → 复用不重入；外层回滚连内层一起消失', async () => {
    const marker = 'nested-tx'
    await expect(pgDb.sql.begin(async (tx) => {
      const dao = new PgProbeDAO(tx as PgSql)
      await dao.transaction(async () => { await dao.insertProbe(marker, '/tx') }) // 复用 tx，不再 BEGIN
      throw new Error('outer-rollback')
    })).rejects.toThrow('outer-rollback')
    const probe = new PgProbeDAO(pgDb.sql)
    expect(await probe.findProbe(marker)).toBeUndefined()
  })

  it('计数缺口（B0 现状钉桩）：sql.begin 内语句不进 metrics.started', async () => {
    const handle: PgPoolHandle = pgDb
    const dao = new PgProbeDAO(handle.sql)
    const before = handle.metrics.started
    await dao.transaction(async (tx) => { await new PgProbeDAO(tx as PgSql).insertProbe('count-gap', '/tx') })
    expect(handle.metrics.started).toBe(before) // 事务内不计数 —— pool.ts 现状，B6 收口再谈
    await pgDb.sql.unsafe('DELETE FROM orgs WHERE name = $1', ['count-gap'])
  })

  it('池根句柄的 q 正常计数（与事务缺口成对钉桩）', async () => {
    const handle: PgPoolHandle = pgDb
    const dao = new PgProbeDAO(handle.sql)
    const before = handle.metrics.started
    await dao.findAllProbe()
    expect(handle.metrics.started).toBe(before + 1)
  })
})
