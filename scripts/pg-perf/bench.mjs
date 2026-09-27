#!/usr/bin/env node
/**
 * bench.mjs —— P1 判据②「执行链路 p99 不劣化」的度量工具。
 *
 * 对 workloads.mjs 的代表性读/写/事务路径在 SQLite（旧路径 = 基线引擎）与
 * PG（随机 perf 库，OCTOPUS_PG_TEST_URL harness 模式）上跑同一组等价操作，
 * 产出 p50/p95/p99 表 + JSON 结果落盘，供 compare.mjs 做 B5/B6 前后对比。
 *
 * 用法:
 *   OCTOPUS_PG_TEST_URL=postgres://octopus:octopus@127.0.0.1:5432/octopus \
 *     node scripts/pg-perf/bench.mjs [--engine both|pg|sqlite] [--scale 500]
 *       [--iterations 150] [--warmup 15] [--concurrency 1] [--label 文本] [--out-dir DIR]
 *
 * 红线：
 *   · PG 写基准只打随机库 octopus_perf_<rand>（common.createPerfDatabase 护栏）；
 *     OCTOPUS_PG_TEST_URL 本身可以指向真库连接串 —— 只用它 CREATE/DROP DATABASE，
 *     与 db/pg/__tests__/harness.ts 的既有纪律一致。
 *   · SQLite 写基准打系统临时目录 scratch 库，绝不碰 ~/.octopus/db/octopus.db。
 *   · 真库 octopus 只读（本工具不读也不写它）。
 *
 * 判据口径：本工具不自行下「劣化」结论 —— 输出可与任意基线文件对比的 p99 表；
 * 「不劣化」的裁决在 compare.mjs（默认容差 0 = 严格不劣化，判据原文没有放宽额度）。
 */
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import {
  die, log, createPerfDatabase, createSqliteScratch, latencyStats, fmtMs,
  utcStamp, gitRev, writeJson, DEFAULT_OUT_DIR,
} from './common.mjs'
import { OPS, buildSeedDataset, seedSqlite, seedPg, datasetShape, DEFAULT_SEED, makeLoadCtx, toSqliteParams } from './workloads.mjs'

const HELP = `用法: node scripts/pg-perf/bench.mjs [options]
  --engine both|pg|sqlite  跑哪个引擎（默认 both：先 sqlite 基线后 pg）
  --scale <n>              种子 executions 行数（默认 500；派生表比例见 workloads.datasetShape）
  --iterations <n>         每 op 每轮计次迭代（默认 150）
  --warmup <n>             每 op 每轮预热迭代，不计数（默认 15）
  --repeat <k>             计次轮数（默认 1；正式判据建议 3：同一份数据 3 轮样本合并算 p99，尾噪显著下降）
  --concurrency <c>        并发 worker 数（默认 1 = 纯单查询延迟；>1 含排队，仅 pg 生效）
  --seed <n>               PRNG 种子（默认 ${DEFAULT_SEED}，改动后结果不可跨运行对比）
  --pool-max <n>           PG 池上限（默认 10 = PG_DEFAULTS.poolMax）
  --label <文本>           写进结果文件的备注（如 B5-before / B6-after）
  --out-dir <dir>          JSON 结果目录（默认 scripts/pg-perf/results/）
  -h, --help               本帮助
判据对比: node scripts/pg-perf/compare.mjs --baseline <a.json> --current <b.json>
正式对比协议：每个测量周期先跑一次「热机跑」（结果丢弃，暖 PG 实例/页缓存/OS），
再跑「正式跑」入基线；跨期同机同参数（scale/seed/iterations/concurrency 一致）。`

function parseArgs(argv) {
  const out = { engine: 'both', scale: 500, iterations: 150, warmup: 15, repeat: 1, concurrency: 1, seed: DEFAULT_SEED, poolMax: 10, label: '', outDir: DEFAULT_OUT_DIR }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) die(`缺少 ${a} 的参数值`)
      return v
    }
    if (a === '--engine') { out.engine = next(); if (!['both', 'pg', 'sqlite'].includes(out.engine)) die('--engine 取 both|pg|sqlite') }
    else if (a === '--scale') out.scale = posInt(a, next())
    else if (a === '--iterations') out.iterations = posInt(a, next())
    else if (a === '--warmup') out.warmup = nonNegInt(a, next())
    else if (a === '--repeat') out.repeat = posInt(a, next())
    else if (a === '--concurrency') out.concurrency = posInt(a, next())
    else if (a === '--seed') out.seed = Number(next())
    else if (a === '--pool-max') out.poolMax = posInt(a, next())
    else if (a === '--label') out.label = next()
    else if (a === '--out-dir') out.outDir = path.resolve(next())
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0) }
    else die(`未知参数: ${a}（--help）`)
  }
  return out
}
const posInt = (flag, raw) => { const n = Number(raw); if (!Number.isInteger(n) || n <= 0) die(`${flag} 需为正整数，got ${raw}`); return n }
const nonNegInt = (flag, raw) => { const n = Number(raw); if (!Number.isInteger(n) || n < 0) die(`${flag} 需为非负整数，got ${raw}`); return n }

// ── 测量前热机扫（连接建立 + 每表首轮页缓存），压掉首 op 的暖机尾噪 ──────────

const WARM_TABLES = ['workspaces', 'tasks', 'executions', 'node_executions', 'agent_events', 'interaction_messages', 'harness_events']

async function warmSweepPg(sql) {
  for (let k = 0; k < 30; k++) await sql.unsafe('SELECT 1', [])
  for (const t of WARM_TABLES) await sql.unsafe(`SELECT COUNT(*) AS c FROM ${t}`, [])
}
function warmSweepSqlite(db) {
  for (const t of WARM_TABLES) db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()
}

// ── 单引擎测量循环 ──────────────────────────────────────────────────────────

const NOISY_WRITE_NOTE = { 'write.exec_claimPending': '认领一次后不再 pending（changes=0 仍走完查询）—— 两引擎同形态，比的是相对数', 'write.task_updateWithVersion': '乐观锁首更后 version 前进（changes=0 仍走完查询）—— 两引擎同形态' }

function runSqliteOps({ db, dataset, opts, ctx }) {
  const stmtCache = new Map()
  const prep = (sql) => {
    let st = stmtCache.get(sql)
    if (!st) { st = db.prepare(sql); stmtCache.set(sql, st) }
    return st
  }
  const execOp = (op, i) => {
    if (op.class === 'tx') {
      const steps = op.txStatements(ctx, i).map((s) => s.sqlite)
      const run = db.transaction(() => { for (const s of steps) prep(s.sql).run(...toSqliteParams(s.values)) })
      run()
      return
    }
    if (op.steps) {
      for (const s of op.sqlite) prep(s.sql).run(...toSqliteParams(s.values(ctx, i)))
      return
    }
    const d = op.sqlite
    prep(d.sql).run(...toSqliteParams(d.values(ctx, i)))
  }
  return { execOp }
}

function runPgOps({ sql, dataset, opts, ctx }) {
  const execOp = async (op, i) => {
    if (op.class === 'tx') {
      const steps = op.txStatements(ctx, i).map((s) => s.pg)
      await sql.begin(async (tx) => { for (const s of steps) await tx.unsafe(s.sql, s.values) })
      return
    }
    if (op.steps) {
      for (const s of op.pg) await sql.unsafe(s.sql, s.values(ctx, i))
      return
    }
    const d = op.pg
    await sql.unsafe(d.sql, d.values(ctx, i))
  }
  return { execOp }
}

/** 每 op 计满 iterations 次（warmup 先行；--concurrency 个 worker 瓜分该 op 的迭代）。 */
async function measureOps({ ops, execOp, opts, concurrency, asyncEngine, samples, iBase }) {
  const call = (op, i) => {
    const t0 = performance.now()
    const r = execOp(op, i)
    if (r && typeof r.then === 'function') {
      return r.then(() => { samples.get(op.id).push(performance.now() - t0) })
    }
    samples.get(op.id).push(performance.now() - t0)
    return Promise.resolve()
  }
  for (const op of ops) {
    // 预热（不计数）：缓存/计划/连接成本先行消化
    for (let w = 0; w < opts.warmup; w++) await call(op, iBase + w)
    const mBase = iBase + opts.warmup
    const perWorker = Math.ceil(opts.iterations / concurrency)
    await Promise.all(Array.from({ length: concurrency }, (_, wk) => (async () => {
      for (let k = 0; k < perWorker; k++) {
        const gi = wk * perWorker + k
        if (gi >= opts.iterations) break
        await call(op, mBase + gi)
      }
    })()))
  }
  if (!asyncEngine) await new Promise((r) => setImmediate(r))
  return samples
}

function printTable(engine, ops, samples) {
  console.log(`\n[${engine}] op 延迟（单位 ms，nearest-rank p99 口径）`)
  console.log('  op'.padEnd(34) + 'class  samples      p50      p95      p99      max')
  console.log('  ' + '-'.repeat(78))
  for (const op of ops) {
    const s = samples.get(op.id)
    if (s.length === 0) { console.log(`  ${op.id.padEnd(32)} ${op.class}  (skipped)`); continue }
    const st = latencyStats(s)
    console.log(
      `  ${op.id.padEnd(32)} ${op.class.padEnd(5)} ${String(st.n).padStart(5)}   ` +
      `${st.p50Ms.toFixed(2).padStart(7)} ${st.p95Ms.toFixed(2).padStart(7)} ` +
      `${st.p99Ms.toFixed(2).padStart(7)} ${st.maxMs.toFixed(2).padStart(7)}`,
    )
  }
}

async function benchSqlite(opts) {
  log('sqlite：建临时 scratch 库 + 重放 schema.sql（不碰 ~/.octopus 真库）')
  const scratch = createSqliteScratch('bench')
  const dataset = buildSeedDataset(opts.scale, opts.seed)
  try {
    const t0 = Date.now()
    seedSqlite(scratch.db, dataset)
    log(`sqlite：种子装载 ${Date.now() - t0}ms（executions ${dataset.shape.executions}）`)
    warmSweepSqlite(scratch.db)
    const ctx = makeLoadCtx(dataset, 'sq', opts)
    const { execOp } = runSqliteOps({ db: scratch.db, dataset, opts, ctx })
    const samples = new Map(OPS.map((op) => [op.id, []]))
    const stride = opts.warmup + opts.iterations
    for (let r = 0; r < opts.repeat; r++) {
      await measureOps({ ops: OPS, execOp, opts, concurrency: 1, asyncEngine: false, samples, iBase: r * stride })
    }
    printTable('sqlite', OPS, samples)
    return { result: packResult(opts, 'sqlite', { scratchDb: scratch.file }, dataset, samples), cleanup: () => scratch.close() }
  } catch (err) {
    scratch.close()
    die(`sqlite 基准失败 :: ${err instanceof Error ? err.stack : err}`)
  }
}

async function benchPg(opts) {
  log('pg：CREATE DATABASE octopus_perf_<rand>（TEMPLATE octopus_template + schema 幂等重放）')
  const dbh = await createPerfDatabase({ poolMax: opts.poolMax })
  const dataset = buildSeedDataset(opts.scale, opts.seed)
  try {
    log(`pg：随机库 ${dbh.name}（连接串 ${dbh.url.replace(/\/\/[^@/]+@/, '//***@')}）`)
    const t0 = Date.now()
    await seedPg(dbh.sql, dataset)
    log(`pg：种子装载 ${Date.now() - t0}ms（executions ${dataset.shape.executions}）`)
    await warmSweepPg(dbh.sql)
    const ctx = makeLoadCtx(dataset, 'pg', opts)
    const { execOp } = runPgOps({ sql: dbh.sql, dataset, opts, ctx })
    const samples = new Map(OPS.map((op) => [op.id, []]))
    const stride = opts.warmup + opts.iterations
    for (let r = 0; r < opts.repeat; r++) {
      log(`pg：第 ${r + 1}/${opts.repeat} 轮计次`)
      await measureOps({ ops: OPS, execOp, opts, concurrency: opts.concurrency, asyncEngine: true, samples, iBase: r * stride })
    }
    printTable('pg', OPS, samples)
    await dbh.close()
    return { result: packResult(opts, 'pg', { randomDbName: dbh.name, poolMax: opts.poolMax, concurrency: opts.concurrency }, dataset, samples), cleanup: async () => { /* 已 close */ } }
  } catch (err) {
    await dbh.close().catch(() => {})
    die(`pg 基准失败 :: ${err instanceof Error ? err.stack : err}`)
  }
}

function packResult(opts, engine, engineMeta, dataset, samples) {
  return {
    format: 'octopus-pg-perf/v1',
    kind: 'bench',
    generatedAt: new Date().toISOString(),
    gitRev: gitRev(),
    nodeVersion: process.version,
    label: opts.label,
    engine,
    engineMeta,
    seed: { seed: opts.seed, scale: opts.scale, shape: datasetShape(opts.scale) },
    settings: { iterations: opts.iterations, warmup: opts.warmup, concurrency: opts.concurrency, repeat: opts.repeat },
    percentileRank: 'nearest-rank(ceil)',
    ops: OPS.map((op) => {
      const s = samples.get(op.id) ?? []
      return {
        id: op.id, class: op.class, dao: op.dao,
        note: NOISY_WRITE_NOTE[op.id],
        samples: s.length, stats: s.length ? latencyStats(s) : null,
      }
    }),
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const results = []
  if (opts.engine === 'both' || opts.engine === 'sqlite') {
    const r = await benchSqlite(opts)
    results.push(r.result)
    r.cleanup()
  }
  if (opts.engine === 'both' || opts.engine === 'pg') {
    if (opts.engine === 'both') log('提示：both 模式下 sqlite 结果即「旧路径基线」，pg 结果为「迁移后现值」')
    const r = await benchPg(opts)
    results.push(r.result)
  }
  const stamp = utcStamp()
  for (const res of results) {
    const file = path.join(opts.outDir, `bench-${res.engine}-${stamp}${opts.label ? '-' + opts.label.replace(/[^\w.-]+/g, '_') : ''}.json`)
    writeJson(file, res)
  }
  if (results.length === 2) {
    console.log('\n[pg-perf] 直读对比（同一次运行 sqlite→pg；正式判据请用 compare.mjs 锁基线文件）:')
    const byId = new Map(results[0].ops.map((o) => [o.id, o]))
    console.log('  op'.padEnd(34) + 'sqlite p99    pg p99     Δ')
    for (const op of results[1].ops) {
      const b = byId.get(op.id)
      if (!b?.stats || !op.stats) continue
      const d = ((op.stats.p99Ms - b.stats.p99Ms) / b.stats.p99Ms) * 100
      console.log(`  ${op.id.padEnd(32)} ${fmtMs(b.stats.p99Ms).padStart(10)} ${fmtMs(op.stats.p99Ms).padStart(10)} ${(d >= 0 ? '+' : '') + d.toFixed(1)}%`)
    }
  }
  console.log('\n[pg-perf] ✓ 完成 —— B5/B6 总验用 compare.mjs 对基线判 p99 是否劣化')
}

main().catch((err) => die(err instanceof Error ? err.stack : String(err)))
